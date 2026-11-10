import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeChain } from "@payminto/chain/fake";
import {
  budgetIdOf,
  budgetTermsToJson,
  keypairFromSeed,
  nep413Digest,
  payoutProofRequest,
  policyHash,
  signDigest,
  voucherDigest,
  type AccountId,
  type BudgetTerms,
  type Id32,
  type Keypair,
  type PayoutProof,
  type PayoutProofScope,
  type Policy,
  type PublicKey,
  type Voucher,
} from "@payminto/protocol";
import { DEFAULT_RATE_LIMIT, type Config } from "../src/config.ts";
import type { AccessKeyKind, AccessKeyReader, TxReader, TxTransfers } from "../src/near-rpc.ts";

export const HUB = "hub.payminto.testnet";
export const TOKEN = "usdc.fake.testnet";
export const OPERATOR = "node.payminto.testnet";
/** Public test seed for the node's receipt key. Never used outside tests. */
export const TEST_NODE_SEED = "11".repeat(32);

export const OWNER_A = "alice.testnet";
export const OWNER_B = "bob.testnet";
export const SELLER = "seller.testnet";

export const testKey = (n: number): Keypair => keypairFromSeed(new Uint8Array(32).fill(n));

/** A NEAR account with a full-access test key, for NEP-413 payout proofs. Never funded anywhere. */
export type PayoutAccount = { account: AccountId; key: Keypair };
export const payoutAccount = (name: string, seed: number): PayoutAccount => ({ account: name, key: testKey(seed) });

/** What a dashboard sends after NEAR Connect `signMessage`: a NEP-413 proof bound to this node's network and hub. */
export function payoutProof(a: PayoutAccount, merchantId: string, scope: PayoutProofScope, timestamp = Math.floor(Date.now() / 1000)): PayoutProof {
  const digest = nep413Digest(payoutProofRequest(merchantId, a.account, timestamp, scope));
  return { payout: a.account, timestamp, public_key: a.key.publicKey, signature: Buffer.from(signDigest(a.key.secretKey, digest), "hex").toString("base64") };
}

/**
 * The node-local NEAR RPC reads, in memory: which keys are full-access keys of which accounts, and which refund
 * transactions exist. Tests register both.
 */
export class FakeNearRpc implements AccessKeyReader, TxReader {
  readonly keys = new Map<string, AccessKeyKind>();
  readonly txs = new Map<string, TxTransfers>();

  addKey(account: AccountId, key: PublicKey, kind: Exclude<AccessKeyKind, null> = "full_access"): this {
    this.keys.set(`${account} ${key}`, kind);
    return this;
  }

  async accessKey(account: AccountId, publicKey: PublicKey): Promise<AccessKeyKind> {
    return this.keys.get(`${account} ${publicKey}`) ?? null;
  }

  async transfers(hash: string, signer: AccountId): Promise<TxTransfers> {
    const t = this.txs.get(hash);
    if (!t) return { status: "unknown" };
    return t.status === "final" && t.signer !== signer ? { status: "unknown" } : t;
  }
}

export async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.unref();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const port = (srv.address() as { port: number }).port;
      srv.close(() => resolve(port));
    });
  });
}

/** A fresh in-memory hub with the test node allowlisted as a settler, and funded, registered test accounts. */
export function startFakeChain(accounts: readonly AccountId[] = [OWNER_A, OWNER_B, SELLER]): FakeChain {
  const chain = new FakeChain({ hub: HUB, token: TOKEN, network: "near:sandbox", operator: OPERATOR });
  chain.addSettler(OPERATOR);
  for (const a of accounts) chain.mint(a, 1_000_000_000n);
  return chain;
}

/** Fresh temp directory per test file; never DB_PATH. */
export function tempDir(prefix = "payminto-node-"): { dir: string; dbPath: string; cleanup(): void } {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  return { dir, dbPath: join(dir, "clearing.test.db"), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

export function testConfig(over: Partial<Config> & Pick<Config, "dbPath">): Config {
  return {
    port: 0,
    host: "127.0.0.1",
    network: "near:sandbox",
    rpcUrl: "http://127.0.0.1:1",
    hub: HUB,
    token: TOKEN,
    operator: OPERATOR,
    operatorKey: "ed25519:test-only",
    nodeSigningSeed: TEST_NODE_SEED,
    adminToken: "test-admin-token-123",
    settleIntervalSec: 0,
    settleMinCalls: 1,
    publicUrl: "http://127.0.0.1:0",
    corsOrigins: ["http://localhost:3000"],
    logLevel: "error",
    fundsRefreshSec: 30,
    rateLimit: DEFAULT_RATE_LIMIT,
    trustProxyHops: 0,
    denials: { dedupWindowSec: 60, maxRows: 100_000 },
    eventsMaxRows: 200_000,
    // Cheap password hashing and generous auth limits keep suites fast; the auth suite tightens them where it tests them.
    auth: { scryptLogN: 12, rateLimitPerMin: 10_000, setupPerMin: 10_000, emailPerHour: 10_000, searchRps: 1_000 },
    ...over,
  };
}

export const DEFAULT_POLICY: Policy = { perCallCap: "1000000", dailyCap: "100000000", maxCallsPerMinute: 0, purpose: "test" };

let saltSeq = 0;

/** Budget terms for a test, ready for `FakeChain.openBudget` and `POST /v1/budgets`. */
export function budgetTerms(owner: AccountId, agent: Keypair, over: Partial<BudgetTerms> & { policy?: Policy } = {}): { terms: BudgetTerms; policy: Policy } {
  const { policy = DEFAULT_POLICY, ...rest } = over;
  const terms: BudgetTerms = {
    owner,
    agentPk: agent.publicKey,
    settler: OPERATOR,
    cap: 100_000_000n,
    validUntil: BigInt(Date.now()) + 86_400_000n,
    payees: [],
    policyHash: policyHash(policy),
    salt: (++saltSeq).toString(16).padStart(64, "0"),
    ...rest,
  };
  return { terms, policy };
}

export type OpenedBudget = { id: Id32; terms: BudgetTerms; policy: Policy; agent: Keypair };

/** Opens and funds a Budget on the fake hub, then registers it with the node over HTTP. */
export async function openBudget(
  chain: FakeChain,
  nodeUrl: string,
  adminToken: string,
  owner: AccountId,
  agent: Keypair,
  o: { escrow?: bigint; label?: string } & Partial<BudgetTerms> & { policy?: Policy } = {},
): Promise<OpenedBudget> {
  const { escrow = 50_000_000n, label = "test budget", ...over } = o;
  const { terms, policy } = budgetTerms(owner, agent, over);
  const id = chain.openBudget(owner, terms);
  if (escrow > 0n) chain.depositBudget(owner, id, escrow);
  const res = await fetch(`${nodeUrl}/v1/budgets`, {
    method: "POST",
    headers: { authorization: `Bearer ${adminToken}`, "content-type": "application/json" },
    body: JSON.stringify({ budget: budgetTermsToJson(terms), policy, label }),
  });
  if (res.status !== 201) throw new Error(`POST /v1/budgets: ${res.status} ${await res.text()}`);
  return { id: budgetIdOf(chain.hub, chain.network, terms), terms, policy, agent };
}

export function signVoucher(chain: Pick<FakeChain, "hub" | "network">, agent: Keypair, v: Voucher): string {
  return signDigest(agent.secretKey, voucherDigest(chain.hub, chain.network, v));
}
