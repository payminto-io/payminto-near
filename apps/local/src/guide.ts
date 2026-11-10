import { SANDBOX_CHAIN_ID } from "./config.ts";
import type { Stack } from "./stack.ts";

const pad = (s: string, n: number) => (s.length >= n ? `${s} ` : s.padEnd(n));

/**
 * The short guide printed once everything answers: where things are, who is who, and what to do to see each part of
 * the product work. It never prints a password; it prints where the passwords are.
 */
export function guide(s: Stack): string[] {
  const { urls, paths, accounts, setup } = s;
  const a = accounts.by;
  const rows: Array<[string, string]> = [
    ["Dashboard", urls.dashboard],
    ["Agent remote", `${urls.remote}  (makes paid agent calls; it stands in for an agent's runtime)`],
    ["Logins", `${paths.logins}  (two email and password pairs and one API key; readable by you only)`],
    ["Clearing node", `${urls.node}  (the API; try ${urls.node}/v1/info)`],
    ["Local signer", `${urls.signer}  (DEVELOPMENT ONLY: signs for the local accounts in place of a wallet)`],
    ["Gas relayer", `${urls.relayer}  (pays the gas of a revoke for an owner who has none)`],
    ["NEAR RPC", `${urls.rpc}  (near-sandbox, chain id ${SANDBOX_CHAIN_ID}; your browser reads proofs from here)`],
    ["NEAR Intents", `${urls.oneclick}  (a fake 1Click server: Simulated - no real money; it never calls the live API)`],
    ["Logs", paths.logs],
  ];
  const who: Array<[string, string, string]> = [
    ...accounts.list.map((x): [string, string, string] => [x.accountId, x.role, x.does]),
    [accounts.settler, "Settler", "The node's own account. The node settles and pays out with a key limited to those two calls; the signer does not hold it"],
    [accounts.relayer.accountId, "Gas relayer", "Pays gas for revoke_budget, reclaim and payout on the hub. Only the relayer service holds its key"],
    [accounts.solver, "1Click solver", "Simulated: the fake 1Click server delivers any-chain payments from it with a real ft_transfer. Only the stack holds its key"],
    [accounts.vendor, "New payee", "Exists on chain and never registered with the token: the payee check warns about it, and its payouts wait"],
    [s.hub.names.hub, "Hub", "The Payminto contract from contracts-near/out/hub.wasm, locked: it has no access key"],
    [s.hub.names.token, "Mock USDC", "A mock NEP-141 token that stands in for USDC on this local chain only"],
  ];
  const idWidth = Math.max(...who.map((w) => w[0].length)) + 2;
  const roleWidth = Math.max(...who.map((w) => w[1].length)) + 2;
  const quiet = s.activity === null;

  const steps: string[] = [
    `Sign in. Open ${urls.dashboard}/login and use the "Platform owner" login from the logins file.\n     See Home: ${quiet ? "an empty server with three Budgets waiting for their first call" : "Live Calls, two refused calls with their rule, one settlement and a payment"}.`,
    `Fund a Budget from a local account. Budgets, then "Research agent"; under Escrow type 2 and press Deposit.\n     Read the transaction you are about to sign, confirm, and pick ${a.alice.accountId} in "Local test accounts".\n     See "Final on NEAR" with the transaction hash. Reload the page: "In escrow" is up by 2.00 USDC.`,
    `Make an agent call. Open ${urls.remote}, keep "Research agent" selected and press "Call Bob's Quotes".\n     See "Paid 0.002 USDC" there, and on the dashboard's Home the same call at the top of Live Calls without a reload.`,
    `Trigger a refusal. In the agent remote press "Call Deep Report" (0.25 USDC, over the Budget's 0.05 USDC limit per call).\n     See "Refused by the node" with the rule PER_CALL_CAP, then open Blocked in the dashboard (under Records) and read\n     the reason: the rule, the attempted amount, what is left of the Budget, and "No money moved".`,
    `Approve a payee. In the agent remote press "Call New Vendor". Its payee, ${accounts.vendor}, is on the Budget's list but never\n     registered with the token, so the payee check warns. See "Waiting for the owner" with the rule PAYEE_NEEDS_APPROVAL.\n     Open the Budget's page in the dashboard (the agent remote links to it), press "Approve or deny" under "Waiting for\n     your approval", approve it, call again, and see "Paid 0.003 USDC".`,
    `Settle now. Open "Next settlement" and press "Settle now".\n     See how many transfers the waiting calls would take one by one and how few after offsetting what Alice and Bob\n     owe each other; then, under Settlements, the newest batch with gross cleared next to tokens moved and its transaction.`,
    `Prove a call. On Home, click the amount of a settled call in Live Calls (or Verify under Records, then a recent call).\n     See "Verified on NEAR" and "Read from ${urls.rpc}": your browser read the batch root from the local chain itself.`,
    `Pay a checkout link as the shopper. Open ${setup.link.url}, press "Continue to pay", then "Pay 4.50 USDC",\n     and pick ${a.shopper.accountId}. See "Payment complete" and its payment proof; in the dashboard, Payments shows it as Paid.`,
    `Pay from another chain (NEAR Intents, Simulated - no real money). The checkout's "Any chain" tab is the next\n     dashboard step; until it lands, do what it does with the node's API (P is the payment id the first call returns):\n       curl -s -X POST ${urls.node}/v1/links/public/${setup.link.slug}/payments -H 'content-type: application/json' -d '{}'\n       curl -s ${urls.node}/v1/checkout/P/intents/options          (eight origins, priced from signed quotes)\n       curl -s -X POST ${urls.node}/v1/checkout/P/intents/quotes -H 'content-type: application/json' \\\n            -d '{"origin_asset":"nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near","refund_to":"0x5f2b3a1e9c7d4b6a8f0e1d2c3b4a59687766554f"}'\n       curl -s -X POST ${urls.node}/v1/checkout/P/intents/quotes/Q/simulate -H 'content-type: application/json' -d '{}'\n     (Q is the quote id.) Read GET .../intents/quotes/Q a few times. See its steps go waiting, received, converting,\n     delivered, then "confirmed" with verification "rpc_checked": the node read the delivery on this chain, where\n     ${a.anychain.accountId} received the USDC from ${accounts.solver}. Again with the slug ${setup.anyChain.link.slug} in the first\n     call and {"amount":"1000000"} in simulate: too little, so see the deposit "refunded" and the payment open again.`,
    `Pay out. Open Payouts and press "Pay out now".\n     See the hub credit of ${a.merchant.accountId} (the checkout payment) and of the other creditors arrive in their own accounts,\n     with the payout transaction.`,
    `Revoke a Budget. Budgets, then "Trading agent", then "Revoke on NEAR", signed by ${a.bob.accountId}.\n     See a note with the transaction hash and the Budget marked "Stopped"; in the agent remote, a call from "Trading agent"\n     is now refused with BUDGET_REVOKED.\n     ${a.carol.accountId} holds no NEAR for gas, so her own "Revoke on NEAR" of "Support agent" is turned away by the chain;\n     the gas relayer at ${urls.relayer} is what lets her revoke.`,
  ];

  return [
    "Payminto is running on this machine. Everything below is local: a NEAR node on 127.0.0.1, a mock USDC, and test accounts.",
    "",
    ...rows.map(([k, v]) => `  ${pad(k, 15)}${v}`),
    "",
    "Local accounts. When a step needs a signature, the dashboard shows these in place of a wallet and you pick one:",
    ...who.map(([id, role, does]) => `  ${pad(id, idWidth)}${pad(role, roleWidth)}${does}`),
    "",
    "Try it, in a browser:",
    ...steps.map((t, i) => `  ${String(i + 1).padStart(2)}. ${t}`),
    "",
    `More to try: open a Budget of your own (Budgets, "New Budget", with a spare agent key from the agent remote, signed by ${a.alice.accountId});`,
    `it shows up in the agent remote within a few seconds. The second login in the logins file is the business admin of ${setup.merchant.name}.`,
    "The swarm market is a separate page on its own simulated hub: run pnpm swarm --serve in another terminal and open http://127.0.0.1:4477.",
    "Stopping deletes the chain. The next start begins from a clean database, because this one describes a chain that will be gone.",
  ];
}
