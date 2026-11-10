/**
 * Facts about the NEAR AI Agent Market this package relies on. Each one is cited in SOURCES.md with the page it was
 * read from. The market is a third party: these are its values, not Payminto's.
 */

/** The market's origin. REST lives under `/v1`; every listed agent answers on `<handle>.<this host>`. */
export const MARKET_ORIGIN = "https://market.near.ai";

/** The only network the market took x402 payment on when this was written (`GET /.well-known/x402`). */
export const MARKET_NETWORK = "near:mainnet";

/** Native USDC on NEAR mainnet, the asset the market's 402 quotes name. Six decimals. */
export const NEAR_MAINNET_USDC = "17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1";
export const USDC_DECIMALS = 6;

/** The market's documented limit is 60 requests per minute per IP. This client stays under it. */
export const MARKET_REQUESTS_PER_MINUTE = 60;
export const DEFAULT_REQUESTS_PER_MINUTE = 50;

/** Deliverable Markdown: 1 byte to 256 KiB. */
export const MAX_DELIVERABLE_BYTES = 256 * 1024;

/** The market asks workers to poll every 30 to 60 seconds. */
export const DEFAULT_POLL_INTERVAL_MS = 45_000;
export const MIN_POLL_INTERVAL_MS = 5_000;

/** A webhook secret must be at least 32 characters. */
export const MIN_WEBHOOK_SECRET_CHARS = 32;
/** Signed webhooks older or newer than this are refused. */
export const WEBHOOK_TOLERANCE_SECONDS = 300;

/** The paid `ft_transfer` the market's playbook prescribes: 30 Tgas and a deposit of 1 yoctoNEAR. */
export const FT_TRANSFER_GAS = 30_000_000_000_000n;
export const FT_TRANSFER_DEPOSIT = 1n;

/** A quote stays valid for the job window plus ten minutes; the longest window is 30 days. */
export const MAX_QUOTE_TIMEOUT_SECONDS = 30 * 86_400 + 600;

/** Caps on text written by other parties. Longer text is cut, and the cut is flagged. */
export const MAX_JOB_TITLE_CHARS = 300;
export const MAX_JOB_TEXT_CHARS = 32_000;
export const MAX_MESSAGE_CHARS = 8_000;

/** Response size caps, checked while the body is read. */
export const MAX_SMALL_RESPONSE_BYTES = 64 * 1024;
export const MAX_LIST_RESPONSE_BYTES = 2 * 1024 * 1024;

/** The buyer's A2A call blocks for up to about a minute while the agent works. */
export const DEFAULT_TIMEOUT_MS = 15_000;
export const PAID_CALL_TIMEOUT_MS = 75_000;

/** The marketplace categories an agent can register under. */
export const CATEGORIES = [
  "automation",
  "creative",
  "customer_support",
  "data",
  "dev_tools",
  "events",
  "finance",
  "legal_compliance",
  "marketing",
  "operations",
  "research",
  "sales",
  "travel",
  "other",
] as const;
export type Category = (typeof CATEGORIES)[number];

export const LISTING_STATUSES = ["draft", "live", "paused", "archived"] as const;
export type ListingStatus = (typeof LISTING_STATUSES)[number];
