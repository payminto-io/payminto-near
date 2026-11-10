import { secp256k1 } from "@noble/curves/secp256k1.js";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { encodeFunctionData, getAddress, keccak256, parseTransaction, recoverTransactionAddress, serializeTransaction, type Hex } from "viem";
import { publicKeyToAddress } from "viem/accounts";
import { describe, expect, it } from "vitest";
import {
  addressOfUncompressed,
  assembleEvmPayout,
  checksumAddress,
  deriveSecp256k1Key,
  deriveTweak,
  eip1559SigningHash,
  erc20TransferData,
  evmPayoutRequest,
  formatSecp256k1Key,
  MPC_SIGNER,
  parseMpcSignature,
  readDerivedKey,
  rlp,
  signRequestTx,
  unsignedEip1559,
  verifyMpcSignature,
  type Eip1559Tx,
  type MpcSignature,
} from "../src/chainsig/index.ts";
import { ViewRpc } from "../src/rpc.ts";
import { fakeFetch, fixture, rpcView } from "./helpers.ts";

type ViewRec = { contract: string; method: string; args: { path?: string; predecessor?: string }; result: string };
const live = fixture<{ views: ViewRec[] }>("chainsig/mpc-keys.live.json").views;
const snapshot = fixture<{ account_ids: string[]; paths: string[]; tweaks: number[][] }>("chainsig/near-mpc-tweak-snapshot.json");
const liveDerived = (contract: string, predecessor: string, path: string) =>
  live.find((v) => v.contract === contract && v.method === "derived_public_key" && v.args.predecessor === predecessor && v.args.path === path)!.result;

const N = secp256k1.Point.Fn.ORDER;
const BASE_SEPOLIA_USDC = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
const MERCHANT_EVM = "0x2527D02599Ba641c19FEa793cD0F167589a0f10D";

describe("key derivation against near/mpc and the live contracts", () => {
  it("reproduces all 16 tweaks of near/mpc's derive_tweak snapshot", () => {
    let i = 0;
    for (const a of snapshot.account_ids) for (const p of snapshot.paths) expect([...deriveTweak(a, p)]).toEqual(snapshot.tweaks[i++]);
  });

  it("the root keys in MPC_SIGNER are the ones the contracts return", () => {
    expect(live.find((v) => v.contract === "v1.signer-prod.testnet" && v.method === "public_key")!.result).toBe(MPC_SIGNER.testnet.rootKey);
    expect(live.find((v) => v.contract === "v1.signer" && v.method === "public_key")!.result).toBe(MPC_SIGNER.mainnet.rootKey);
  });

  it("derives exactly what derived_public_key returned live, on testnet and mainnet", () => {
    for (const [net, predecessor, path] of [
      ["testnet", "alice.testnet", "ethereum-1"],
      ["testnet", "merchant.payminto.testnet", "payminto-payout-1"],
      ["mainnet", "alice.near", "ethereum-1"],
    ] as const) {
      const signer = MPC_SIGNER[net];
      expect(deriveSecp256k1Key(signer.rootKey, predecessor, path).key).toBe(liveDerived(signer.contract, predecessor, path));
    }
  });

  it("computes the EVM address as viem does from the same key", () => {
    const d = deriveSecp256k1Key(MPC_SIGNER.testnet.rootKey, "alice.testnet", "ethereum-1");
    expect(d.evmAddress).toBe(publicKeyToAddress(`0x${bytesToHex(d.uncompressed)}`));
    expect(d.evmAddress).toBe("0xfe306917CD4Ee89a2AE69514f167222aCe0eAa7D");
    expect(checksumAddress(MERCHANT_EVM.toLowerCase())).toBe(getAddress(MERCHANT_EVM));
  });

  it("reads derived_public_key read-only", async () => {
    const value = liveDerived("v1.signer-prod.testnet", "alice.testnet", "ethereum-1");
    const { fetch, calls } = fakeFetch([{ method: "POST", url: "https://rpc.testnet.near.org", rpc: "derived_public_key", status: 200, body: rpcView(value) }]);
    expect(await readDerivedKey(new ViewRpc("https://rpc.testnet.near.org", fetch), "v1.signer-prod.testnet", "alice.testnet", "ethereum-1")).toBe(value);
    expect(JSON.parse(Buffer.from((calls[0]!.body as { params: { args_base64: string } }).params.args_base64, "base64").toString())).toEqual({
      path: "ethereum-1",
      predecessor: "alice.testnet",
      domain_id: 0,
    });
  });
});

