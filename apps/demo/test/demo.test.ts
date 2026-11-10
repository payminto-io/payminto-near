import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { checkReport } from "../src/checks.ts";
import { loadDemoConfig } from "../src/config.ts";
import { runStory, tamper, type Report } from "../src/scenario.ts";
import { startStack, type Stack } from "../src/stack.ts";
import { receiptFileSchema, verifyBatch, verifyReceipt, type ReceiptFile } from "../src/verify.ts";

const dir = mkdtempSync(join(tmpdir(), "payminto-demo-"));
let stack: Stack;
let report: Report;

beforeAll(async () => {
  // A quarter of the calls: the same acts and the same checks, fast enough for every test run.
  stack = await startStack(loadDemoConfig({ DEMO_DATA_DIR: dir }, ["--scale", "0.25"]));
  report = await runStory(stack);
}, 60_000);

afterAll(async () => {
  await stack?.stop();
  rmSync(dir, { recursive: true, force: true });
});

describe("the demo story on the simulated hub", () => {
  it("passes every check", () => {
    const failed = checkReport(report).filter((c) => !c.ok);
    expect(failed).toEqual([]);
  });

  it("shows each refusal with the rule that fired and who enforced it", () => {
    const seen = report.refusals.map((r) => `${r.rule}:${r.enforcedBy}`);
    expect(seen).toEqual(
      expect.arrayContaining(["PAYEE_NOT_ALLOWED:agent", "PAYEE_NOT_ALLOWED:node", "PAYEE_BLOCKED:agent", "PAYEE_BLOCKED:node", "PAYEE_NEEDS_APPROVAL:agent", "REPEAT_REQUEST:agent", "NET_EXPOSURE:node", "HOURLY_CAP:node"]),
    );
  });

  it("shows the payee check from the node and the chain: an unlisted payee it allows, a lookalike it blocks, a warned payee that waits for the owner", () => {
    const { unlisted, lookalike, approval } = report.payeeCheck;
    expect(unlisted).toMatchObject({ onChain: { exists: true, registeredWithToken: true }, node: { verdict: "allow" } });
    expect(lookalike).toMatchObject({ onChain: { exists: false }, node: { verdict: "block" }, wallet: { rule: "PAYEE_BLOCKED", enforcedBy: "agent" }, walletSigned: 0n, nodePosition: 0n, nodeRecord: { rule: "PAYEE_BLOCKED", signedByNode: true } });
    expect(lookalike.node!.signals).toEqual(expect.arrayContaining(["account_missing", "lookalike_payee"]));
    expect(lookalike.positionAfter).toBe(lookalike.positionBefore);
    expect(approval).toMatchObject({ onChain: { exists: true, registeredWithToken: false }, node: { verdict: "warn", signals: ["token_unregistered"] }, first: { rule: "PAYEE_NEEDS_APPROVAL", retry: { kind: "approval" } }, approvedAtNode: { decision: "approve", signals: ["token_unregistered"] }, paid: { bookedAtNode: true }, withdrawn: true, again: { rule: "PAYEE_NEEDS_APPROVAL" }, waitingAgain: true });
    expect([approval.positionBefore, approval.positionWhileWaiting, approval.positionAfterPaid, approval.positionAfterAgain]).toEqual([0n, 0n, approval.price, approval.price]);
  });

  it("clears more than it moves, in fewer transfers than calls", () => {
    expect(report.settlement.net).toBeLessThan(report.settlement.gross);
    expect(report.payout.transfers).toBeLessThan(report.paidCalls);
    expect(report.simulated).toBe(true);
  });

  it("moves earned credit into escrow without raising the cap", () => {
    expect(report.fundFromCredit).toMatchObject({ owner: "acme.testnet", capUnchanged: true });
    expect(report.fundFromCredit!.escrowRise).toBe(report.fundFromCredit!.amount);
  });
});

