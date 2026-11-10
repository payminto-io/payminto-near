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
 * The label on a test-money badge, or null for live money. A sandbox says so; testnet and anything not live read as
 * test money.
 */
export function testMoneyLabel(livemode: boolean, networkId: string | null | undefined): string | null {
  if (livemode && networkId === "near:mainnet") return null;
  if (networkId === "near:sandbox") return "Local sandbox";
  return livemode ? null : "Testnet";
}
