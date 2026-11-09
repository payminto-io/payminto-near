import { spawn, type ChildProcess } from "node:child_process";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createPublicClient,
  createWalletClient,
  http,
  keccak256,
  maxUint256,
  toBytes,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  clearingHubAbi,
  clearingHubBytecode,
  mockStablecoinAbi,
  mockStablecoinBytecode,
  localAnvil,
  mandateId,
  mandateTypedData,
  voucherDigest,
  voucherTypedData,
  isVoucherSignedBy,
  payeesRoot,
  payeeProof,
  receiptsTree,
  receiptLeaf,
  receiptProof,
  verifyReceiptProof,
  policyHash,
  canonicalPolicy,
  MANDATE_TYPEHASH_PREIMAGE,
  hspTypes,
  hspVerify,
  buildNetTransferMandate,
  hspTypedData,
  hspPaymentId,
  isHspMandateSignedBy,
  requiredCapabilitiesHash,
  ZERO_BYTES32,
  formatAmount,
  encodeHeader,
  decodeHeader,
  type Mandate,
  type CallReceipt,
} from "../src/index.ts";

// Anvil default dev keys (public, local only).
const DEPLOYER = privateKeyToAccount("0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80");
const OWNER = privateKeyToAccount("0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d");
const AGENT = privateKeyToAccount("0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a");
const PROVIDER_A = "0x90F79bf6EB2c4f870365E785982E1f101E93b906" as Address;
const PROVIDER_B = "0x15d34AAf54267DB7D7c367839AAf71A00a2C6A65" as Address;
const PORT = 18545 + Math.floor(Math.random() * 1000);

let anvil: ChildProcess;
const transport = http(`http://127.0.0.1:${PORT}`);
const chain = { ...localAnvil, rpcUrls: { default: { http: [`http://127.0.0.1:${PORT}`] } } };
const pub = createPublicClient({ chain, transport });
const deployer = createWalletClient({ account: DEPLOYER, chain, transport });
let hub: Address;
let token: Address;

