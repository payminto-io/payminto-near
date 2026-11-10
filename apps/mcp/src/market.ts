/**
 * The buyer side of the NEAR AI Agent Market in the wallet: `quote_market_agent` asks a market agent for its price and
 * checks it against the owner's limits before anything is signed.
 *
 * The limits are hard, and they are the package's: Payminto does not settle, hold or route Agent Market jobs. A market
 * hire is paid through the market, on NEAR mainnet, and nothing in this wallet signs or sends a market payment. The
 * tool quotes and decides. There is no tool that pays the market.
 */
import { MarketClient, type QuoteToolDeps } from "@payminto/agent-market";
import { NEAR_RPC_URLS, SETTLEMENT_TOKENS, nearBlocksAgeSource, payeeCheckForNode, rpcReader } from "@payminto/payee-check";

/** What the wallet needs to quote on the market: the client, and the payee check for the account a quote pays. */
export type WalletMarket = {
  client: MarketClient;
  /** Asked about the account the quote pays, which is an account on NEAR mainnet. */
  payeeVerdict?: QuoteToolDeps["payeeVerdict"];
};

/**
 * The payee check for a market quote. The quote pays an account on NEAR mainnet (the market's treasury), so this check
 * reads mainnet, whatever network the wallet's Budget is on. It is read-only: it holds no key and sends nothing.
 */
export function mainnetPayeeVerdict(o: { rpcUrl?: string; indexer: "nearblocks" | "off"; indexerKey?: string }): NonNullable<QuoteToolDeps["payeeVerdict"]> {
  const check = payeeCheckForNode({
    reader: rpcReader(o.rpcUrl ?? NEAR_RPC_URLS.mainnet),
    token: SETTLEMENT_TOKENS.mainnet,
    ...(o.indexer === "nearblocks" ? { ageSource: nearBlocksAgeSource({ network: "mainnet", ...(o.indexerKey ? { apiKey: o.indexerKey } : {}) }) } : {}),
    timeLimitMs: 12_000,
  });
  return ({ account }) => check(null, account, 0n, null);
}

/** The market wiring of the MCP server (main.ts): the live market, and the mainnet payee check when the wallet checks payees. */
export function liveMarket(o: { payeeCheck: { indexer: "nearblocks" | "off"; indexerKey?: string } | null; rpcUrl?: string }): WalletMarket {
  return {
    client: new MarketClient(),
    ...(o.payeeCheck ? { payeeVerdict: mainnetPayeeVerdict({ ...(o.rpcUrl ? { rpcUrl: o.rpcUrl } : {}), indexer: o.payeeCheck.indexer, ...(o.payeeCheck.indexerKey ? { indexerKey: o.payeeCheck.indexerKey } : {}) }) } : {}),
  };
}
