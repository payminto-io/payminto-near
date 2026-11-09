// Usage: node run.mjs <SHOT_ID> [--config config.json]
// Example: node run.mjs S26   ->  out/S26-explorer-tour.mp4
import { readFileSync, readdirSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { recordShot, signIn } from "./lib.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const { values, positionals } = parseArgs({ allowPositionals: true, options: { config: { type: "string", default: join(HERE, "config.json") }, keep: { type: "boolean", default: false } } });
const id = (positionals[0] || "").toUpperCase();
const files = readdirSync(join(HERE, "shots")).filter((f) => f.endsWith(".mjs"));
const file = files.find((f) => f.toUpperCase().startsWith(id + "-"));
if (!id || !file) { console.error(`Pick a shot: ${files.map((f) => f.split("-")[0]).join(", ")}`); process.exit(1); }
const shot = await import(pathToFileURL(join(HERE, "shots", file)));
const cfg = JSON.parse(readFileSync(values.config, "utf8"));
// Dashboard sign-in: login.email picks an account from the newest demo run's dashboard-logins.json
// (login.loginsFile "auto"), or from the path given.
let storageState = cfg.login?.storageState || undefined;
if (cfg.login?.email && (shot.needsLogin ?? true)) {
  const repo = join(HERE, "..", "..", "..");
  let file = cfg.login.loginsFile;
  if (!file || file === "auto") {
    const runs = readdirSync(join(repo, "apps", "demo", "data")).filter((d) => d.startsWith("run-")).sort();
    file = join(repo, "apps", "demo", "data", runs.at(-1), "dashboard-logins.json");
  }
  const acct = JSON.parse(readFileSync(file, "utf8")).logins.find((l) => l.email === cfg.login.email);
  if (!acct) { console.error(`No login for ${cfg.login.email} in ${file}`); process.exit(1); }
  storageState = join(HERE, "out", ".auth.json");
  mkdirSync(join(HERE, "out"), { recursive: true });
  await signIn({ baseUrl: cfg.BASE_URL, email: acct.email, password: acct.password, statePath: storageState });
}
const missing = (shot.needs || []).filter((k) => !cfg.ids?.[k] && k !== "BASE_URL");
if (missing.length) { console.error(`${file}: fill ${missing.join(", ")} in ${values.config}`); process.exit(1); }
await recordShot(file.replace(/\.mjs$/, ""), shot.segments(cfg), { keepSegments: values.keep, storageState });
