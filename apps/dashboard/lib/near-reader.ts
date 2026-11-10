/**
 * The NEAR reader this browser checks proofs with: `NearReader` from the chain package, plain `fetch` JSON-RPC at final
 * finality. Live pages read the RPC from config; mock pages read the in-browser demo hub through the same class, so
 * the code path and the screen are the same and only the URL says "demo".
 */
import { NearReadError, NearReader, PUBLIC_RPC_URLS, networks, type AccountId, type Network } from "@payminto/protocol";
import { RPC_URL_OVERRIDE } from "./config";

/** Per request. A proof makes two or three requests, so the page gives up within about half a minute at worst. */
export const READ_TIMEOUT_MS = 8_000;

/** The demo hub's address. Not a network: a page shows it so nobody mistakes the demo for NEAR. */
export const DEMO_RPC_URL = "demo:in-browser-hub";

/** `fetch` is the transport the reader uses when it is not the browser's own: the demo hub's in mock mode. */
export type ReaderSource = { reader: NearReader; demo: boolean; fetch?: typeof fetch };

/**
 * Which RPC proofs are read from: the configured one, else the node's own only on a local sandbox, else the network's
 * public RPC. A remote node never picks the RPC its own claims are checked against.
 */
export function proofRpcUrl(network: Network, nodeRpcUrl?: string | null): string | null {
  if (RPC_URL_OVERRIDE) return RPC_URL_OVERRIDE;
  if (network === "near:sandbox") return nodeRpcUrl || networks[network]?.rpcUrl || null;
  return networks[network]?.rpcUrl ?? PUBLIC_RPC_URLS[network] ?? null;
}

export function liveReader(network: Network, hub: AccountId, nodeRpcUrl?: string | null): ReaderSource | null {
  const rpcUrl = proofRpcUrl(network, nodeRpcUrl);
  return rpcUrl ? { reader: new NearReader({ rpcUrl, hub, timeoutMs: READ_TIMEOUT_MS }), demo: false } : null;
}

/** "Read from https://rpc.testnet.near.org" or the demo wording, for the line under a proof. */
export function readerLabel(s: ReaderSource): string {
  return s.demo ? "the demo hub in this browser (no network)" : s.reader.rpcUrl.replace(/^https?:\/\//, "");
}

/** One sentence for a read that did not finish. Never says the proof failed: nothing was proven either way. */
export function readErrorText(e: unknown): string {
  if (e instanceof NearReadError) {
    switch (e.kind) {
      case "timeout":
        return "NEAR did not answer in time. Nothing was proven either way; try again.";
      case "unavailable":
        return "The NEAR RPC could not be reached or is rate limiting. Nothing was proven either way; try again.";
      case "not_found":
        return "The hub account does not exist on this network. The server and this page disagree about the network or the hub.";
      case "contract_error":
        return `The hub refused the read${e.hubCode ? ` with ${e.hubCode}` : ""}.`;
      case "invalid_response":
        return "The RPC answered with something this page does not understand.";
    }
  }
  return e instanceof Error ? e.message : String(e);
}
