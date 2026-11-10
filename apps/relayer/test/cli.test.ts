/**
 * The owner's CLI against fakes: a fake file system for the key, a fake NEAR RPC for the nonce and height, and the
 * real relayer app over a fake chain behind a fake fetch. Nothing leaves the process.
 */
import { publicKeyBytes } from "@payminto/chain";
import { gasless } from "@payminto/near-addons";
import { base58 } from "@scure/base";
import { describe, expect, it } from "vitest";
import { SubmitError } from "../src/chain.ts";
import { keypairFromSecret } from "../src/cli/keys.ts";
import { runRevoke, type CliFetch, type CliIo } from "../src/cli/revoke.ts";
import { BUDGET, HEIGHT, HUB, OTHER_KEY, OTHER_SEED, OWNER, OWNER_KEY, OWNER_SEED, RELAYER, TGAS, harness, type Harness } from "./helpers.ts";

const secretOf = (seed: Uint8Array, publicKey: typeof OWNER_KEY.publicKey): string => {
  const raw = new Uint8Array(64);
  raw.set(seed);
  raw.set(publicKeyBytes(publicKey), 32);
  return `ed25519:${base58.encode(raw)}`;
};
const OWNER_SECRET = secretOf(OWNER_SEED, OWNER_KEY.publicKey);
const OTHER_SECRET = secretOf(OTHER_SEED, OTHER_KEY.publicKey);
const credentials = (account: string, secret: string, publicKey: string): string => JSON.stringify({ account_id: account, public_key: publicKey, private_key: secret });

const RELAYER_URL = "http://relayer.test";
const RPC_URL = "http://rpc.test";
const HOME = "/home/alice";
const DEFAULT_KEY_PATH = `${HOME}/.near-credentials/testnet/${OWNER}.json`;
const ARGS = ["--budget", BUDGET, "--owner", OWNER, "--relayer", RELAYER_URL, "--rpc-url", RPC_URL];

type World = {
  io: CliIo;
  h: Harness;
  out: string[];
  err: string[];
  /** Every request the CLI made, as `METHOD url` plus the JSON-RPC method for RPC calls. */
  requests: string[];
  files: Map<string, string>;
  /** Overrides an answer of the fake fetch. */
  intercept: (fn: (url: string, method: string) => { status: number; text: string } | Error | undefined) => void;
};

function world(opts: { rpcKeyNonce?: bigint | null; relayerConfig?: Parameters<typeof harness>[0] } = {}): World {
  const h = harness(opts.relayerConfig);
  const out: string[] = [];
  const err: string[] = [];
  const requests: string[] = [];
  const files = new Map<string, string>([[DEFAULT_KEY_PATH, credentials(OWNER, OWNER_SECRET, OWNER_KEY.publicKey)]]);
  let interceptor: Parameters<World["intercept"]>[0] = () => undefined;
  const rpcNonce = opts.rpcKeyNonce === undefined ? 4n : opts.rpcKeyNonce;

  const fetch: CliFetch = async (url, init) => {
    const method = init?.method ?? "GET";
    const rpcMethod = url === RPC_URL && init?.body ? (JSON.parse(init.body) as { method: string; params: { request_type?: string } }) : undefined;
    requests.push(`${method} ${url}${rpcMethod ? ` ${rpcMethod.params.request_type ?? rpcMethod.method}` : ""}`);
    const forced = interceptor(url, method);
    if (forced instanceof Error) throw forced;
    if (forced) return { status: forced.status, text: async () => forced.text };
    if (url === RPC_URL && rpcMethod) {
      if (rpcMethod.method === "send_tx" || rpcMethod.method.startsWith("broadcast")) throw new Error("the CLI must never send a transaction itself");
      const result =
        rpcMethod.method === "block"
          ? { header: { height: Number(HEIGHT) } }
          : rpcNonce === null
            ? undefined
            : { nonce: Number(rpcNonce), permission: "FullAccess", block_height: Number(HEIGHT), block_hash: "x" };
      const body = result ? { jsonrpc: "2.0", id: "payminto", result } : { jsonrpc: "2.0", id: "payminto", error: { cause: { name: "UNKNOWN_ACCESS_KEY" }, message: "Server error" } };
      return { status: 200, text: async () => JSON.stringify(body) };
    }
    if (url.startsWith(RELAYER_URL)) {
      const res = await h.app.request(url.slice(RELAYER_URL.length), { method, headers: init?.headers, ...(init?.body ? { body: init.body } : {}) });
      const text = await res.text();
      return { status: res.status, text: async () => text };
    }
    throw new Error(`unexpected request ${method} ${url}`);
  };

  const io: CliIo = {
    fetch,
    files: {
      readFile: (path) => {
        const text = files.get(path);
        if (text === undefined) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
        return text;
      },
      listDir: (path) => {
        const names = [...files.keys()].filter((p) => p.startsWith(`${path}/`)).map((p) => p.slice(path.length + 1));
        if (names.length === 0) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
        return names;
      },
    },
    homedir: () => HOME,
    out: (line) => out.push(line),
    err: (line) => err.push(line),
  };
  return { io, h, out, err, requests, files, intercept: (fn) => (interceptor = fn) };
}

