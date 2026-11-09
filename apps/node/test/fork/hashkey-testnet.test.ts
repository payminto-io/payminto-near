/**
 * HashKey Chain testnet fork suite (opt-in: `pnpm test:fork`, which sets FORK=1).
 *
 * Starts `anvil --fork-url https://testnet.hsk.xyz` (override with FORK_RPC_URL) and, against real testnet state:
 * - deploys ClearingHub through the Arachnid CREATE2 deployer with the production salt and checks the address;
 * - funds agents with the REAL testnet USDC (FiatToken v2, 0x8FE3...53c6) by impersonating its master minter;
 * - opens a mandate with a real EIP-2612 permit against that USDC, so the agent holds no HSK and sends nothing;
 * - opens a second mandate owned by a real Safe 1.4.1 made through the on-chain SafeProxyFactory (ERC-1271 owner);
 * - pays a few calls through the SDK paywall and AgentClient, settles through the node with blacklist screening
 *   (Multicall3 against the real FiatToken), the L1 fee preflight against the real GasPriceOracle, finality at the
 *   safe head, an EAS attestation on the predeploy, and an HSP receipt that includes the attestation capability.
 *
 * Nothing is sent to a public network: every transaction goes to the local fork, the node runs with no RPC
 * fallbacks, and all keys are generated per run.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serve } from "@hono/node-server";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { Hono } from "hono";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  concat,
  encodeAbiParameters,
  encodeFunctionData,
  erc20Abi,
  getContractAddress,
  keccak256,
  parseAbi,
  toBytes,
  toHex,
  zeroAddress,
  type Address,
  type Hex,
} from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import {
  clearingHubBytecode,
  fiatTokenBlacklistAbi,
  hashkeyContracts,
  hashkeyTestnet,
  mandateId as computeMandateId,
  mandateToJson,
  mandateTypedData,
  networks,
  payeesRoot,
  policyHash,
  type Mandate,
  type Policy,
} from "@payminto/protocol";
import { AgentClient, OwnerClient, paywall } from "@payminto/sdk";
import { loadConfig } from "../../src/config.ts";
import { schemaUid } from "../../src/eas.ts";
import { silentLogger } from "../../src/logger.ts";
import { startNode, type ClearingNode } from "../../src/server.ts";
import { ANVIL_KEYS, startAnvil, type Anvil } from "../helpers.ts";

const FORK = process.env.FORK === "1";
const FORK_RPC_URL = process.env.FORK_RPC_URL ?? "https://testnet.hsk.xyz";
const USDC = networks[133]!.token.address; // 0x8FE3cB719Ee4410E236Cd6b72ab1fCDC06eF53c6
const C = hashkeyContracts[133];
/** The salt contracts/script/Deploy.s.sol uses: one hub address per bytecode on every chain. */
const SALT = keccak256(toBytes("payminto.clearing.v1"));
const UNIT = 1_000_000n;

const fiatTokenAdminAbi = parseAbi([
  "function masterMinter() view returns (address)",
  "function configureMinter(address minter, uint256 minterAllowedAmount) returns (bool)",
  "function mint(address to, uint256 amount) returns (bool)",
  "function nonces(address owner) view returns (uint256)",
]);
const safeAbi = parseAbi([
  "function setup(address[] owners, uint256 threshold, address to, bytes data, address fallbackHandler, address paymentToken, uint256 payment, address paymentReceiver)",
  "function getOwners() view returns (address[])",
  "function VERSION() view returns (string)",
  "function isValidSignature(bytes32 hash, bytes signature) view returns (bytes4)",
]);
const proxyFactoryAbi = parseAbi(["function createProxyWithNonce(address singleton, bytes initializer, uint256 saltNonce) returns (address proxy)"]);

