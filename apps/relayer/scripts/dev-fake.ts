/**
 * Runs the real relayer over real HTTP with an in-memory chain, so the API and the CLI can be tried by hand with no
 * NEAR node, no network and no real key:
 *
 *   pnpm --filter @payminto/relayer dev:fake
 *
 * It also serves a tiny read-only NEAR RPC (access key and block height of the fake chain) for the revoke CLI, writes
 * a throwaway owner key and two sample request bodies to apps/relayer/data/dev-fake (git-ignored, deleted on exit),
 * and prints commands to paste.
 * PORT (default 8790) and FAKE_RPC_PORT (default PORT + 1) move the two listeners.
 */
import { createServer } from "node:http";
import { mkdirSync, rmdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { keypairFromSeed, publicKeyBytes, revokeBudgetTx } from "@payminto/chain";
import { gasless } from "@payminto/near-addons";
import { base58 } from "@scure/base";
import { ConfigError, loadConfig } from "../src/config.ts";
import { FakeRelayChain } from "../src/fake.ts";
import { createLogger } from "../src/logger.ts";
import { publicKeyOfSecret } from "../src/near-chain.ts";
import { startRelayer } from "../src/server.ts";

// Fixed, public test seeds. They exist only for this script and control nothing anywhere.
const secretOf = (seed: Uint8Array): string => {
  const pair = keypairFromSeed(seed);
  const raw = new Uint8Array(64);
  raw.set(seed);
  raw.set(publicKeyBytes(pair.publicKey), 32);
  return `ed25519:${base58.encode(raw)}`;
};
const RELAYER = "relayer.test.near";
const HUB = "hub.test.near";
const OWNER = "alice.test.near";
const BUDGET = "ab".repeat(32);
const relayerSecret = secretOf(new Uint8Array(32).fill(0xa1));
const ownerSeed = new Uint8Array(32).fill(0xa2);
const owner = keypairFromSeed(ownerSeed);

const port = Number(process.env["PORT"] ?? 8790);
const rpcPort = Number(process.env["FAKE_RPC_PORT"] ?? port + 1);
const rpcUrl = `http://127.0.0.1:${rpcPort}`;

let config;
try {
  config = loadConfig({ ...process.env, PORT: String(port), RELAYER_ACCOUNT: RELAYER, RELAYER_KEY: relayerSecret, HUB_ACCOUNT: HUB, NETWORK: "near:sandbox", RPC_URL: rpcUrl });
} catch (err) {
  if (err instanceof ConfigError) {
    process.stderr.write(`${err.message}\n`);
    process.exit(2);
  }
  throw err;
}

const chain = new FakeRelayChain()
  .addKey(RELAYER, publicKeyOfSecret(relayerSecret), 0n)
  .addKey(OWNER, owner.publicKey, 4n)
  .setBalance(RELAYER, 3n * 10n ** 24n);

const relayer = await startRelayer(config, { chain, logger: createLogger({ level: config.logLevel, base: { service: "relayer", chain: "fake" } }), gasLedger: null });

// The two reads the CLI makes, answered from the fake chain. It refuses everything else, sends included.
const rpc = createServer((req, res) => {
  let text = "";
  req.on("data", (c: Buffer) => (text += c.toString("utf8")));
  req.on("end", () => {
    void (async () => {
      const answer = (body: Record<string, unknown>) => res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id: "payminto", ...body }));
      try {
        const call = JSON.parse(text) as { method?: string; params?: { request_type?: string; account_id?: string; public_key?: string } };
        if (call.method === "block") return answer({ result: { header: { height: Number(chain.height) } } });
        if (call.method === "query" && call.params?.request_type === "view_access_key") {
          const key = await chain.accessKey(call.params.account_id ?? "", (call.params.public_key ?? "") as typeof owner.publicKey);
          if (!key) return answer({ error: { name: "HANDLER_ERROR", cause: { name: "UNKNOWN_ACCESS_KEY" }, code: -32000, message: "Server error" } });
          return answer({ result: { nonce: Number(key.nonce), permission: "FullAccess", block_height: Number(chain.height), block_hash: "11111111111111111111111111111111" } });
        }
        return answer({ error: { name: "REQUEST_VALIDATION_ERROR", code: -32601, message: "the fake RPC only answers block and view_access_key" } });
      } catch {
        res.writeHead(400).end("bad request");
      }
    })();
  });
});
await new Promise<void>((resolve, reject) => {
  rpc.once("error", reject);
  rpc.listen(rpcPort, "127.0.0.1", () => resolve());
});