describe("the sign request", () => {
  it("matches the near/mpc README shape: payload_v2.Ecdsa hex, path, domain_id, 1 yoctoNEAR", () => {
    const payload = hexToBytes("521da91dc9bddb625bd0679d9e735def558761a34653624f5954f44bce6443a9");
    expect(signRequestTx("v1.signer-prod.testnet", payload, "sepolia-1")).toEqual({
      receiverId: "v1.signer-prod.testnet",
      actions: [
        {
          type: "FunctionCall",
          params: {
            methodName: "sign",
            args: { request: { payload_v2: { Ecdsa: "521da91dc9bddb625bd0679d9e735def558761a34653624f5954f44bce6443a9" }, path: "sepolia-1", domain_id: 0 } },
            gas: "300000000000000",
            deposit: "1",
          },
        },
      ],
    });
  });

  it("refuses payloads the contract would reject", () => {
    expect(() => signRequestTx("v1.signer", new Uint8Array(31), "p")).toThrow(/32 bytes/);
    expect(() => signRequestTx("v1.signer", hexToBytes(N.toString(16)), "p")).toThrow(/order/);
    expect(() => signRequestTx("v1.signer", new Uint8Array(32), "")).toThrow(/path/);
  });
});

describe("EVM encoding against viem", () => {
  const tx: Eip1559Tx = {
    chainId: 84532n,
    nonce: 7n,
    maxPriorityFeePerGas: 1_000_000n,
    maxFeePerGas: 2_000_000_000n,
    gasLimit: 100_000n,
    to: BASE_SEPOLIA_USDC,
    value: 0n,
    data: erc20TransferData(MERCHANT_EVM, 2_500_000n),
  };
  const viemTx = {
    type: "eip1559" as const,
    chainId: 84532,
    nonce: 7,
    maxPriorityFeePerGas: 1_000_000n,
    maxFeePerGas: 2_000_000_000n,
    gas: 100_000n,
    to: BASE_SEPOLIA_USDC as Hex,
    value: 0n,
    data: `0x${bytesToHex(tx.data)}` as Hex,
  };

  it("ERC-20 transfer calldata equals viem's encodeFunctionData", () => {
    const abi = [{ type: "function", name: "transfer", stateMutability: "nonpayable", inputs: [{ name: "to", type: "address" }, { name: "amount", type: "uint256" }], outputs: [{ type: "bool" }] }] as const;
    expect(`0x${bytesToHex(tx.data)}`).toBe(encodeFunctionData({ abi, functionName: "transfer", args: [MERCHANT_EVM, 2_500_000n] }));
  });

  it("the unsigned EIP-1559 bytes and signing hash equal viem's", () => {
    const theirs = serializeTransaction(viemTx);
    expect(`0x${bytesToHex(unsignedEip1559(tx))}`).toBe(theirs);
    expect(`0x${bytesToHex(eip1559SigningHash(tx))}`).toBe(keccak256(theirs));
  });

  it("RLP follows the spec examples", () => {
    expect(bytesToHex(rlp(new TextEncoder().encode("dog")))).toBe("83646f67");
    expect(bytesToHex(rlp([new TextEncoder().encode("cat"), new TextEncoder().encode("dog")]))).toBe("c88363617483646f67");
    expect(bytesToHex(rlp(new Uint8Array()))).toBe("80");
    expect(bytesToHex(rlp([]))).toBe("c0");
    expect(bytesToHex(rlp(Uint8Array.of(0x0f)))).toBe("0f");
    expect(bytesToHex(rlp(new Uint8Array(56).fill(0x61))).slice(0, 4)).toBe("b838");
  });
});

/**
 * SIMULATED MPC: a local root secret stands in for the MPC network, so the whole payout path runs offline. The derived
 * secret is root + tweak, which is what the network's key shares sum to for this predecessor and path.
 */
