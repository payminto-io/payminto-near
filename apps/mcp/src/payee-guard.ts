/**
 * The wallet's side of the payee check: its own read-only look at a payee before anything is signed, and the question
 * it asks its node when that look has warnings.
 *
 * The wallet never approves a payee and has no tool that does. On block it refuses. On warn it asks its own clearing
 * node whether the Budget's owner approved the payee, with a request signed by the agent key, and refuses until the
 * answer is yes. Where the node has nothing against the payee and the MCP client can ask a person (elicitation), the
 * person at the client may be asked instead; the node's approval is the path that always works.
 */
import { z } from "zod";
import { nearBlocksAgeSource, payeeCheckForNode, rpcReader, type HistorySource, type PayeeCheck } from "@payminto/payee-check";
import { MemoryCodeStore } from "@payminto/payee-check";
import { FileCodeStore } from "@payminto/payee-check/node";
import { retryHintSchema, type AccountId, type Network, type RefusalWire } from "@payminto/protocol";

/** Builds the wallet's check once the wallet knows its token and can count its own receipts. */
export type PayeeCheckFactory = (ctx: { token: AccountId; network: Network; history: HistorySource }) => PayeeCheck;

/**
 * The wallet's check over read-only NEAR RPC. It holds no key and sends no transaction. Verdicts are reused for 30 s
 * and no look takes longer than 12 s (a first look through public endpoints takes a few seconds). The code each payee ran is remembered in a small file next to the receipts, so a
 * later look can say that it changed.
 */
export function rpcPayeeCheck(o: { rpcUrl: string; indexer: "nearblocks" | "off"; indexerKey?: string; codeStorePath?: string }): PayeeCheckFactory {
  return ({ token, network, history }) => {
    const check = payeeCheckForNode({
      // The package's reader: a wallet on a network's public default endpoint also tries the second public endpoint,
      // because both are rate limited; a wallet with its own NEAR_RPC_URL reads that endpoint and no other.
      reader: rpcReader(o.rpcUrl),
      token,
      // NearBlocks indexes testnet; a local chain has no indexer, so the age stays unchecked there and the verdict says so.
      ...(o.indexer === "nearblocks" && network === "near:testnet" ? { ageSource: nearBlocksAgeSource({ network: "testnet", ...(o.indexerKey ? { apiKey: o.indexerKey } : {}) }) } : {}),
      history,
      // Without a file the code each payee ran is remembered for this process only.
      codeStore: o.codeStorePath ? new FileCodeStore({ path: o.codeStorePath }) : new MemoryCodeStore(),
      timeLimitMs: 12_000,
    });
    return (request) => check(request.payer ?? null, request.payee, 0n, request.budgetPayees ?? null);
  };
}

export type PersonAnswer = "approve" | "deny" | "unavailable";

/** Asks the person at the MCP client. `unavailable` when nobody could be asked or nobody answered. */
export type AskPerson = (q: { payee: AccountId; amountAtomic: string; amount: string; reasons: string[] }) => Promise<PersonAnswer>;

export type GuardSignal = { id: string; severity: "info" | "warn" | "block"; reason: string };

const zSignal = z.object({ id: z.string().max(64), severity: z.enum(["info", "warn", "block"]), reason: z.string().max(600) });

/** What the wallet's own node answers to `POST /v1/budgets/:id/payee-approvals/requests`. Parsed like any other input. */
export const approvalAnswerSchema = z
  .object({
    status: z.enum(["approved", "denied", "waiting", "blocked"]),
    approveAt: z.string().max(400),
    payeeCheck: z.object({ enabled: z.boolean(), verdict: z.enum(["allow", "warn", "block"]).nullable(), signals: z.array(zSignal).max(40) }).loose(),
    request: z.object({ id: z.string().max(64) }).loose().nullable(),
  })
  .loose();
export type ApprovalAnswer = z.infer<typeof approvalAnswerSchema>;

/**
 * The retry hint of a call that waits for the owner. `approveAt` comes from the wallet's own node, which builds it
 * from its configured dashboard URL; it is still held to the wire schema, and dropped when it does not pass.
 */
export function approvalHint(payee: AccountId, approveAt: string | null): RefusalWire["retry"] {
  const hint = approveAt === null ? null : retryHintSchema.safeParse({ kind: "approval", payee, approveAt });
  return hint?.success ? hint.data : { kind: "never" };
}

/** How a warn was settled, or not. */
export type WarnState =
  | { state: "owner_approved" }
  | { state: "person_approved" }
  | { state: "owner_denied"; approveAt: string }
  | { state: "node_blocked"; signals: GuardSignal[] }
  | { state: "waiting"; approveAt: string; requestId: string | null }
  | { state: "person_declined" }
  /** The node could not be asked, and no person could be either. */
  | { state: "unknown"; why: string };

/** A payment the wallet stopped before signing, because of the payee. */
export type PayeeStop = {
  rule: "PAYEE_BLOCKED" | "PAYEE_NEEDS_APPROVAL";
  message: string;
  retry: RefusalWire["retry"];
  payee: AccountId;
  /** The total of the offer that was stopped, atomic units. */
  attemptedAmount: string;
  /** `waiting`: the owner has not decided. Other values say who said no, or that nothing could be learned. */
  status: "blocked" | "check_unavailable" | "owner_denied" | "waiting" | "person_declined" | "unknown";
  /** The signals behind it, heaviest first: generated reasons only, never the text of a report. */
  signals: GuardSignal[];
  notChecked: string[];
  /** Where the owner decides, when the node said so. For the owner to open: never an address to call or pay. */
  approveAt: string | null;
  requestId: string | null;
};
