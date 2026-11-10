/**
 * Demo switches for mock mode, so the failure states of the wallet, the relayer and a DAO can be seen with no chain.
 * Set them in the address bar: `?demo=relayer-down`, or several as `?demo=wallet-rejects,dao-edge`. They stay for the
 * tab until `?demo=off`. This module is only ever loaded under NEXT_PUBLIC_MOCK.
 */
import { DEMO_KEY, captureDemoSwitches } from "./capture";

export const DEMO_SCENARIOS = [
  /** The demo wallet declines every request, as a person pressing Cancel. */
  "wallet-rejects",
  /** The demo wallet cannot sign delegate actions, like a wallet without NEP-366 support. */
  "wallet-no-delegate",
  /** The demo relayer answers 403 NOT_SPONSORED to every relay. */
  "relayer-not-sponsored",
  /** The demo relayer cannot be reached at all. */
  "relayer-down",
  /** The demo relayer sponsors another hub. */
  "relayer-wrong-hub",
  /** The demo relayer takes nine seconds to answer, as a real one waiting for NEAR to make its transaction final. */
  "relayer-slow",
  /** The demo relayer answers 429 RATE_LIMITED, as when its daily gas budget is spent. */
  "relayer-rate-limited",
  /** The demo relayer answers 422 CALL_FAILED: its transaction ran and the hub refused the call. Nothing is revoked. */
  "relayer-call-failed",
  /** The demo relayer answers 502 RPC_FAILED with an unknown outcome, and the transaction never lands. */
  "relayer-unknown",
  /** The demo DAO also holds a proposal whose voting period has ended and a call Payminto does not expect. */
  "dao-edge",
  /** The demo hub holds no receipt key for the server and its prepaid storage balance is low, so the operator is warned. */
  "hub-not-ready",
  /** A few seconds after the page opens, the demo server raises an operator alert: a seller settled a voucher it never accepted. */
  "operator-alert",
  /** A few seconds after the page opens, a seller settles its own voucher on the demo hub and the server books it. */
  "seller-settles",
  /** The demo node has its payee check off: Budgets carry no verdicts, and the page checks Payees in this browser. */
  "payee-check-off",
  /** Six seconds after a page subscribes, the Vendor Agent tries a Payee with a warning, so a request arrives live. */
  "payee-request-arrives",
  /** Acme Store has not set up the any-chain checkout: no NEAR account for it, and the method is off. Read on load. */
  "intents-setup",
  /**
   * The any-chain checkout as on a server that runs it live, not set up yet: the settings use the NEAR mainnet wallet
   * connection, played by a second demo wallet. Nothing reaches NEAR or 1Click.
   */
  "intents-live",
] as const;
export type DemoScenario = (typeof DEMO_SCENARIOS)[number];

function read(): Set<string> {
  if (typeof window === "undefined") return new Set();
  captureDemoSwitches();
  try {
    return new Set((window.sessionStorage.getItem(DEMO_KEY) ?? "").split(",").map((s) => s.trim()).filter(Boolean));
  } catch {
    return new Set();
  }
}

/** Whether a demo switch is on for this tab. Read each time, so a new address takes effect without a rebuild. */
export function demo(scenario: DemoScenario): boolean {
  return read().has(scenario);
}
