/**
 * End to end against a real near-sandbox node: an owner revokes a Budget on a deployed hub and pays no gas, because the
 * relayer wraps the owner's signed delegate in its own transaction.
 *
 * Slow, and it needs the sandbox, so it is skipped unless PAYMINTO_SANDBOX=1. Run it with:
 *   pnpm --filter @payminto/relayer test:sandbox
 * It deploys contracts-near/out/hub.wasm and mock_ft.wasm as they are; it does not build them.
 * The sandbox binary comes from NEAR_SANDBOX_BIN_PATH, else the copy the contract's cargo tests downloaded, else
 * near-kit downloads near-sandbox 2.14.0.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { budgetIdOf, keypairFromSeed, openBudgetTx, type BudgetTerms } from "@payminto/chain";
import { NearRpcChain, sendWalletTx } from "@payminto/chain/node";
import { gasless, ViewRpc } from "@payminto/near-addons";
import { generateKey, Near, type KeyPair } from "near-kit";
import { Sandbox } from "near-kit/sandbox";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
// The deploy script is the one supported way to stand up a hub, so the test follows the hub as the contract team changes it.
import { deployHub } from "../../../packages/chain/scripts/deploy-hub.ts";
import { keypairFromSecret } from "../src/cli/keys.ts";
import { loadConfig } from "../src/config.ts";
import { startRelayer, type RunningRelayer } from "../src/server.ts";

const RUN = process.env["PAYMINTO_SANDBOX"] === "1";
const NETWORK = "near:sandbox" as const;
const ROOT_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const ONE_NEAR = 10n ** 24n;
const DAY_MS = 86_400_000n;

function sandboxBinary(): string | undefined {
  const fromEnv = process.env["NEAR_SANDBOX_BIN_PATH"];
  if (fromEnv) return fromEnv;
  const build = join(ROOT_DIR, "contracts-near", "target", "debug", "build");
  if (!existsSync(build)) return undefined;
  for (const dir of readdirSync(build).filter((d) => d.startsWith("near-sandbox-"))) {
    const bin = join(build, dir, "out", ".near", "near-sandbox-2.14.0", "near-sandbox");
    if (existsSync(bin)) return bin;
  }
  return undefined;
}

type Actor = { id: string; key: KeyPair; near: Near };
type RelayAnswer = { txHash?: string; sender?: string; receiver?: string; methods?: string[]; error?: { code: string; message: string; txHash?: string } };

describe.skipIf(!RUN)("a gasless revoke through the relayer on near-sandbox", () => {
  let sandbox: Sandbox;
  let root: Near;
  let hub: Actor, admin: Actor, token: Actor, node: Actor, alice: Actor, bob: Actor, relayerAccount: Actor;
  let reader: NearRpcChain;
  let relayer: RunningRelayer;
  let view: ViewRpc;
  let budgetId: string;

  const actor = async (name: string, balance: string): Promise<Actor> => {
    const id = `${name}.${sandbox.rootAccount.id}`;
    const key = generateKey();
    await root
      .transaction(sandbox.rootAccount.id)
      .createAccount(id)
      .transfer(id, balance as `${number} NEAR`)
      .addKey(key.publicKey.toString(), { type: "fullAccess" })
      .send({ waitUntil: "FINAL" });
    const near = new Near({ network: { rpcUrl: sandbox.rpcUrl, networkId: "localnet" }, keyStore: { [id]: key.secretKey } });
    return { id, key, near };
  };

  /** yoctoNEAR on an account at final finality. */
  const nearBalance = async (id: string): Promise<bigint> => BigInt((await root.rpc.getAccount(id, { finality: "final" })).amount);

  /** A delegate signed by `who` with their own key, with the nonce and window read from the chain. */
  const signedBy = async (who: Actor, build: (p: { owner: string; hub: string; publicKey: ReturnType<typeof keypairFromSecret>["publicKey"]; nonce: bigint; maxBlockHeight: bigint }) => gasless.DelegateAction) => {
    const pair = keypairFromSecret(who.key.secretKey);
    const params = await gasless.delegateParams(view, who.id, pair.publicKey);
    return gasless.relayRequestBody(gasless.signDelegate(build({ owner: who.id, hub: hub.id, publicKey: pair.publicKey, ...params }), pair.secretKey));
  };

  const post = async (body: { signedDelegate: string }): Promise<{ status: number; json: RelayAnswer }> => {
    const res = await fetch(`${relayer.url}/relay`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    return { status: res.status, json: (await res.json()) as RelayAnswer };
  };

  beforeAll(async () => {
    // Detached, because near-kit then discards the node's output (see packages/chain/test/sandbox.test.ts).
    sandbox = await Sandbox.start({ version: "2.14.0", binaryPath: sandboxBinary(), detached: true });
    root = new Near({ network: sandbox });
    [hub, admin, token, node, alice, bob, relayerAccount] = await Promise.all([
      actor("hub", "30 NEAR"),
      actor("admin", "5 NEAR"),
      actor("usdc", "30 NEAR"),
      actor("node", "5 NEAR"),
      actor("alice", "10 NEAR"),
      actor("bob", "5 NEAR"),
      actor("relayer", "5 NEAR"),
    ]);

    // The mock NEP-141 stands in for testnet USDC, in sandbox only.
    const ft = readFileSync(join(ROOT_DIR, "contracts-near", "out", "mock_ft.wasm"));
    await token.near.transaction(token.id).deployContract(token.id, ft).functionCall(token.id, "new", {}, { gas: "30 Tgas" }).send({ waitUntil: "FINAL" });

    await deployHub({
      network: "sandbox",
      rpcUrl: sandbox.rpcUrl,
      hub: hub.id,
      admin: admin.id,
      token: token.id,
      settler: node.id,
      checkoutKey: keypairFromSeed(new Uint8Array(32).fill(50)).publicKey,
      hubKey: hub.key.secretKey,
      adminKey: admin.key.secretKey,
      log: () => {},
    });
    reader = new NearRpcChain({ hub: hub.id, token: token.id, network: NETWORK, rpcUrl: sandbox.rpcUrl, operator: node.id });
    view = new ViewRpc(sandbox.rpcUrl);

    // Alice opens a Budget from her own wallet. This is the last time she pays for gas in this test.
    const terms: BudgetTerms = {
      owner: alice.id,
      agentPk: keypairFromSeed(new Uint8Array(32).fill(1)).publicKey,
      settler: node.id,
      cap: 1_000n,
      validUntil: BigInt(Date.now()) + DAY_MS,
      payees: [],
      policyHash: "aa".repeat(32),
      salt: "a1".repeat(32),
    };
    budgetId = budgetIdOf(hub.id, NETWORK, terms);
    await sendWalletTx(alice.near, alice.id, openBudgetTx(hub.id, terms, ONE_NEAR.toString()));

    relayer = await startRelayer(
      loadConfig({
        RELAYER_ACCOUNT: relayerAccount.id,
        RELAYER_KEY: relayerAccount.key.secretKey,
        HUB_ACCOUNT: hub.id,
        NETWORK,
        RPC_URL: sandbox.rpcUrl,
        PORT: "0",
        RATE_LIMIT_IP_PER_MIN: "0",
        RATE_LIMIT_SENDER_PER_MIN: "0",
      }),
      { gasLedger: null },
    );
  }, 240_000);

  afterAll(async () => {
    await relayer?.stop();
    await sandbox?.stop();
  });

  it("describes itself", async () => {
    const info = (await (await fetch(`${relayer.url}/info`)).json()) as Record<string, unknown>;
    expect(info).toEqual({ relayer: relayerAccount.id, hub: hub.id, network: NETWORK, methods: [...gasless.DEFAULT_RELAY_METHODS], maxGasTgas: 300 });
  });

  it("refuses the owner's call to any other contract: 403 NOT_SPONSORED, and the relayer spends nothing", async () => {
    const before = await nearBalance(relayerAccount.id);
    const body = await signedBy(alice, (p) => ({
      senderId: p.owner,
      receiverId: token.id,
      actions: [{ type: "FunctionCall", methodName: "revoke_budget", args: new TextEncoder().encode(JSON.stringify({ budget_id: budgetId })), gas: 30_000_000_000_000n, deposit: 0n }],
      nonce: p.nonce,
      maxBlockHeight: p.maxBlockHeight,
      publicKey: p.publicKey,
    }));
    const { status, json } = await post(body);
    expect(status).toBe(403);
    expect(json.error?.code).toBe("NOT_SPONSORED");
    expect(await nearBalance(relayerAccount.id)).toBe(before);
  }, 60_000);

  it("relays a stranger's revoke, the hub refuses it, and the relayer says so instead of reporting success", async () => {
    const body = await signedBy(bob, (p) => gasless.revokeBudgetDelegate({ ...p, budgetId }));
    const { status, json } = await post(body);
    expect(status).toBe(422);
    expect(json.error?.code).toBe("CALL_FAILED");
    expect(json.error?.message).toContain("NOT_OWNER");
    expect((await reader.budget(budgetId))!.revokedAt).toBeNull();

    // Why the relayer reads receipts: the network calls this transaction a success, because the delegate receipt did
    // forward the call. Only the hub's own receipt shows the refusal.
    const raw = await root.rpc.call<{ status: unknown; receipts_outcome: Array<{ outcome: { executor_id: string; status: unknown } }> }>("tx", {
      tx_hash: json.error!.txHash,
      sender_account_id: relayerAccount.id,
      wait_until: "FINAL",
    });
    expect(raw.status).toEqual({ SuccessValue: "" });
    const hubReceipt = raw.receipts_outcome.find((r) => r.outcome.executor_id === hub.id)!;
    expect(JSON.stringify(hubReceipt.outcome.status)).toContain("Smart contract panicked: NOT_OWNER");
  }, 60_000);

  it("revokes the owner's Budget while the owner pays no NEAR at all", async () => {
    expect((await reader.budget(budgetId))!.revokedAt).toBeNull();
    const ownerBefore = await nearBalance(alice.id);
    const relayerBefore = await nearBalance(relayerAccount.id);

    const body = await signedBy(alice, (p) => gasless.revokeBudgetDelegate({ ...p, budgetId }));
    const { status, json } = await post(body);
    expect(json.error).toBeUndefined();
    expect(status).toBe(200);
    expect(json).toMatchObject({ sender: alice.id, receiver: hub.id, methods: ["revoke_budget"] });
    expect(json.txHash).toMatch(/^[1-9A-HJ-NP-Za-km-z]{43,44}$/);

    // The hub saw the owner as the caller and revoked the Budget.
    expect((await reader.budget(budgetId))!.revokedAt).not.toBeNull();
    // The owner's balance did not move by one yoctoNEAR; the relayer paid.
    expect(await nearBalance(alice.id)).toBe(ownerBefore);
    expect(await nearBalance(relayerAccount.id)).toBeLessThan(relayerBefore);
    // The transaction is the relayer's, sent to the owner's account.
    expect(await reader.txState(json.txHash!, relayerAccount.id)).toEqual({ status: "final" });

    // The same signed delegate cannot be relayed again.
    const again = await post(body);
    expect(again.status).toBe(409);
    expect(again.json.error?.code).toBe("NONCE_USED");
  }, 120_000);
});
