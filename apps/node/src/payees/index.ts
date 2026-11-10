import { nearBlocksAgeSource, rpcReader, type FetchLike } from "@payminto/payee-check";
import type { AccountId } from "@payminto/protocol";
import { AuditLog } from "../auth/audit.ts";
import { payeeCheckConfigOf, type Config } from "../config.ts";
import type { Database } from "../db/database.ts";
import type { EventBus } from "../events.ts";
import type { Logger } from "../logger.ts";
import { PayeeService, type PayeeCheckSources } from "./service.ts";

export { mountPayees } from "./routes.ts";
export { PayeeService, decidePayee, type PayeeCheckSources, type PayeeCheckJson, type ApprovalJson, type ApprovalRequestJson, type ReportJson } from "./service.ts";

/** The check's sources for a node that reads NEAR itself: read-only RPC on RPC_URL, and NearBlocks for ages when configured. */
export function rpcSources(config: Config, fetchImpl?: FetchLike): PayeeCheckSources {
  const p = payeeCheckConfigOf(config);
  return {
    // The package's reader: on a network's public default endpoint it also tries the second public endpoint, because
    // both are rate limited; a node with its own RPC_URL reads that endpoint and no other.
    reader: rpcReader(config.rpcUrl, fetchImpl ? { fetch: fetchImpl } : {}),
    // Only near:testnet has a public index this node may ask (config.ts refuses the indexer on a local chain).
    ageSource: p.indexer === "nearblocks" ? nearBlocksAgeSource({ network: "testnet", ...(p.indexerKey ? { apiKey: p.indexerKey } : {}) }) : null,
  };
}

/**
 * Builds the payee service once at startup. A node that reads NEAR over RPC checks through RPC_URL. A node handed a
 * chain (tests, the simulated hub) has nothing to read accounts with, so the check is off there unless the caller
 * passes sources of its own.
 */
export function createPayeeService(
  config: Config,
  opts: { injectedChain: boolean; sources?: PayeeCheckSources | null },
  deps: { db: Database; events: EventBus; log: Logger; operator: AccountId; token: AccountId; dashboardUrl: string },
): PayeeService {
  const settings = payeeCheckConfigOf(config);
  const sources = opts.sources !== undefined ? opts.sources : opts.injectedChain ? null : rpcSources(config);
  const service = new PayeeService({ ...deps, audit: new AuditLog(deps.db), config: settings, sources });
  if (service.enabled) deps.log.info("payee check on", { indexer: sources?.ageSource?.name ?? "off" });
  else deps.log.info("payee check off", { because: service.offBecause });
  return service;
}
