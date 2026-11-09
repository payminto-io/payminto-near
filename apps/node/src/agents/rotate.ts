import type { Database } from "../db/database.ts";
import type { SecretBox } from "./secrets.ts";

export type ReencryptReport = { connections: number; agents: number; current: number; apply: boolean };

/**
 * Re-seals every stored model key and skill provider key with the box's current key version (docs/OPERATIONS.md,
 * "Rotating AGENT_SECRETS_KEY"). One transaction: every row is opened with its own version, sealed with the current
 * one and checked to open again before commit, so a failure changes nothing. Without `apply` it only counts.
 */
export function reencryptSecrets(db: Database, box: SecretBox, o: { apply: boolean }): ReencryptReport {
  const report: ReencryptReport = { connections: 0, agents: 0, current: 0, apply: o.apply };
  db.tx(() => {
    const conns = db.all<{ id: string; merchant_id: string; key_ciphertext: string; key_iv: string; key_tag: string; key_version: number }>(
      "SELECT id, merchant_id, key_ciphertext, key_iv, key_tag, key_version FROM ai_connections WHERE deleted_at IS NULL",
    );
    for (const r of conns) {
      if (r.key_version === box.currentVersion) {
        report.current++;
        continue;
      }
      const binding = { merchantId: r.merchant_id, rowId: r.id };
      const plain = box.open({ ciphertext: r.key_ciphertext, iv: r.key_iv, tag: r.key_tag, version: r.key_version }, binding);
      const s = box.seal(plain, binding);
      if (box.open(s, binding) !== plain) throw new Error(`re-sealed key of ${r.id} does not open`);
      if (o.apply) db.run("UPDATE ai_connections SET key_ciphertext = ?, key_iv = ?, key_tag = ?, key_version = ? WHERE id = ?", s.ciphertext, s.iv, s.tag, s.version, r.id);
      report.connections++;
    }
    const agents = db.all<{ id: string; merchant_id: string; provider_key_ciphertext: string; provider_key_iv: string; provider_key_tag: string; provider_key_version: number }>(
      "SELECT id, merchant_id, provider_key_ciphertext, provider_key_iv, provider_key_tag, provider_key_version FROM agents WHERE provider_key_ciphertext IS NOT NULL",
    );
    for (const r of agents) {
      if (r.provider_key_version === box.currentVersion) {
        report.current++;
        continue;
      }
      const binding = { merchantId: r.merchant_id, rowId: r.id };
      const plain = box.open({ ciphertext: r.provider_key_ciphertext, iv: r.provider_key_iv, tag: r.provider_key_tag, version: r.provider_key_version }, binding);
      const s = box.seal(plain, binding);
      if (box.open(s, binding) !== plain) throw new Error(`re-sealed provider key of ${r.id} does not open`);
      if (o.apply) db.run("UPDATE agents SET provider_key_ciphertext = ?, provider_key_iv = ?, provider_key_tag = ?, provider_key_version = ? WHERE id = ?", s.ciphertext, s.iv, s.tag, s.version, r.id);
      report.agents++;
    }
  });
  return report;
}
