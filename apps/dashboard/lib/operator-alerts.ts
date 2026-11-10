/**
 * `operator.alert` events from the server: conditions only the operator can resolve. The server logs each one as an
 * error and counts it in `payminto_operator_alerts_total{kind}`; here it becomes a warning that says what happened and
 * what to do. Pure, for tests.
 */
import type { NodeEvent } from "./schemas";

/** The kinds the server raises (OperatorAlert in the node's settlement.ts). */
export type OperatorAlertKind = "batch_mismatch" | "seller_settled_uncleared" | "settled_position_behind";

/** One figure of an alert, typed so the screen sets it with the right component: an account never wraps, an amount is exact. */
export type AlertFact = { label: string; value: string; as: "account" | "amount" | "id" | "text" };

export type OperatorAlertView = {
  id: string;
  /** ISO time the server raised it. */
  at: string;
  kind: string;
  title: string;
  /** What happened, in plain sentences. */
  happened: string;
  /** What the operator should do about it. */
  todo: string;
  facts: AlertFact[];
};

const text = (v: unknown): string | null => (typeof v === "string" && v ? v : typeof v === "number" ? String(v) : null);
const amount = (v: unknown): string | null => {
  const t = text(v);
  return t !== null && /^\d+$/.test(t) ? t : null;
};

function facts(list: Array<[string, string | null, AlertFact["as"]]>): AlertFact[] {
  return list.flatMap(([label, value, as]) => (value === null ? [] : [{ label, value, as }]));
}

/** Ends a server message with a full stop and a capital, so it reads as a sentence beside the dashboard's own. */
function sentence(message: string): string {
  const m = message.trim();
  if (!m) return "";
  const s = m[0]!.toUpperCase() + m.slice(1);
  return /[.!?]$/.test(s) ? s : `${s}.`;
}

/**
 * The alert carried by an `operator.alert` event, worded for the operator. Null for any other event or one with no
 * alert in it. A kind this dashboard does not know still shows, with the server's own message and a pointer to the log.
 */
export function operatorAlertOf(e: Pick<NodeEvent, "type" | "id" | "at" | "data">): OperatorAlertView | null {
  if (e.type !== "operator.alert") return null;
  const a = e.data.alert;
  if (!a || typeof a !== "object") return null;
  const alert = a as Record<string, unknown>;
  const kind = text(alert.kind) ?? "unknown";
  const message = sentence(text(alert.message) ?? "");
  const base = { id: e.id, at: e.at, kind };
  switch (kind) {
    case "batch_mismatch": {
      const seq = text(alert.seq);
      return {
        ...base,
        title: "The hub holds a batch this server did not settle",
        happened: `${message} The server did not book ${seq ? `settlement batch #${seq}` : "the settlement batch"} and marked it failed. The Calls it still held go back to wait for the next settlement.`.trim(),
        todo: "Compare the hub's record of this batch id with the server's. Check that no other server settles with this server's account or database, then run the next settlement.",
        facts: facts([
          ["Batch id", text(alert.batchId), "id"],
          ["Settler on the hub", text(alert.hubSettler), "account"],
          ["Root on the hub", text(alert.hubRoot), "id"],
          ["Root on this server", text(alert.nodeRoot), "id"],
        ]),
      };
    }
    case "seller_settled_uncleared":
      return {
        ...base,
        title: "A seller settled a voucher this server never accepted",
        happened:
          "A Payee settled its own voucher on the hub for more than this server had accepted for that Budget. The server's position now follows the hub, and the part it never cleared is booked as uncleared.",
        todo: "The hub takes a voucher from its seller only with an acceptance signed by a receipt key of this server. Check whether this database lost Calls it had accepted, for example after a restore, and whether a receipt key is in use anywhere else. Tell the Budget's owner.",
        facts: facts([
          ["Payee", text(alert.payee), "account"],
          ["Budget", text(alert.budgetId), "id"],
          ["Never cleared here", amount(alert.uncleared), "amount"],
          ["Settled on the hub", amount(alert.hubSettled), "amount"],
          ["Seller settlement", text(alert.sellerSettlement), "id"],
        ]),
      };
    case "settled_position_behind":
      return {
        ...base,
        title: "The hub's settled position is behind this server's",
        happened: "For one Budget and Payee the hub shows less settled than this server has booked. A settled position on the hub only moves forward, so this database and this hub do not belong together.",
        todo: "Check HUB_ACCOUNT, NETWORK and DB_PATH on the server: the database was probably made against another hub or network. Do not settle until they match.",
        facts: facts([
          ["Payee", text(alert.payee), "account"],
          ["Budget", text(alert.budgetId), "id"],
          ["Settled on the hub", amount(alert.hubSettled), "amount"],
          ["Settled on this server", amount(alert.nodeSettled), "amount"],
        ]),
      };
    default:
      return {
        ...base,
        title: "The server raised an alert only the operator can resolve",
        happened: message || "The server sent no description of the alert.",
        todo: "Read the server's error log for this alert; it has the details.",
        facts: [],
      };
  }
}

/** How many operator alerts the live stream keeps, however many other events follow them. */
export const KEEP_ALERTS = 20;

/**
 * Trims the live event list (newest first) to the latest `keep` events, but never lets ordinary traffic push an operator
 * alert out: a busy server emits more Calls in a minute than the list holds, and an alert must stay until it is read.
 */
export function retainEvents<E extends Pick<NodeEvent, "type">>(events: readonly E[], keep: number, keepAlerts = KEEP_ALERTS): E[] {
  let other = 0;
  let alerts = 0;
  return events.filter((e) => (e.type === "operator.alert" ? alerts++ < keepAlerts : other++ < keep));
}

/** The alerts among the latest live events, newest first, without the ones the operator dismissed. */
export function operatorAlerts(events: ReadonlyArray<Pick<NodeEvent, "type" | "id" | "at" | "data">>, dismissed: ReadonlySet<string> = new Set()): OperatorAlertView[] {
  return events.flatMap((e) => {
    const a = operatorAlertOf(e);
    return a && !dismissed.has(a.id) ? [a] : [];
  });
}