describe("an MPC-signed USDC payout, end to end with a simulated signer", () => {
  const rootSecret = 0x1234567890abcdefn;
  const rootKey = formatSecp256k1Key(secp256k1.Point.BASE.multiply(rootSecret));
  const mpcSign = (payload: Uint8Array, predecessor: string, path: string): MpcSignature => {
    const tweak = BigInt(`0x${bytesToHex(deriveTweak(predecessor, path))}`);
    const sk = hexToBytes(((rootSecret + tweak) % N).toString(16).padStart(64, "0"));
    const sig = secp256k1.Signature.fromBytes(secp256k1.sign(payload, sk, { prehash: false, format: "recovered" }), "recovered");
    // big_r is the nonce point R in compressed form: its x is r and its y parity is the recovery id.
    const prefix = sig.recovery === 1 ? "03" : "02";
    return { scheme: "Secp256k1", big_r: { affine_point: prefix + sig.r.toString(16).padStart(64, "0") }, s: { scalar: sig.s.toString(16).padStart(64, "0") }, recovery_id: sig.recovery! };
  };
  const payout = {
    nearAccount: "merchant.payminto.testnet",
    path: "payminto-payout-1",
    rootKey,
    chainId: 84532n,
    token: BASE_SEPOLIA_USDC,
    to: MERCHANT_EVM,
    amount: 2_500_000n,
    nonce: 0n,
    maxPriorityFeePerGas: 1_000_000n,
    maxFeePerGas: 2_000_000_000n,
  };

  it("builds the sign call for the transaction hash, and the assembled transaction recovers to the derived address", async () => {
    const req = evmPayoutRequest(payout, "v1.signer-prod.testnet");
    expect(req.signTx.actions[0]!.params.args).toEqual({ request: { payload_v2: { Ecdsa: bytesToHex(req.payload) }, path: "payminto-payout-1", domain_id: 0 } });
    const sig = mpcSign(req.payload, payout.nearAccount, payout.path);
    expect(verifyMpcSignature(sig, req.payload, req.derivedKey)).toBe(true);
    const raw = `0x${bytesToHex(assembleEvmPayout(req, sig))}` as Hex;
    expect(await recoverTransactionAddress({ serializedTransaction: raw as never })).toBe(req.from);
    const parsed = parseTransaction(raw);
    expect(parsed).toMatchObject({ chainId: 84532, nonce: 0, data: `0x${bytesToHex(req.tx.data)}` });
    expect(parsed.to?.toLowerCase()).toBe(BASE_SEPOLIA_USDC.toLowerCase());
    expect(parsed.value ?? 0n).toBe(0n);
  });

  it("refuses a signature from another path or account", () => {
    const req = evmPayoutRequest(payout, "v1.signer-prod.testnet");
    expect(() => assembleEvmPayout(req, mpcSign(req.payload, payout.nearAccount, "other-path"))).toThrow(/does not recover/);
    expect(() => assembleEvmPayout(req, mpcSign(req.payload, "attacker.testnet", payout.path))).toThrow(/does not recover/);
  });

  it("parses the response shape and rejects high s, bad points and bad recovery ids", () => {
    const req = evmPayoutRequest(payout, "v1.signer-prod.testnet");
    const sig = mpcSign(req.payload, payout.nearAccount, payout.path);
    expect(parseMpcSignature(sig).yParity).toBe(sig.recovery_id);
    const { scheme: _scheme, ...legacy } = sig;
    expect(verifyMpcSignature(legacy, req.payload, req.derivedKey)).toBe(true);
    const highS = { ...sig, s: { scalar: (N - BigInt(`0x${sig.s.scalar}`)).toString(16).padStart(64, "0") } };
    expect(() => parseMpcSignature(highS)).toThrow(/low/);
    expect(() => parseMpcSignature({ ...sig, big_r: { affine_point: `04${sig.big_r.affine_point.slice(2)}` } })).toThrow(/compressed/);
    expect(() => parseMpcSignature({ ...sig, recovery_id: 2 })).toThrow(/recovery_id/);
  });

  it("derives the merchant's payout address from the live testnet root", () => {
    const d = deriveSecp256k1Key(MPC_SIGNER.testnet.rootKey, "merchant.payminto.testnet", "payminto-payout-1");
    expect(d.key).toBe(liveDerived("v1.signer-prod.testnet", "merchant.payminto.testnet", "payminto-payout-1"));
    expect(d.evmAddress).toBe(addressOfUncompressed(d.uncompressed));
  });
});
