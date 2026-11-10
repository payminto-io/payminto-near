import type { AccountId } from "@payminto/protocol";

/** Three companies and a DAO-style treasury. Each owns one Budget: the hub clears one Budget per owner per batch. */
export const OWNER_KEYS = ["acme", "globex", "initech", "dao"] as const;
export type Owner = (typeof OWNER_KEYS)[number];

/** Every account in one run. The simulated hub uses fixed names; a sandbox run names them under its root account. */
export type DemoNames = {
  hub: AccountId;
  token: AccountId;
  /** The node's account: it settles and pays out, and every Budget names it as settler. */
  operator: AccountId;
  owners: Record<Owner, AccountId>;
  /**
   * Who gets paid, or asks to be. Acme and Globex sell to each other, so their obligations offset. Scan is a pure seller.
   * - `alpha`: an account that exists and is registered with the token, and is on no Budget's list. The payee check
   *   has nothing against it, so the rule that refuses it is the Budget's own list.
   * - `fresh`: a new vendor on Globex's list that has not registered with the token, so the payee check warns.
   * - `mirror`: reads like `scans`, is on no list, and does not exist on chain. The payee check blocks it.
   */
  sellers: { quotes: AccountId; briefs: AccountId; scans: AccountId; alpha: AccountId; fresh: AccountId; mirror: AccountId };
};

/** Owner and seller accounts under one parent, for example `testnet` or a sandbox's `test.near`. */
export function namesUnder(parent: string, infra: { hub: AccountId; token: AccountId; operator: AccountId }): DemoNames {
  // Sputnik DAO v2 creates DAOs under its factory account, `sputnik-v2.testnet` on testnet.
  const owners = { acme: `acme.${parent}`, globex: `globex.${parent}`, initech: `initech.${parent}`, dao: `guild.sputnik-v2.${parent}` };
  // `5can` folds to `scan`: the digit five stands in for the letter s.
  return { ...infra, owners, sellers: { quotes: owners.globex, briefs: owners.acme, scans: `scan.${parent}`, alpha: `rogue.${parent}`, fresh: `newdesk.${parent}`, mirror: `5can.${parent}` } };
}

/** The simulated hub's names. Exported as OWNERS and SELLERS for code written against the simulated stack. */
export const FAKE_NAMES = namesUnder("testnet", { hub: "hub.demo.testnet", token: "usdc.demo.testnet", operator: "node.demo.testnet" });
