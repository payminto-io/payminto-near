/**
 * Re-seals the businesses' model API keys and skill provider keys with the current AGENT_SECRETS_KEY version.
 *
 *   pnpm --filter @payminto/node agents:reencrypt            # counts what would change, writes nothing
 *   pnpm --filter @payminto/node agents:reencrypt -- --apply # re-seals, in one transaction
 *
 * Reads the same environment as the node (AGENT_SECRETS_KEY, AGENT_SECRETS_KEY_VERSION, AGENT_SECRETS_KEY_PREVIOUS,
 * DB_PATH). Not destructive: every row is re-sealed and checked to open before the transaction commits, so a wrong
 * key changes nothing. Take a backup first (pnpm backup). Steps in docs/OPERATIONS.md, "Rotating AGENT_SECRETS_KEY".
 */
import { agentsConfigOf, loadConfig } from "../src/config.ts";
import { Database } from "../src/db/database.ts";
import { reencryptSecrets } from "../src/agents/rotate.ts";
import { parseSecretsKey, SecretBox } from "../src/agents/secrets.ts";

const apply = process.argv.includes("--apply");
try {
  const config = loadConfig();
  const a = agentsConfigOf(config);
  if (a.usingDevKey) throw new Error("AGENT_SECRETS_KEY is unset; set the new key (and AGENT_SECRETS_KEY_PREVIOUS with the old one) first");
  const box = new SecretBox(new Map(Object.entries(a.secretsKeys).map(([v, k]) => [Number(v), parseSecretsKey(k)] as const)), a.secretsKeyVersion);
  const db = new Database(config.dbPath);
  try {
    const r = reencryptSecrets(db, box, { apply });
    process.stdout.write(
      `${apply ? "re-sealed" : "would re-seal"} ${r.connections} connection keys and ${r.agents} skill provider keys with key version ${box.currentVersion}; ${r.current} already current\n` +
        (apply ? "" : "run again with --apply to write\n"),
    );
  } finally {
    db.close();
  }
} catch (err) {
  process.stderr.write(`agents:reencrypt failed: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
}
