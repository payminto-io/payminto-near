/**
 * The custody wording, in one place so every screen says the same thing (spec: "Dashboard and design"). It names the
 * network the server actually runs on, from its `/v1/info`, and never assumes testnet.
 */

/** The network in words for a sentence: "NEAR testnet", "a local NEAR sandbox". Unknown until the server says. */
export function networkInWords(networkId: string | null | undefined): string {
  switch (networkId) {
    case "near:testnet":
      return "NEAR testnet";
    case "near:mainnet":
      return "NEAR mainnet";
    case "near:sandbox":
      return "a local NEAR sandbox";
    default:
      return "NEAR";
  }
}

/** "Funds are escrowed in an unaudited contract on NEAR testnet". No full stop, so it can end a line or a sentence. */
export function escrowShort(networkId: string | null | undefined): string {
  return `Funds are escrowed in an unaudited contract on ${networkInWords(networkId)}`;
}

/**
 * What a checkout says about where the money goes. A live any-chain server takes only payments from other chains, which
 * NEAR Intents delivers straight to the business's own account on NEAR mainnet: no escrow and no local sandbox, whatever
 * network the server's hub runs on. Every other server names its own network and the hub's escrow.
 */
export function checkoutWords(info: { network: { id: string; name: string }; mode?: { livemode: boolean; any_chain: string } | null } | null | undefined): {
  networkName: string;
  escrowShort: string;
} {
  if (info?.mode?.any_chain === "live") return { networkName: "NEAR mainnet", escrowShort: "Paid through NEAR Intents straight to the business's own account, never held by Payminto" };
  return { networkName: info?.network.name ?? "NEAR", escrowShort: escrowShort(info?.network.id) };
}

export function escrowFull(networkId: string | null | undefined): string {
  const where =
    networkId === "near:sandbox"
      ? " This deployment runs on a local NEAR sandbox: nothing here has value, and the chain is gone when it stops."
      : networkId === "near:testnet"
        ? " This deployment runs on NEAR testnet, so the tokens have no value."
        : "";
  return `Funds are escrowed in an unaudited contract on NEAR. The contract has no method that lets the operator move them, and the submitted hub has no upgrade key.${where}`;
}

/**
 * The label on a test-money badge, or null for live money. A live payment never carries it, whatever chain the server
 * runs its hub on (a live any-chain payment moves real money on NEAR mainnet). Off live mode a sandbox says so, and
 * anything else reads as testnet.
 */
export function testMoneyLabel(livemode: boolean, networkId: string | null | undefined): string | null {
  if (livemode) return null;
  return networkId === "near:sandbox" ? "Local sandbox" : "Testnet";
}
