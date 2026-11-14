/**
 * One mode per server. Test: test tokens (a local or testnet hub, the any-chain checkout simulated), sk_test_ keys.
 * Live: real money (the any-chain checkout on NEAR mainnet, or a mainnet hub), sk_live_ keys. The server says which in
 * /v1/info `mode`; an older server without it is live only on mainnet.
 */
export type ServerMode = "test" | "live";

type InfoLike = {
  network: { id: string; testnet: boolean };
  mode?: { livemode: boolean; any_chain: "off" | "simulated" | "live" } | null;
};

export function serverMode(info: InfoLike): ServerMode {
  if (info.mode) return info.mode.livemode ? "live" : "test";
  return info.network.testnet ? "test" : "live";
}

/** The reason the server gives for the NEAR wallet and Budget methods being off in live mode (apps/node gateway). */
export const LIVE_MODE_LOCKED_REASON = "Off in live mode: the hub runs on a test network, and this server takes only real money from other chains.";

/**
 * A new business's methods as the server will keep them: on a live any-chain server the test-money methods (wallet,
 * voucher) are locked off; anywhere else the rows are returned unchanged.
 */
export function lockedForMode<R extends { method: string; enabled: boolean; locked_reason?: string | null }>(rows: R[], info: InfoLike | undefined): R[] {
  if (!info || info.mode?.any_chain !== "live" || !info.network.testnet) return rows;
  return rows.map((r) => (r.method === "wallet" || r.method === "voucher" ? { ...r, enabled: false, locked_reason: LIVE_MODE_LOCKED_REASON } : r));
}

export type EnvironmentNotice ={ tone: "test" | "live" | "demo"; text: string };

/** The strip under the header on every screen, so nobody takes test money for real money, or real money for a test. */
export function environmentNotice(info: InfoLike, o: { mock?: boolean } = {}): EnvironmentNotice | null {
  if (o.mock) return { tone: "demo", text: "Demo data: this screen shows sample data and nothing touches a chain." };
  if (serverMode(info) === "live") {
    return info.mode?.any_chain === "live" && info.network.testnet
      ? { tone: "live", text: "Live mode: real money. Customers pay from other chains and USDC arrives in your NEAR mainnet account." }
      : { tone: "live", text: "Live mode: real money on NEAR mainnet." };
  }
  const where = info.network.id === "near:sandbox" ? "a local test network" : "NEAR testnet";
  return { tone: "test", text: `Test mode: test tokens on ${where}. No real money moves.` };
}