// A fixed, git-ignored place, so the commands in the README can name the files.
const dir = join(dirname(fileURLToPath(import.meta.url)), "..", "data", "dev-fake");
mkdirSync(dir, { recursive: true });
const keyFile = join(dir, "alice.test.near.json");
writeFileSync(keyFile, JSON.stringify({ account_id: OWNER, public_key: owner.publicKey, private_key: secretOf(ownerSeed) }) + "\n", { mode: 0o600 });
const window = { nonce: 5n, maxBlockHeight: chain.height + 120n };
const toHub = gasless.revokeBudgetDelegate({ owner: OWNER, hub: HUB, budgetId: BUDGET, publicKey: owner.publicKey, ...window });
const toOther: gasless.DelegateAction = { ...toHub, receiverId: "usdc.test.near", actions: gasless.fromWalletActions(revokeBudgetTx("usdc.test.near", BUDGET).actions) };
const hubBody = join(dir, "revoke-hub.json");
const otherBody = join(dir, "revoke-other-contract.json");
writeFileSync(hubBody, JSON.stringify(gasless.relayRequestBody(gasless.signDelegate(toHub, ownerSeed))) + "\n");
writeFileSync(otherBody, JSON.stringify(gasless.relayRequestBody(gasless.signDelegate(toOther, ownerSeed))) + "\n");

process.stderr.write(
  [
    "",
    `Payminto relayer on a FAKE chain: ${relayer.url}   (fake NEAR RPC for the CLI: ${rpcUrl})`,
    "Nothing here touches a network. The owner key below is a public test key.",
    "",
    "Try it:",
    `  curl -s ${relayer.url}/info`,
    `  curl -s ${relayer.url}/health`,
    `  curl -s -X POST ${relayer.url}/relay -H 'content-type: application/json' -d @${hubBody}             # 200, relayed`,
    `  curl -s -X POST ${relayer.url}/relay -H 'content-type: application/json' -d @${hubBody}             # 409 NONCE_USED, never sent twice`,
    `  curl -s -X POST ${relayer.url}/relay -H 'content-type: application/json' -d @${otherBody}  # 403 NOT_SPONSORED`,
    `  curl -s -X POST ${relayer.url}/relay -H 'content-type: application/json' -d 'not json'              # 400 MALFORMED`,
    `  head -c 20000 /dev/zero | curl -s -X POST ${relayer.url}/relay -H 'content-type: application/json' --data-binary @-   # 413 PAYLOAD_TOO_LARGE`,
    "",
    "The owner's CLI, first without sending, then for real (against the fake chain):",
    `  pnpm --filter @payminto/relayer revoke --budget ${BUDGET} --owner ${OWNER} --relayer ${relayer.url} --rpc-url ${rpcUrl} --key-file ${keyFile} --dry-run`,
    `  pnpm --filter @payminto/relayer revoke --budget ${BUDGET} --owner ${OWNER} --relayer ${relayer.url} --rpc-url ${rpcUrl} --key-file ${keyFile}`,
    "",
    "Ctrl-C stops it and deletes those files.",
    "",
  ].join("\n"),
);

let stopping = false;
const shutdown = () => {
  if (stopping) process.exit(1);
  stopping = true;
  rpc.close();
  rmSync(dir, { recursive: true, force: true });
  try {
    // Only when this script left it empty: a gas ledger kept in data/ stays.
    rmdirSync(dirname(dir));
  } catch {
    // Not empty, so not ours to remove.
  }
  relayer.stop().then(
    () => process.exit(0),
    () => process.exit(1),
  );
  // No relay is in flight on a fake chain, so there is nothing worth waiting long for.
  setTimeout(() => process.exit(0), 1_000).unref();
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
