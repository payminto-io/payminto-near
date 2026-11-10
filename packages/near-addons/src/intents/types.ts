/**
 * 1Click Swap API v0 wire types, transcribed from the OpenAPI document at
 * https://1click.chaindefuser.com/docs/v0/openapi.yaml (fetched 2026-11-10).
 * Only the fields this package reads or sends are typed; the API may return more.
 */

export const ONECLICK_BASE_URL = "https://1click.chaindefuser.com";

/** Circle's native USDC on NEAR mainnet, the asset hub payouts would be in on a mainnet hub. Checked live with `/v0/tokens` and `ft_metadata`. */
export const NEAR_MAINNET_USDC = "17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1";
export const NEAR_MAINNET_USDC_ASSET = `nep141:${NEAR_MAINNET_USDC}`;

export type SwapType = "EXACT_INPUT" | "EXACT_OUTPUT" | "FLEX_INPUT" | "ANY_INPUT";
export type DepositType = "ORIGIN_CHAIN" | "INTENTS" | "CONFIDENTIAL_INTENTS";
export type RefundType = "ORIGIN_CHAIN" | "INTENTS" | "CONFIDENTIAL_INTENTS";
export type RecipientType = "DESTINATION_CHAIN" | "INTENTS" | "CONFIDENTIAL_INTENTS";
export type DepositMode = "SIMPLE" | "MEMO";

/** `TokenResponse`. */
export type OneClickToken = {
  assetId: string;
  decimals: number;
  blockchain: string;
  symbol: string;
  price: number;
  priceUpdatedAt: string;
  contractAddress?: string | null;
  coingeckoId?: string;
};

/** `QuoteRequest`. Required fields per the OpenAPI document, plus the optional ones this package uses. */
export type QuoteRequest = {
  dry: boolean;
  swapType: SwapType;
  /** Basis points, an integer from 0 to 10000. */
  slippageTolerance: number;
  originAsset: string;
  depositType: DepositType;
  destinationAsset: string;
  /** Integer string in the smallest unit of the asset that `swapType` names. */
  amount: string;
  refundTo: string;
  refundType: RefundType;
  recipient: string;
  recipientType: RecipientType;
  /** ISO 8601. Refunds begin if the swap is not done by then. */
  deadline: string;
  depositMode?: DepositMode;
  quoteWaitingTimeMs?: number;
  referral?: string;
  virtualChainRecipient?: string;
  virtualChainRefundRecipient?: string;
  /** Never sent by this package: the docs mark it highly experimental and say funds can be lost. */
  customRecipientMsg?: string;
  appFees?: Array<{ recipient: string; fee: number }>;
  confidentiality?: "public" | "basic" | "advanced";
  insured?: boolean;
};

/** `Quote`. `depositAddress`, `deadline` and `timeWhenInactive` are absent on a dry quote. */
export type Quote = {
  depositAddress?: string;
  depositMemo?: string;
  amountIn: string;
  amountInFormatted: string;
  amountInUsd: string;
  minAmountIn: string;
  amountOut: string;
  amountOutFormatted: string;
  amountOutUsd: string;
  minAmountOut: string;
  deadline?: string;
  timeWhenInactive?: string;
  timeEstimate: number;
  refundFee?: string;
  withdrawFee?: string;
  virtualChainRecipient?: string;
  virtualChainRefundRecipient?: string;
  customRecipientMsg?: string;
};

/** `QuoteResponse`. Keep the whole object: the docs say it is needed to resolve disputes. */
export type QuoteResponse = {
  correlationId: string;
  timestamp: string;
  /** `ed25519:<base58>` from the 1Click manager key. */
  signature: string;
  quoteRequest: QuoteRequest;
  quote: Quote;
};

export type ExecutionStatus = "KNOWN_DEPOSIT_TX" | "PENDING_DEPOSIT" | "INCOMPLETE_DEPOSIT" | "PROCESSING" | "SUCCESS" | "REFUNDED" | "FAILED";

/** States after which the status no longer changes. */
export const TERMINAL_STATUSES: readonly ExecutionStatus[] = ["SUCCESS", "REFUNDED", "FAILED"];

export type TransactionDetails = { hash: string; explorerUrl: string };

/** `SwapDetails`. */
export type SwapDetails = {
  intentHashes: string[];
  nearTxHashes: string[];
  amountIn?: string;
  amountInFormatted?: string;
  amountInUsd?: string;
  amountOut?: string;
  amountOutFormatted?: string;
  amountOutUsd?: string;
  slippage?: number;
  originChainTxHashes: TransactionDetails[];
  destinationChainTxHashes: TransactionDetails[];
  refundedAmount?: string;
  refundedAmountFormatted?: string;
  refundedAmountUsd?: string;
  /** For example `PARTIAL_DEPOSIT`. */
  refundReason?: string;
  depositedAmount?: string;
  depositedAmountFormatted?: string;
  depositedAmountUsd?: string;
  withdrawFee?: string;
  referral?: string;
};

/** `GetExecutionStatusResponse`, and also `SubmitDepositTxResponse`, which has the same shape. */
export type StatusResponse = {
  correlationId: string;
  quoteResponse: QuoteResponse;
  status: ExecutionStatus;
  updatedAt: string;
  swapDetails: SwapDetails;
};

/** `SubmitDepositTxRequest`. */
export type SubmitDepositRequest = {
  txHash: string;
  depositAddress: string;
  /** Used only for NEAR deposits. */
  nearSenderAccount?: string;
  memo?: string;
};