describe.skipIf(!FORK)("HashKey Chain testnet fork", () => {
  let anvil: Anvil;
  let node: ClearingNode;
  let hub: Address;
  let forkBlock: bigint;
  const servers: Server[] = [];
  const dir = mkdtempSync(join(tmpdir(), "payminto-fork-"));
  const deployer = ANVIL_KEYS[0];
  const operatorKey = generatePrivateKey();
  const owner = privateKeyToAccount(generatePrivateKey());
  const safeSigner = privateKeyToAccount(generatePrivateKey());
  const agentA = privateKeyToAccount(generatePrivateKey());
  const agentB = privateKeyToAccount(generatePrivateKey());
  const payee = privateKeyToAccount(generatePrivateKey()).address;
  const adminToken = toHex(crypto.getRandomValues(new Uint8Array(32))).slice(2);
  let safe: Address;

  const rpc = <T = unknown>(method: string, params: unknown[] = []) =>
    (anvil.pub.request as (a: { method: string; params: unknown[] }) => Promise<unknown>)({ method, params }) as Promise<T>;
  const send = async (from: Hex, to: Address, data: Hex) => {
    const r = await anvil.pub.waitForTransactionReceipt({ hash: await anvil.wallet(from).sendTransaction({ to, data }) });
    expect(r.status).toBe("success");
    return r;
  };
  /** Sends as any address on the fork (impersonation), with gas money. */
  const sendAs = async (from: Address, to: Address, data: Hex) => {
    await rpc("anvil_setBalance", [from, toHex(10n ** 18n)]);
    await rpc("anvil_impersonateAccount", [from]);
    const hash = await rpc<Hex>("eth_sendTransaction", [{ from, to, data }]);
    await rpc("anvil_stopImpersonatingAccount", [from]);
    const r = await anvil.pub.waitForTransactionReceipt({ hash });
    expect(r.status).toBe("success");
  };
  const admin = async <T = any>(method: "GET" | "POST", path: string, body?: unknown): Promise<{ status: number; json: T }> => {
    const res = await fetch(`${node.url}${path}`, {
      method,
      headers: { "content-type": "application/json", authorization: `Bearer ${adminToken}` },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, json: (await res.json()) as T };
  };

  beforeAll(async () => {
    anvil = await startAnvil({ args: ["--fork-url", FORK_RPC_URL], chain: hashkeyTestnet, startupMs: 60_000 });
    expect(await anvil.pub.getChainId()).toBe(133);
    forkBlock = await anvil.pub.getBlockNumber();
  });

  afterAll(async () => {
    await node?.stop();
    for (const s of servers) s.close();
    anvil?.stop();
    rmSync(dir, { recursive: true, force: true });
  });

  it("deploys ClearingHub through the CREATE2 deployer at the deterministic address", async () => {
    const expected = getContractAddress({ opcode: "CREATE2", from: C.create2Deployer, salt: SALT, bytecode: clearingHubBytecode });
    if (!(await anvil.pub.getCode({ address: expected }))) await send(deployer, C.create2Deployer, concat([SALT, clearingHubBytecode]));
    expect(await anvil.pub.getCode({ address: expected })).toBeTruthy();
    hub = expected;
  });

  it("starts the node on chain 133 with real USDC, safe-head finality and EAS attestations", async () => {
    await rpc("anvil_setBalance", [privateKeyToAccount(operatorKey).address, toHex(100n * 10n ** 18n)]);
    const config = loadConfig({
      CHAIN_ID: "133",
      RPC_URL: anvil.rpcUrl,
      RPC_FALLBACK_URLS: "none", // never fall back to the public testnet
      HUB_ADDRESS: hub,
      TOKEN_ADDRESS: USDC,
      DEPLOY_BLOCK: String(forkBlock),
      OPERATOR_KEY: operatorKey,
      ADMIN_TOKEN: adminToken,
      DB_PATH: join(dir, "clearing.fork.test.db"),
      HSP_COSIGN_TIMEOUT_SEC: "15",
      EAS_ATTEST: "true",
      DEPLOYMENTS_DIR: join(dir, "deployments"),
    });
    expect(config.confirmTag).toBe("safe");
    node = await startNode(config, { logger: silentLogger, port: 0, workers: false });
    const info = (await admin("GET", "/v1/info")).json;
    expect(info.settlement).toMatchObject({ confirmTag: "safe", easAttest: true });
    expect(info.token).toMatchObject({ address: USDC, decimals: 6 });
    // The real GasPriceOracle prices the L1 data fee into the operator preflight.
    const fee = await node.services.chain.estimateFee({ to: USDC, data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [hub, 1n] }) });
    expect(fee.l1Fee).toBeGreaterThan(0n);
    expect(await node.services.chain.supportsBlacklist()).toBe(true);
  });

  it("funds agents with real testnet USDC through the FiatToken master minter", async () => {
    const masterMinter = await anvil.pub.readContract({ address: USDC, abi: fiatTokenAdminAbi, functionName: "masterMinter" });
    const minter = privateKeyToAccount(deployer).address;
    await sendAs(masterMinter, USDC, encodeFunctionData({ abi: fiatTokenAdminAbi, functionName: "configureMinter", args: [minter, 1_000n * UNIT] }));
    for (const a of [agentA.address, agentB.address]) {
      await send(deployer, USDC, encodeFunctionData({ abi: fiatTokenAdminAbi, functionName: "mint", args: [a, 100n * UNIT] }));
      expect(await anvil.pub.readContract({ address: USDC, abi: erc20Abi, functionName: "balanceOf", args: [a] })).toBe(100n * UNIT);
      expect(await anvil.pub.getBalance({ address: a })).toBe(0n);
    }
    expect(await anvil.pub.readContract({ address: USDC, abi: fiatTokenBlacklistAbi, functionName: "isBlacklisted", args: [agentA.address] })).toBe(false);
  });

  const policy: Policy = { perCallCap: "50000", dailyCap: (50n * UNIT).toString(), maxCallsPerMinute: 0, purpose: "fork test" };
  let mandateA: Hex;
  let mandateB: Hex;

  it("opens a mandate with a real EIP-2612 permit: the agent sends zero transactions and holds zero HSK", async () => {
    const ownerClient = new OwnerClient({ nodeUrl: node.url, chainId: 133, hub, account: owner, publicClient: anvil.pub, adminToken });
    const m = await ownerClient.createMandate({ agent: agentA.address, token: USDC, totalCap: 50n * UNIT, validForSeconds: 86_400, payees: [payee], policy });
    const agent = new AgentClient({ chainId: 133, hub, account: agentA, mandateId: m.mandateId, nodeUrl: node.url });
    // Domain from chains.ts ("USD Coin", "2"), checked against the real token's DOMAIN_SEPARATOR before signing.
    const permit = await agent.signPermit({ token: USDC, value: 50n * UNIT, publicClient: anvil.pub });
    const res = await ownerClient.submit({ ...m, policy, payees: [payee], label: "permit agent", permit });
    expect(res.status).toBe("open");
    mandateA = m.mandateId;
    expect(await anvil.pub.readContract({ address: USDC, abi: erc20Abi, functionName: "allowance", args: [agentA.address, hub] })).toBe(50n * UNIT);
    expect(await anvil.pub.readContract({ address: USDC, abi: fiatTokenAdminAbi, functionName: "nonces", args: [agentA.address] })).toBe(1n);
    expect(await anvil.pub.getTransactionCount({ address: agentA.address })).toBe(0);
    agent.close();
  });

  it("opens a mandate owned by a real Safe 1.4.1 created through the on-chain SafeProxyFactory (ERC-1271)", async () => {
    const initializer = encodeFunctionData({
      abi: safeAbi,
      functionName: "setup",
      args: [[safeSigner.address], 1n, zeroAddress, "0x", C.safe.compatibilityFallbackHandler, zeroAddress, 0n, zeroAddress],
    });
    const create = { address: C.safe.proxyFactory, abi: proxyFactoryAbi, functionName: "createProxyWithNonce", args: [C.safe.singletonL2, initializer, BigInt(Date.now())] } as const;
    const { result } = await anvil.pub.simulateContract({ ...create, account: privateKeyToAccount(deployer) });
    await send(deployer, C.safe.proxyFactory, encodeFunctionData(create));
    safe = result;
    expect(await anvil.pub.readContract({ address: safe, abi: safeAbi, functionName: "VERSION" })).toBe("1.4.1");
    expect(await anvil.pub.readContract({ address: safe, abi: safeAbi, functionName: "getOwners" })).toEqual([safeSigner.address]);

    const now = (await anvil.pub.getBlock()).timestamp;
    const m: Mandate = {
      owner: safe,
      agent: agentB.address,
      token: USDC,
      totalCap: 20n * UNIT,
      validAfter: now - 60n,
      validUntil: now + 86_400n,
      payeesRoot: payeesRoot([payee]),
      policyHash: policyHash(policy),
      salt: keccak256(toBytes(`safe-${now}`)),
    };
    const id = computeMandateId(133, hub, m);
    // The Safe owner signs the SafeMessage over the mandate digest; the Safe's fallback handler validates it.
    const ownerSignature = await safeSigner.signTypedData({
      domain: { chainId: 133, verifyingContract: safe },
      types: { SafeMessage: [{ name: "message", type: "bytes" }] },
      primaryType: "SafeMessage",
      message: { message: id },
    });
    expect(await anvil.pub.readContract({ address: safe, abi: safeAbi, functionName: "isValidSignature", args: [id, ownerSignature] })).toBe("0x1626ba7e");
    expect(await anvil.pub.readContract({ address: hub, abi: parseAbi(["function mandateDigest((address,address,address,uint256,uint64,uint64,bytes32,bytes32,bytes32)) view returns (bytes32)"]), functionName: "mandateDigest", args: [[m.owner, m.agent, m.token, m.totalCap, m.validAfter, m.validUntil, m.payeesRoot, m.policyHash, m.salt]] })).toBe(id);

    const agent = new AgentClient({ chainId: 133, hub, account: agentB, mandateId: id, nodeUrl: node.url });
    const permit = await agent.signPermit({ token: USDC, value: 20n * UNIT, publicClient: anvil.pub });
    agent.close();
    const r = await admin("POST", "/v1/mandates", {
      mandate: mandateToJson(m),
      ownerSignature,
      policy,
      payees: [payee],
      label: "Safe-owned agent",
      permit: { value: permit.value.toString(), deadline: permit.deadline.toString(), signature: permit.signature },
    });
    expect(r.status).toBe(201);
    expect(r.json.status).toBe("open");
    const onchain = await node.services.chain.mandate(id);
    expect(onchain?.owner).toBe(safe);
    mandateB = id;
  });

  it("pays calls through the SDK, settles on the fork, confirms at the safe head, attests on EAS and passes HSP", async () => {
    const reg = await admin<{ id: string; apiKey: string }>("POST", "/v1/providers", { name: "Fork Data", payee, priceAtomic: "10000", resource: "/data" });
    expect(reg.status).toBe(201);
    const app = new Hono();
    app.get("/data", paywall({ nodeUrl: node.url, providerId: reg.json.id, apiKey: reg.json.apiKey, price: 10_000n }).hono(), (c) => c.json({ ok: true }));
    const url = await new Promise<string>((resolve) => {
      const s = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" }, (i: AddressInfo) => resolve(`http://127.0.0.1:${i.port}`));
      servers.push(s as Server);
    });
    const operator = node.services.chain.operator.address;
    const a = new AgentClient({ chainId: 133, hub, account: agentA, mandateId: mandateA, nodeUrl: node.url, trustedNode: operator, autoCosign: true, cosignIntervalMs: 200 });
    const b = new AgentClient({ chainId: 133, hub, account: agentB, mandateId: mandateB, nodeUrl: node.url, trustedNode: operator, autoCosign: true, cosignIntervalMs: 200 });
    try {
      for (let i = 0; i < 4; i++) expect((await a.fetch(`${url}/data?i=${i}`)).status).toBe(200);
      for (let i = 0; i < 2; i++) expect((await b.fetch(`${url}/data?j=${i}`)).status).toBe(200);

      const s = await admin<{ batchIds: Hex[]; dropped: unknown[] }>("POST", "/v1/settlements");
      expect(s.json.dropped).toEqual([]);
      const id = s.json.batchIds[0]!;
      let batch = (await admin("GET", `/v1/batches/${id}`)).json;
      expect(batch.status).toBe("included");
      expect(BigInt(batch.gasUsed)).toBeGreaterThan(0n);

      // anvil's safe head trails latest by 32 blocks; HashKey testnet's by about 300.
      await rpc("anvil_mine", ["0x28"]);
      await node.services.settlement.trackFinality();
      batch = (await admin("GET", `/v1/batches/${id}`)).json;
      expect(batch.status).toBe("confirmed");
      expect(batch.reconciled).toBe(true);
      expect(batch.gross).toBe("60000");
      expect(await anvil.pub.readContract({ address: USDC, abi: erc20Abi, functionName: "balanceOf", args: [payee] })).toBe(60_000n);
      expect(await anvil.pub.getTransactionCount({ address: agentA.address })).toBe(0);
      expect(await anvil.pub.getTransactionCount({ address: agentB.address })).toBe(0);

      // EAS: schema registered on first use, one attestation per confirmed batch.
      expect(batch.attestation?.uid).toMatch(/^0x[0-9a-f]{64}$/);
      const att = await anvil.pub.readContract({
        address: C.eas,
        abi: parseAbi(["function getAttestation(bytes32 uid) view returns ((bytes32 uid, bytes32 schema, uint64 time, uint64 expirationTime, uint64 revocationTime, bytes32 refUID, address recipient, address attester, bool revocable, bytes data))"]),
        functionName: "getAttestation",
        args: [batch.attestation.uid],
      });
      expect(att.schema).toBe(schemaUid());
      expect(att.attester).toBe(operator);
      expect(att.recipient).toBe(hub);

      // Both debtors co-signed their HSP mandates; the local verifier ACCEPTs and lists the attestation capability.
      const hsp = batch.netTransfers.map((t: { hsp: { status: string; satisfiedCapabilities: string[] } }) => t.hsp);
      expect(hsp.length).toBeGreaterThan(0);
      for (const h of hsp) {
        expect(h.status).toBe("ACCEPT");
        expect(h.satisfiedCapabilities).toContain("attests:payminto-batch-settled:v1");
      }
      expect((await admin("GET", "/v1/ledger/trial-balance")).json).toMatchObject({ balanced: true, balance: "0" });
    } finally {
      a.close();
      b.close();
    }
  });
});
