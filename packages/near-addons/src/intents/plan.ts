import { isAccountId, storageDepositTx, type FunctionCallAction, type WalletTx } from "@payminto/chain";
import { verifyQuoteSignature } from "./signature.ts";
import type { QuoteRequest, QuoteResponse } from "./types.ts";

const TGAS = 1_000_000_000_000n;

/** What the exit asks 1Click for. Amounts are atomic units of the origin token. */
export type ExitRequest = {
  /** NEP-141 contract of the origin token on NEAR mainnet, for example native USDC. */
  originToken: string;
  /** 1Click asset id to receive, for example `nep141:base-0x8335...omft.near` for USDC on Base. */
  destinationAsset: string;
  amount: bigint;
  /** Address on the destination chain, in that chain's format. */
  recipient: string;
  /** The NEAR account that sends the deposit and receives refunds. It must already exist on mainnet. */
  refundTo: string;
  /** Basis points, default 100 (1%). */
  slippageBps?: number;
  /** How long 1Click keeps the deposit address live before refunding, default 30 minutes. */
  ttlMs?: number;
  dry: boolean;
};

/** Builds the `QuoteRequest`: EXACT_INPUT from a NEAR origin, delivered on the destination chain, refunded on NEAR. */
export function exitQuoteRequest(r: ExitRequest, now: number = Date.now()): QuoteRequest {
  if (!isAccountId(r.originToken)) throw new Error("originToken must be a NEAR account id");
  if (!isAccountId(r.refundTo)) throw new Error("refundTo must be a NEAR account id");
  if (r.amount <= 0n) throw new Error("amount must be positive");
  const slippage = r.slippageBps ?? 100;
  if (!Number.isInteger(slippage) || slippage < 0 || slippage > 10_000) throw new Error("slippage must be an integer from 0 to 10000 basis points");
  if (!r.recipient) throw new Error("recipient is required");
  return {
    dry: r.dry,
    swapType: "EXACT_INPUT",
    slippageTolerance: slippage,
    originAsset: `nep141:${r.originToken}`,
    depositType: "ORIGIN_CHAIN",
    destinationAsset: r.destinationAsset,
    amount: r.amount.toString(),
    refundTo: r.refundTo,
    refundType: "ORIGIN_CHAIN",
    recipient: r.recipient,
    recipientType: "DESTINATION_CHAIN",
    deadline: new Date(now + (r.ttlMs ?? 30 * 60_000)).toISOString(),
  };
}

/** NEP-145 registration of the deposit address at the origin token, read with `storage_balance_of`. */
export type Registration = { registered: true } | { registered: false; minDeposit: string } | { registered: "unknown"; minDeposit: string };

export type ExitPlan = {
  /** The one transaction the human signs from `sender`'s own wallet on NEAR mainnet. */
  tx: WalletTx;
  sender: string;
  depositAddress: string;
  amountIn: string;
  /** Lowest output after slippage, in atomic units of the destination asset. */
  minAmountOut: string;
  deadline: string;
  /** Problems that make the plan unsafe to send. Empty means the checks passed. */
  refusals: string[];
};

export type PlanOptions = {
  /** Only for tests with a synthetic quote. */
  managerPublicKey?: string;
  now?: number;
};

/**
 * Turns a wet quote into the exact NEAR transfer the human must sign, after checking that the quote is signed by 1Click
 * and says what was asked. The transfer is `ft_transfer` of `amountIn` to the deposit address, which is what the NEAR
 * agent-skills `deposit-near` rule shows. A `storage_deposit` with `registration_only` runs first in the same transaction
 * when the deposit address may not be registered at the token, because `ft_transfer` to an unregistered account fails.
 */
export function exitPlan(asked: QuoteRequest, res: QuoteResponse, sender: string, reg: Registration, opts: PlanOptions = {}): ExitPlan {
  const refusals: string[] = [];
  const got = res.quoteRequest;
  const q = res.quote;
  const now = opts.now ?? Date.now();

  if (!verifyQuoteSignature(res, opts.managerPublicKey)) refusals.push("the quote signature does not verify against the 1Click manager key");
  if (got.dry) refusals.push("this is a dry quote; it has no deposit address");
  for (const k of ["swapType", "originAsset", "depositType", "destinationAsset", "amount", "recipient", "recipientType", "refundTo", "refundType"] as const) {
    if (got[k] !== asked[k]) refusals.push(`quoteRequest.${k} is ${JSON.stringify(got[k])}, but ${JSON.stringify(asked[k])} was asked`);
  }
  if (got.slippageTolerance > asked.slippageTolerance) refusals.push("quoted slippage is above what was asked");
  if (got.customRecipientMsg !== undefined) refusals.push("quote carries customRecipientMsg, which the docs say can lose funds");
  if (!isAccountId(sender)) refusals.push("sender must be a NEAR account id");
  if (got.refundTo !== sender) refusals.push("refundTo must be the sender, so a refund returns to the wallet that paid");
  const token = got.originAsset.startsWith("nep141:") ? got.originAsset.slice("nep141:".length) : "";
  if (!isAccountId(token)) refusals.push("originAsset must be a nep141 token on NEAR");
  const depositAddress = q.depositAddress ?? "";
  if (!isAccountId(depositAddress)) refusals.push("quote has no NEAR deposit address");
  if (q.depositMemo) refusals.push("quote needs a deposit memo, which a NEAR ft_transfer cannot carry");
  if (got.swapType === "EXACT_INPUT" && q.amountIn !== got.amount) refusals.push("amountIn differs from the requested exact input");
  const deadline = q.deadline ?? got.deadline;
  if (!(Date.parse(deadline) > now)) refusals.push("the quote deadline has passed");

  const actions: FunctionCallAction[] = [];
  if (reg.registered !== true && isAccountId(token)) actions.push(...storageDepositTx(token, depositAddress, reg.minDeposit).actions);
  actions.push({
    type: "FunctionCall",
    params: { methodName: "ft_transfer", args: { receiver_id: depositAddress, amount: q.amountIn }, gas: (30n * TGAS).toString(), deposit: "1" },
  });

  return { tx: { receiverId: token, actions }, sender, depositAddress, amountIn: q.amountIn, minAmountOut: q.minAmountOut, deadline, refusals };
}

const shellQuote = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`;

/** near-cli-rs commands for the same transfer, one per action. A wallet can send `tx` as one transaction instead. */
export function nearCliCommands(plan: ExitPlan): string[] {
  return plan.tx.actions.map((a) => {
    const gasT = (BigInt(a.params.gas) / TGAS).toString();
    const deposit = a.params.deposit === "1" ? "1 yoctoNEAR" : `${a.params.deposit} yoctoNEAR`;
    return [
      "near contract call-function as-transaction",
      plan.tx.receiverId,
      a.params.methodName,
      "json-args",
      shellQuote(JSON.stringify(a.params.args)),
      "prepaid-gas",
      shellQuote(`${gasT}.0 Tgas`),
      "attached-deposit",
      shellQuote(deposit),
      "sign-as",
      plan.sender,
      "network-config mainnet sign-with-keychain send",
    ].join(" ");
  });
}