const noSecrets = (w: World): void => {
  const all = [...w.out, ...w.err, ...w.h.logs].join("\n");
  expect(all).not.toContain(OWNER_SECRET);
  expect(all).not.toContain(OWNER_SECRET.slice(8, 40));
  expect(all).not.toContain(OTHER_SECRET.slice(8, 40));
};

describe("payminto-revoke", () => {
  it("revokes through the relayer: one POST, the owner's key from ~/.near-credentials, the result printed", async () => {
    const w = world();
    const code = await runRevoke(ARGS, w.io);
    expect(w.err).toEqual([]);
    expect(code).toBe(0);
    expect(w.requests).toEqual([`GET ${RELAYER_URL}/info`, `POST ${RPC_URL} view_access_key`, `POST ${RPC_URL} block`, `POST ${RELAYER_URL}/relay`]);

    // What reached the chain is a revoke of that Budget, signed by the owner, with the key's next nonce.
    expect(w.h.chain.submissions).toHaveLength(1);
    const signed = gasless.decodeSignedDelegate(w.h.chain.submissions[0]!);
    expect(gasless.verifySignedDelegate(signed)).toBe(true);
    expect(signed.delegateAction).toMatchObject({ senderId: OWNER, receiverId: HUB, nonce: 5n, maxBlockHeight: HEIGHT + 120n, publicKey: OWNER_KEY.publicKey });
    const action = signed.delegateAction.actions[0] as gasless.DelegateFunctionCall;
    expect(action).toMatchObject({ type: "FunctionCall", methodName: "revoke_budget", gas: 30n * TGAS, deposit: 0n });
    expect(JSON.parse(new TextDecoder().decode(action.args))).toEqual({ budget_id: BUDGET });

    expect(w.out[0]).toBe(`Revoked: Budget ${BUDGET} of ${OWNER}.`);
    expect(w.out[1]).toMatch(/^ {2}transaction: [1-9A-HJ-NP-Za-km-z]{43,44}$/);
    expect(w.out[2]).toBe(`  gas paid by: ${RELAYER}`);
    expect(w.out[3]).toMatch(/^ {2}explorer: {4}https:\/\/testnet\.nearblocks\.io\/txns\//);
    noSecrets(w);
  });

  it("--dry-run prints the decoded delegate and sends nothing", async () => {
    const w = world();
    const code = await runRevoke([...ARGS, "--dry-run"], w.io);
    expect(code).toBe(0);
    expect(w.requests).toEqual([`GET ${RELAYER_URL}/info`, `POST ${RPC_URL} view_access_key`, `POST ${RPC_URL} block`]);
    expect(w.h.chain.submissions).toHaveLength(0);
    const text = w.out.join("\n");
    expect(w.out[0]).toBe("Dry run: nothing was sent. Only GET /info and two read-only RPC queries were made.");
    expect(text).toContain(`sender:           ${OWNER}`);
    expect(text).toContain(`receiver:         ${HUB}`);
    expect(text).toContain(`revoke_budget({"budget_id":"${BUDGET}"})  gas 30 Tgas  deposit 0 yoctoNEAR`);
    expect(text).toContain("nonce:            5");
    expect(text).toContain(`max block height: ${HEIGHT + 120n}`);
    expect(text).toContain(`public key:       ${OWNER_KEY.publicKey}`);
    expect(text).toContain("signature:        valid (not shown)");
    expect(text).toContain(`key file:         ${DEFAULT_KEY_PATH}`);
    expect(text).toContain("run the same command without --dry-run");
    noSecrets(w);
  });

  it("reads the key from --key-file, as a credentials file or as one line", async () => {
    const w = world();
    w.files.clear();
    w.files.set("/keys/alice.json", JSON.stringify({ secret_key: OWNER_SECRET }));
    expect(await runRevoke([...ARGS, "--key-file", "/keys/alice.json", "--dry-run"], w.io)).toBe(0);
    w.files.set("/keys/alice.key", `${OWNER_SECRET}\n`);
    expect(await runRevoke([...ARGS, "--key-file", "/keys/alice.key", "--dry-run"], w.io)).toBe(0);
    expect(w.out.join("\n")).toContain("key file:         /keys/alice.key");
    noSecrets(w);
  });

  it("finds a single key in the per-account credentials directory, and asks which one when there are several", async () => {
    const w = world();
    w.files.clear();
    const dir = `/creds/testnet/${OWNER}`;
    w.files.set(`${dir}/ed25519_a.json`, credentials(OWNER, OWNER_SECRET, OWNER_KEY.publicKey));
    expect(await runRevoke([...ARGS, "--credentials-dir", "/creds", "--dry-run"], w.io)).toBe(0);
    w.files.set(`${dir}/ed25519_b.json`, credentials(OWNER, OTHER_SECRET, OTHER_KEY.publicKey));
    expect(await runRevoke([...ARGS, "--credentials-dir", "/creds", "--dry-run"], w.io)).toBe(1);
    expect(w.err.at(-1)).toContain("holds 2 keys (ed25519_a.json, ed25519_b.json). Choose one with --key-file <path>.");
    noSecrets(w);
  });

  it("looks under localnet for a sandbox relayer", async () => {
    const w = world({ relayerConfig: { network: "near:sandbox" } });
    w.files.clear();
    w.files.set(`${HOME}/.near-credentials/localnet/${OWNER}.json`, credentials(OWNER, OWNER_SECRET, OWNER_KEY.publicKey));
    expect(await runRevoke([...ARGS, "--dry-run"], w.io)).toBe(0);
  });

  it("refuses a secret key on the command line before doing anything, and does not echo it", async () => {
    const w = world();
    for (const argv of [[...ARGS, "--key-file", OWNER_SECRET], [...ARGS, `--key=${OWNER_SECRET}`], [...ARGS, OWNER_SECRET]]) {
      expect(await runRevoke(argv, w.io)).toBe(2);
    }
    expect(w.requests).toEqual([]);
    expect(w.err[0]).toContain("A secret key was passed on the command line");
    expect(w.err[0]).toContain("--key-file <path>");
    noSecrets(w);
  });

  it.each([
    [["--owner", OWNER, "--relayer", RELAYER_URL], "Missing --budget."],
    [[], "Missing --budget, --owner, --relayer."],
    [["--budget", "abc", "--owner", OWNER, "--relayer", RELAYER_URL], "--budget must be the Budget id: 64 lowercase hex characters."],
    [["--budget", BUDGET, "--owner", "Not An Account", "--relayer", RELAYER_URL], "--owner must be a NEAR account id"],
    [["--budget", BUDGET, "--owner", OWNER, "--relayer", "relayer.test"], "--relayer must be an http or https URL"],
    [[...ARGS, "--ttl-blocks", "2"], "--ttl-blocks must be a whole number of at least 10."],
    [[...ARGS, "--send-it"], "Unknown option '--send-it'"],
  ])("explains wrong usage: %j", async (argv, expected) => {
    const w = world();
    expect(await runRevoke(argv, w.io)).toBe(2);
    expect(w.err[0]).toContain(expected);
    expect(w.err[0]).toContain("pnpm --filter @payminto/relayer revoke --budget <id> --owner <account> --relayer <url>");
    expect(w.requests).toEqual([]);
  });

  it("--help prints the usage and exits 0", async () => {
    const w = world();
    expect(await runRevoke(["--help"], w.io)).toBe(0);
    expect(w.out[0]).toContain("payminto-revoke - stop an agent by revoking its Budget");
  });

  it("says where it looked when there is no key, and what is wrong with a bad key file", async () => {
    const w = world();
    w.files.clear();
    expect(await runRevoke(ARGS, w.io)).toBe(1);
    expect(w.err.at(-1)).toContain(`No key for ${OWNER} in ${HOME}/.near-credentials/testnet. Pass --key-file`);

    expect(await runRevoke([...ARGS, "--key-file", "/nope.json"], w.io)).toBe(1);
    expect(w.err.at(-1)).toContain("--key-file /nope.json does not exist");

    w.files.set("/bob.json", credentials("bob.testnet", OWNER_SECRET, OWNER_KEY.publicKey));
    expect(await runRevoke([...ARGS, "--key-file", "/bob.json"], w.io)).toBe(1);
    expect(w.err.at(-1)).toContain(`/bob.json holds a key for bob.testnet, not for ${OWNER}`);

    w.files.set("/broken.json", '{"private_key": "ed25519:zzz"}');
    expect(await runRevoke([...ARGS, "--key-file", "/broken.json"], w.io)).toBe(1);
    expect(w.err.at(-1)).toContain("/broken.json: the secret key must decode to 32 or 64 bytes");

    w.files.set("/empty.json", "{}");
    expect(await runRevoke([...ARGS, "--key-file", "/empty.json"], w.io)).toBe(1);
    expect(w.err.at(-1)).toContain("/empty.json has no private_key field");
    expect(w.requests.filter((r) => r.endsWith("/relay"))).toEqual([]);
    noSecrets(w);
  });

  it("stops before signing when the key is not on the owner's account", async () => {
    const w = world({ rpcKeyNonce: null });
    expect(await runRevoke(ARGS, w.io)).toBe(1);
    expect(w.err.at(-1)).toContain(`(${OWNER_KEY.publicKey}) is not an access key of ${OWNER} on near:testnet`);
    expect(w.requests.filter((r) => r.endsWith("/relay"))).toEqual([]);
  });

  it("explains an unreachable relayer, a URL that is not a relayer, and a relayer that does not pay for revokes", async () => {
    const down = world();
    down.intercept((url) => (url.startsWith(RELAYER_URL) ? new Error("connect ECONNREFUSED 127.0.0.1:8790") : undefined));
    expect(await runRevoke(ARGS, down.io)).toBe(1);
    expect(down.err[0]).toContain(`Could not reach the relayer at ${RELAYER_URL} (connect ECONNREFUSED 127.0.0.1:8790). Check --relayer and that the relayer is running.`);

    const other = world();
    other.intercept((url) => (url === `${RELAYER_URL}/info` ? { status: 200, text: "<html>hello</html>" } : undefined));
    expect(await runRevoke(ARGS, other.io)).toBe(1);
    expect(other.err[0]).toContain("did not answer like a Payminto relayer");

    const narrow = world({ relayerConfig: { methods: ["payout"] } });
    expect(await runRevoke(ARGS, narrow.io)).toBe(1);
    expect(narrow.err[0]).toContain("This relayer does not pay for revoke_budget (it pays for: payout)");
    expect(narrow.requests).toEqual([`GET ${RELAYER_URL}/info`]);
  });

  it("explains an unreachable NEAR RPC", async () => {
    const w = world();
    w.intercept((url) => (url === RPC_URL ? new Error("getaddrinfo ENOTFOUND rpc.test") : undefined));
    expect(await runRevoke(ARGS, w.io)).toBe(1);
    expect(w.err[0]).toContain(`Could not read ${OWNER}'s key from the NEAR RPC at ${RPC_URL}`);
    expect(w.err[0]).toContain("Check --rpc-url");
  });

  it("prints the relayer's refusal with its next step, and exits 1", async () => {
    const w = world();
    w.h.chain.hubRefuses.set("revoke_budget", "NOT_OWNER");
    expect(await runRevoke(ARGS, w.io)).toBe(1);
    expect(w.out).toEqual([]);
    expect(w.err[0]).toMatch(/^Not revoked \(CALL_FAILED\): the hub refused the call in transaction .* NOT_OWNER/);
    expect(w.err[1]).toMatch(/^ {2}transaction: /);
  });

  it("makes an unknown outcome loud and does not call it a failure to revoke again blindly", async () => {
    const w = world();
    w.h.chain.failNextSubmit = new SubmitError("unknown", "timeout", "9sK2zUvbYgq7bhUGkNsrJtQJMdz6aRuC5U3hyGJxR7fH");
    expect(await runRevoke(ARGS, w.io)).toBe(1);
    expect(w.err[0]).toContain("Not revoked (RPC_FAILED)");
    expect(w.err[1]).toBe("  transaction: 9sK2zUvbYgq7bhUGkNsrJtQJMdz6aRuC5U3hyGJxR7fH");
    expect(w.err[2]).toContain("The outcome is unknown: the revoke may still land. Check the Budget on the hub before you try again.");
  });

  it("does not claim either way when the connection to the relayer breaks mid-request", async () => {
    const w = world();
    w.intercept((url, method) => (url === `${RELAYER_URL}/relay` && method === "POST" ? new Error("socket hang up") : undefined));
    expect(await runRevoke(ARGS, w.io)).toBe(1);
    expect(w.err[0]).toContain("The relayer may or may not have received it");
  });
});

describe("keypairFromSecret", () => {
  it("accepts the 64-byte and the 32-byte form and derives the same key", () => {
    expect(keypairFromSecret(OWNER_SECRET).publicKey).toBe(OWNER_KEY.publicKey);
    expect(keypairFromSecret(`ed25519:${base58.encode(OWNER_SEED)}`).publicKey).toBe(OWNER_KEY.publicKey);
  });

  it("refuses a key whose halves do not match, without printing it", () => {
    const mixed = secretOf(OWNER_SEED, OTHER_KEY.publicKey);
    expect(() => keypairFromSecret(mixed)).toThrow("the secret key is damaged");
    try {
      keypairFromSecret(mixed);
    } catch (err) {
      expect((err as Error).message).not.toContain(mixed.slice(8, 30));
    }
    expect(() => keypairFromSecret("secp256k1:abc")).toThrow("not in the form ed25519:<base58>");
  });
});