async function waitForRpc() {
  for (let i = 0; i < 100; i++) {
    try {
      await pub.getChainId();
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  throw new Error("anvil did not start");
}

async function deploy(abi: any, bytecode: Hex): Promise<Address> {
  const hash = await deployer.deployContract({ abi, bytecode });
  const rcpt = await pub.waitForTransactionReceipt({ hash });
  return rcpt.contractAddress!;
}

beforeAll(async () => {
  anvil = spawn("anvil", ["--port", String(PORT), "--silent"], { stdio: "ignore" });
  await waitForRpc();
  hub = await deploy(clearingHubAbi, clearingHubBytecode);
  token = await deploy(mockStablecoinAbi, mockStablecoinBytecode);
}, 30_000);

afterAll(() => {
  anvil?.kill();
});

async function sampleMandate(payees: Address[]): Promise<Mandate> {
  const now = BigInt((await pub.getBlock()).timestamp);
  return {
    owner: OWNER.address,
    agent: AGENT.address,
    token,
    totalCap: 50_000_000n,
    validAfter: now - 10n,
    validUntil: now + 86_400n,
    payeesRoot: payeesRoot(payees),
    policyHash: policyHash({ perCallCap: "50000", dailyCap: "20000000", maxCallsPerMinute: 600, purpose: "test" }),
    salt: keccak256(toBytes("salt-1")),
  };
}

describe("ClearingHub parity", () => {
  it("TypeScript mandate id equals the on-chain digest", async () => {
    const m = await sampleMandate([PROVIDER_A, PROVIDER_B]);
    const onchain = await pub.readContract({ address: hub, abi: clearingHubAbi, functionName: "mandateDigest", args: [m] });
    expect(mandateId(localAnvil.id, hub, m)).toBe(onchain);
  });

  it("TypeScript voucher digest equals the on-chain digest", async () => {
    const v = { mandateId: keccak256(toBytes("m")), payee: PROVIDER_A, cumulative: 12_345n };
    const onchain = await pub.readContract({ address: hub, abi: clearingHubAbi, functionName: "voucherDigest", args: [v] });
    expect(voucherDigest(localAnvil.id, hub, v)).toBe(onchain);
  });

  it("opens a mandate and settles vouchers with an allowlist proof and a receipts root", async () => {
    const payees = [PROVIDER_A, PROVIDER_B];
    const m = await sampleMandate(payees);
    const ownerSig = await OWNER.signTypedData(mandateTypedData(localAnvil.id, hub, m));
    const id = mandateId(localAnvil.id, hub, m);

    const ownerWallet = createWalletClient({ account: OWNER, chain, transport });
    await pub.waitForTransactionReceipt({
      hash: await ownerWallet.writeContract({ address: hub, abi: clearingHubAbi, functionName: "openMandate", args: [m, ownerSig] }),
    });

    const agentWallet = createWalletClient({ account: AGENT, chain, transport });
    await pub.waitForTransactionReceipt({
      hash: await deployer.writeContract({ address: token, abi: mockStablecoinAbi, functionName: "mint", args: [AGENT.address, 100_000_000n] }),
    });
    await pub.waitForTransactionReceipt({
      hash: await agentWallet.writeContract({ address: token, abi: mockStablecoinAbi, functionName: "approve", args: [hub, maxUint256] }),
    });

    const voucher = { mandateId: id, payee: PROVIDER_A, cumulative: 30_000n };
    const agentSig = await AGENT.signTypedData(voucherTypedData(localAnvil.id, hub, voucher));
    expect(await isVoucherSignedBy(localAnvil.id, hub, voucher, agentSig, AGENT.address)).toBe(true);

    const receipts: CallReceipt[] = [10_000n, 20_000n, 30_000n].map((cumulative, i) => ({
      callId: keccak256(toBytes(`call-${i}`)),
      mandateId: id,
      payee: PROVIDER_A,
      amount: 10_000n,
      cumulative,
      requestHash: keccak256(toBytes(`GET /quote ${i}`)),
      timestamp: 1_800_000_000n + BigInt(i),
    }));
    const tree = receiptsTree(receipts);
    const batchId = keccak256(toBytes("batch-1"));

    const claims = [{ voucher, agentSig, payeeProof: payeeProof(payees, PROVIDER_A) }];
    await pub.waitForTransactionReceipt({
      hash: await deployer.writeContract({
        address: hub,
        abi: clearingHubAbi,
        functionName: "settleBatch",
        args: [batchId, tree.root as Hex, token, claims],
      }),
    });

    const bal = await pub.readContract({ address: token, abi: mockStablecoinAbi, functionName: "balanceOf", args: [PROVIDER_A] });
    expect(bal).toBe(30_000n);

    const r1 = receipts[1]!;
    const proof = receiptProof(tree, r1);
    expect(verifyReceiptProof(tree.root as Hex, r1, proof)).toBe(true);
    const onchainOk = await pub.readContract({
      address: hub,
      abi: clearingHubAbi,
      functionName: "verifyReceipt",
      args: [batchId, receiptLeaf(r1), proof],
    });
    expect(onchainOk).toBe(true);
  });
});

describe("policy", () => {
  it("hashes a canonical, key-ordered encoding", () => {
    const a = { purpose: "x", perCallCap: "1", maxCallsPerMinute: 2, dailyCap: "3" };
    const b = { dailyCap: "3", maxCallsPerMinute: 2, perCallCap: "1", purpose: "x" };
    expect(canonicalPolicy(a)).toBe(canonicalPolicy(b));
    expect(policyHash(a)).toBe(policyHash(b));
  });
});

describe("HSP wire v1", () => {
  it("derives exactly the published MANDATE_TYPEHASH preimage from the typed-data definition", () => {
    // EIP-712 encodeType: primary type first, then referenced structs sorted by name.
    const fmt = (name: keyof typeof hspTypes) =>
      `${name}(${hspTypes[name].map((f) => `${f.type} ${f.name}`).join(",")})`;
    expect(fmt("Mandate") + fmt("Recipient") + fmt("Signer")).toBe(MANDATE_TYPEHASH_PREIMAGE);
  });

  it("signs and verifies a net-transfer mandate bound to a batch", async () => {
    const body = buildNetTransferMandate({
      payer: AGENT.address,
      recipient: PROVIDER_A,
      token: "0x8FE3cB719Ee4410E236Cd6b72ab1fCDC06eF53c6",
      amount: 30_000n,
      chainId: 133,
      batchId: keccak256(toBytes("batch-1")),
      deadline: 1_900_000_000n,
    });
    expect(body.settlementBinding).toBe(keccak256(toBytes("batch-1")));
    const vc = "0x1111111111111111111111111111111111111111" as Address;
    const sig = await AGENT.signTypedData(hspTypedData(133, vc, body));
    expect(await isHspMandateSignedBy(133, vc, body, sig, AGENT.address)).toBe(true);
    expect(await isHspMandateSignedBy(133, vc, body, sig, OWNER.address)).toBe(false);
    expect(hspPaymentId(133, vc, body)).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it("hashes capability sets order- and case-insensitively, empty set to zero", () => {
    expect(requiredCapabilitiesHash([])).toBe(ZERO_BYTES32);
    expect(requiredCapabilitiesHash(["B:x:v1", "a:y:v1"])).toBe(requiredCapabilitiesHash(["a:y:v1", "b:x:v1", "b:x:v1"]));
  });

  it("accepts iff required capabilities are a subset of satisfied ones", () => {
    expect(hspVerify(["proves:a"], ["proves:a", "proves:b"])).toBe("ACCEPT");
    expect(hspVerify(["proves:a", "attests:kyc"], ["proves:a"])).toBe("REJECT");
    expect(hspVerify([], [])).toBe("ACCEPT");
  });
});

describe("helpers", () => {
  it("formats atomic amounts", () => {
    expect(formatAmount(1_500_000n)).toBe("1.50");
    expect(formatAmount(10_000n)).toBe("0.01");
    expect(formatAmount(1_234n)).toBe("0.001234");
  });

  it("round-trips x402 headers", () => {
    expect(decodeHeader(encodeHeader({ a: 1 }))).toEqual({ a: 1 });
    expect(decodeHeader("not-base64-json")).toBeNull();
  });
});