describe("the checks themselves", () => {
  it("fail when an invariant breaks", () => {
    const broken: Report = { ...report, settleOwn: { ...report.settleOwn, credited: report.settleOwn.expected + 1n }, solvent: false, solvencyError: "broken" };
    const failed = checkReport(broken).filter((c) => !c.ok).map((c) => c.name);
    expect(failed).toEqual(["settle_own credited exactly what the node never settled, with the node's acceptance checked against the hub", "the hub is solvent: balance = escrow + credits + in flight"]);
  });

  it("fail when settle_own takes a voucher the node never accepted, or when the hub pays for storage", () => {
    const names = (r: Report) => checkReport(r).filter((c) => !c.ok).map((c) => c.name);
    expect(names({ ...report, guards: { ...report.guards, ownerToSelf: "SETTLED" } })).toEqual(["an owner's self-signed voucher with no node acceptance is refused by settle_own"]);
    expect(names({ ...report, guards: { ...report.guards, ownerToAccomplice: "SETTLED" } })).toEqual(["an owner's self-signed voucher with no node acceptance is refused by settle_own"]);
    expect(names({ ...report, guards: { ...report.guards, datedAfterRevoke: "SETTLED" } })).toEqual(["a voucher signed by the agent key after the revoke cannot be settled"]);
    expect(names({ ...report, guards: { ...report.guards, leakedKeyAlone: "BAD_ACCEPTANCE" } })).toEqual(["a voucher signed by the agent key after the revoke cannot be settled"]);
    const STORAGE = "storage for the batch was charged to the settler's prepaid balance, not to the hub";
    expect(names({ ...report, storage: { ...report.storage, charged: 0n } })).toEqual([STORAGE]);
    // On a real chain: the hub account grew by more than the settler paid for, or the hub's own balance fell.
    const charged = 5_000n * 10n ** 19n;
    const real = { ...report.storage, charged, hubBytesGrown: 5_000, hubOwnChange: 0n };
    expect(names({ ...report, storage: real })).toEqual([]);
    expect(names({ ...report, storage: { ...real, hubBytesGrown: 5_001 } })).toEqual([STORAGE]);
    expect(names({ ...report, storage: { ...real, hubOwnChange: -1n } })).toEqual([STORAGE]);
    expect(names({ ...report, storage: { ...report.storage, receiptKeyOnHub: false } })).toEqual(["the node's receipt key is registered on the hub"]);
    expect(names({ ...report, settleOwn: { ...report.settleOwn, checkedAgainst: "declared-keys" } })).toEqual(["settle_own credited exactly what the node never settled, with the node's acceptance checked against the hub"]);
  });

  it("fail when the payee check is missing from the story, or lets a payment through", () => {
    const names = (r: Report) => checkReport(r).filter((c) => !c.ok).map((c) => c.name);
    const pc = report.payeeCheck;
    const NOT_ALLOWED = "PAYEE_NOT_ALLOWED fired for an unlisted payee the payee check has nothing against, in the wallet and at the node";
    const BLOCKED = "PAYEE_BLOCKED stopped a lookalike of an allowed payee: the wallet signed nothing, the node refused a guard-off runtime, and no position moved";
    const WAITS = "PAYEE_NEEDS_APPROVAL held a warned payee until the owner approved it on the node, the same call was then paid, and it waited again once the approval was withdrawn";
    // The old failure on a real chain: the unlisted payee did not exist, so the node blocked it before the list could.
    expect(names({ ...report, payeeCheck: { ...pc, unlisted: { ...pc.unlisted, onChain: { exists: false, registeredWithToken: false }, node: { verdict: "block", signals: ["account_missing"], notChecked: [] } } } })).toEqual([NOT_ALLOWED]);
    expect(names({ ...report, payeeCheck: { ...pc, lookalike: { ...pc.lookalike, walletSigned: 2_000n } } })).toEqual([BLOCKED]);
    expect(names({ ...report, payeeCheck: { ...pc, lookalike: { ...pc.lookalike, positionAfter: pc.lookalike.positionBefore + 1n } } })).toEqual([BLOCKED]);
    expect(names({ ...report, payeeCheck: { ...pc, lookalike: { ...pc.lookalike, nodeRecord: null } } })).toEqual([BLOCKED]);
    expect(names({ ...report, payeeCheck: { ...pc, approval: { ...pc.approval, positionWhileWaiting: pc.approval.price } } })).toEqual([WAITS]);
    expect(names({ ...report, payeeCheck: { ...pc, approval: { ...pc.approval, again: null, waitingAgain: false } } })).toEqual([WAITS]);
    expect(names({ ...report, payeeCheck: { ...pc, approval: { ...pc.approval, paid: null } } })).toEqual([WAITS]);
  });

  it("the story read real refusals from the hub", () => {
    expect(report.guards).toEqual({ ownerToSelf: "PAYEE_IS_OWNER", ownerToAccomplice: "ACCEPTANCE_KEY_UNKNOWN", leakedKeyAlone: "ACCEPTANCE_KEY_UNKNOWN", datedAfterRevoke: "ACCEPTANCE_TOO_LATE", escrowUntouched: true });
    expect(report.storage.charged).toBeGreaterThan(0n);
    expect(report.storage.receiptKeyOnHub).toBe(true);
    expect(report.settleOwn).toMatchObject({ checkedAgainst: "hub", unsettleable: 0, replayRefused: true });
  });

  it("refuse a sandbox label that names a public network, and an unlocked hub", () => {
    const sandbox: Report = { ...report, simulated: false, label: "SANDBOX (a local NEAR node)", hub: { accessKeys: 0, codeHash: "abc", expectedCodeHash: "abc" } };
    expect(checkReport(sandbox).filter((c) => !c.ok)).toEqual([]);
    expect(checkReport({ ...sandbox, label: "SANDBOX on testnet" }).filter((c) => !c.ok).map((c) => c.name)).toEqual(["chain is labeled"]);
    const unlocked = checkReport({ ...sandbox, hub: { accessKeys: 1, codeHash: "abc", expectedCodeHash: "abc" } });
    expect(unlocked.filter((c) => !c.ok).map((c) => c.name)).toEqual(["the hub is locked and runs the committed hub.wasm"]);
  });
});

describe("the receipt verifier on the receipt file the story wrote", () => {
  const load = (): ReceiptFile => receiptFileSchema.parse(JSON.parse(readFileSync(report.verifier.receiptPath!, "utf8")));
  const failedOf = async (f: ReceiptFile) => (await verifyReceipt(stack.hub.chain, f)).lines.filter((l) => l.ok === false).map((l) => l.what);
  const PATH = "the Merkle path folds from this receipt's leaf to the stored root (computed here)";
  const HUB_VIEW = "the hub's own verify_receipt view agrees";

  it("proves the genuine file from the hub alone", async () => {
    const r = await verifyReceipt(stack.hub.chain, load());
    expect(r.ok).toBe(true);
    expect(r.lines.filter((l) => l.ok === true)).toHaveLength(8);
  });

  it("rejects a changed amount, a broken path, another batch, another operator and another hub", async () => {
    const f = load();
    expect(await failedOf(tamper(f))).toEqual(["the voucher signature verifies against the Budget's agent key on chain", PATH, HUB_VIEW]);
    expect(await failedOf({ ...f, proof: f.proof.slice(1) })).toEqual([PATH, HUB_VIEW]);
    expect(await failedOf({ ...f, batchId: "ab".repeat(32) })).toEqual([`batch ${"ab".repeat(32)} is stored on the hub`, HUB_VIEW]);
    expect(await failedOf({ ...f, operator: "someone-else.testnet" })).toEqual(["the batch was settled by the Budget's own settler"]);
    expect(await failedOf({ ...f, hub: "other-hub.testnet" })).toEqual(["the receipt names this hub and network"]);
  });

  it("reports a stored batch, and fails on a missing one", async () => {
    expect((await verifyBatch(stack.hub.chain, load().batchId)).ok).toBe(true);
    expect((await verifyBatch(stack.hub.chain, "ab".repeat(32))).ok).toBe(false);
  });
});
