import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { USAGE, runCli } from "../src/cli.ts";
import { NOW, fakeFetch, fixture, paramsOf, type Call } from "./helpers.ts";

const PLAIN = "near-examples.testnet";
const MISSING = "this-account-does-not-exist-zz9.testnet";

type Answer = ReturnType<Parameters<typeof fakeFetch>[0]>;

/** Testnet as recorded: `near-examples.testnet` exists, has keys, is indexed and is not registered with USDC. */
function testnet(over: { rpc?: (call: Call) => Answer | undefined; indexer?: () => Answer } = {}) {
  return fakeFetch((call) => {
    if (call.method === "GET") return over.indexer?.() ?? fixture(call.url.endsWith(PLAIN) ? "indexer/account-known" : "indexer/account-not-indexed");
    const custom = over.rpc?.(call);
    if (custom) return custom;
    const p = paramsOf(call);
    const exists = p.account_id === PLAIN || p.request_type === "call_function";
    if (p.request_type === "view_account") return fixture(exists ? "rpc/view-account-plain" : "rpc/view-account-missing");
    if (p.request_type === "view_access_key_list") return fixture(exists ? "rpc/keys-mixed" : "rpc/keys-missing-account");
    return fixture("rpc/storage-unregistered");
  });
}

async function run(argv: string[], net = testnet()) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await runCli(argv, { fetch: net.fetch, out: (l) => out.push(l), err: (l) => err.push(l), clock: () => NOW, timeoutMs: 50 });
  return { code, out: out.join("\n"), err: err.join("\n"), calls: net.calls };
}

describe("check", () => {
  it("works with nothing but an account: verdict, reasons, what was not checked, and a next step", async () => {
    const r = await run([PLAIN]);
    expect(r.code).toBe(0);
    expect(r.err).toBe("");
    expect(r.out).toContain(`Payee     ${PLAIN}`);
    expect(r.out).toContain("Network   NEAR testnet");
    expect(r.out).toContain("Verdict   WARN - Ask a person first");
    expect(r.out).toContain("  warn  token_unregistered");
    expect(r.out).toContain("  info  account_age");
    expect(r.out).toContain("The account was created on 2022-10-01");
    expect(r.out).toContain("Checked   account state, access keys, account age, token registration");
    expect(r.out).toContain("lookalike names: pass --allowed <a,b,...> with the Budget's payees");
    expect(r.out).toContain("Ask the payee to register with the settlement token, then check again.");
    expect(r.out).toContain("Read-only: nothing was signed or sent.");
  });

  it("accepts the word check in front, as the package script passes it", async () => {
    expect((await run(["check", PLAIN])).out).toContain(`Payee     ${PLAIN}`);
  });

  it("only ever sends read-only queries and GET requests", async () => {
    const r = await run([PLAIN]);
    expect(r.calls.length).toBeGreaterThan(0);
    for (const c of r.calls) {
      if (c.method === "GET") expect(c.url).toBe(`https://api-testnet.nearblocks.io/v3/accounts/${PLAIN}`);
      else expect(c.body).toMatchObject({ method: "query", params: { finality: "final" } });
    }
    const kinds = new Set(r.calls.filter((c) => c.method === "POST").map((c) => paramsOf(c).request_type));
    expect([...kinds].sort()).toEqual(["call_function", "view_access_key_list", "view_account"]);
  });

  it("picks the network from the name, and lets --network override it", async () => {
    const near = await run(["acme.near"]);
    expect(near.out).toContain("Network   NEAR mainnet");
    expect(near.calls.find((c) => c.method === "POST")?.url).toBe("https://rpc.mainnet.near.org");
    expect((await run(["acme.near", "--network", "testnet"])).out).toContain("Network   NEAR testnet");
    expect((await run([PLAIN, "--network=mainnet"])).out).toContain("Network   NEAR mainnet");
  });

  it("prints the verdict as JSON with --json", async () => {
    const r = await run([PLAIN, "--json"]);
    const v = JSON.parse(r.out);
    expect(v).toMatchObject({ verdict: "warn", payee: PLAIN, kind: "named", network: "testnet", ageSource: "nearblocks", checkedAtMs: NOW });
    expect(v.signals[0]).toMatchObject({ id: "token_unregistered", severity: "warn" });
    expect(v.rpcUrls).toEqual(["https://rpc.testnet.near.org", "https://rpc.testnet.fastnear.com"]);
  });

  it("exits 0 for any verdict unless --exit-code is given", async () => {
    expect((await run([PLAIN])).code).toBe(0);
    expect((await run([PLAIN, "--exit-code"])).code).toBe(10);
    expect((await run([MISSING, "--exit-code"])).code).toBe(20);
    expect((await run([PLAIN, "--exit-code", "--token", "none", "--no-indexer"])).code).toBe(0);
  });

  it("catches a lookalike with --allowed", async () => {
    const r = await run(["near-exarnples.testnet", "--allowed", `${PLAIN},other.testnet`]);
    expect(r.out).toContain("Verdict   BLOCK - Do not pay");
    expect(r.out).toContain("block lookalike_payee");
    expect(r.out).toContain(`The name resembles ${PLAIN}`);
  });

  it("skips what it is told to skip", async () => {
    const r = await run([PLAIN, "--token", "none", "--no-indexer"]);
    expect(r.out).toContain("Verdict   ALLOW - No concerns found");
    expect(r.out).toContain("account age: remove --no-indexer to look it up");
    expect(r.out).toContain("token registration: pass --token <account>");
    expect(r.calls.some((c) => c.method === "GET")).toBe(false);
  });
});

describe("check: every failure says what to do next", () => {
  const noTrace = (text: string) => expect(text).not.toMatch(/\n\s+at |Error:|node:internal/);

  it("a name that is not an account id", async () => {
    const r = await run(["Near-Examples.Testnet"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("Verdict   BLOCK - Do not pay");
    expect(r.out).toContain("Kind      Not an account id");
    expect(r.out).toContain("Did you mean near-examples.testnet? Account ids are lowercase.");
    expect(r.calls).toEqual([]);
    const odd = await run(["acme inc!"]);
    expect(odd.out).toContain("An account id looks like acme.testnet or acme.near");
    noTrace(r.out + odd.out);
  });

  it("an account that does not exist", async () => {
    expect((await run([MISSING])).out).toContain("Check the spelling, or try the other network with --network mainnet.");
    expect((await run(["acme"])).out).toContain("Named accounts on testnet usually end in .testnet. Did you mean acme.testnet?");
    expect((await run(["acme.near", "--network", "testnet"])).out).toContain("This looks like a mainnet name. Try again with --network mainnet.");
    expect((await run(["acme.testnet", "--network", "mainnet"])).out).toContain("This looks like a testnet name. Try again with --network testnet.");
  });

  it("RPC down: tries the backup endpoint, then blocks and says how to go on", async () => {
    const down = testnet({
      rpc: () => {
        throw new Error("getaddrinfo ENOTFOUND");
      },
    });
    const r = await run([PLAIN], down);
    expect(r.code).toBe(0);
    expect(r.err).toBe("");
    expect(r.out).toContain("Verdict   BLOCK - Do not pay");
    expect(r.out).toContain("block check_failed");
    expect(r.out).toContain("No public RPC endpoint answered (near-rpc: network). Check your connection and try again, or pass your own endpoint with --rpc-url <url>.");
    expect(down.calls.filter((c) => c.method === "POST").map((c) => c.url)).toEqual(["https://rpc.testnet.near.org", "https://rpc.testnet.fastnear.com"]);
    noTrace(r.out);
  });

  it("first RPC endpoint down: the backup answers and the user sees a normal verdict", async () => {
    const flaky = testnet({ rpc: (call) => (call.url.includes("near.org") ? { status: 503, body: "" } : undefined) });
    expect((await run([PLAIN], flaky)).out).toContain("Verdict   WARN");
  });

  it("a custom RPC endpoint that hangs", async () => {
    const r = await run([PLAIN, "--rpc-url", "https://my-rpc.example.test"], testnet({ rpc: () => "hang" }));
    expect(r.out).toContain("The RPC endpoint https://my-rpc.example.test did not answer (near-rpc: timeout). Check the URL, or leave --rpc-url out to use the public endpoints.");
  });

  it("indexer unavailable: warns, does not guess the age, and offers two ways on", async () => {
    const r = await run([PLAIN, "--token", "none"], testnet({ indexer: () => ({ status: 429, body: "" }) }));
    expect(r.out).toContain("Verdict   WARN");
    expect(r.out).toContain("Part of the check could not be completed: age.");
    expect(r.out).toContain("The account age could not be read from NearBlocks (nearblocks: http). Try again in a minute, or pass --no-indexer to skip the age lookup.");
    expect(r.out).not.toContain("account_age");
    noTrace(r.out);
  });

  it("a token that is not a token contract", async () => {
    const r = await run([PLAIN, "--token", "not-a-token.testnet", "--no-indexer"], testnet({ rpc: (c) => (paramsOf(c).request_type === "call_function" ? fixture("rpc/call-no-contract") : undefined) }));
    expect(r.out).toContain("Token registration could not be read (near-rpc: no_contract). Check that --token names a token contract on testnet, or pass --token none.");
  });

  it("mistakes on the command line: one line on what to do, exit 2, no trace", async () => {
    const cases: Array<[string[], RegExp]> = [
      [[], /Name the account to check, for example: pnpm --filter @payminto\/payee-check check near-examples\.testnet/],
      [["a.testnet", "b.testnet"], /Check one account at a time/],
      [[PLAIN, "--netwrok", "testnet"], /Unknown option --netwrok\. Run with --help/],
      [[PLAIN, "--network", "devnet"], /--network must be testnet or mainnet/],
      [[PLAIN, "--network"], /--network needs a value/],
      [[PLAIN, "--rpc-url", "rpc.testnet.near.org"], /--rpc-url must be an http\(s\) URL, for example/],
      [[PLAIN, "--token", "USDC"], /--token must be a NEAR account id, or none/],
      [[PLAIN, "--allowed", "ok.testnet,Not Ok"], /"Not Ok" is not an account id/],
      [[PLAIN, "--reason", "looks bad"], /--reason belongs to report, not check\. To file a report: pnpm --filter/],
    ];
    for (const [argv, message] of cases) {
      const r = await run(argv);
      expect(r.code, argv.join(" ")).toBe(2);
      expect(r.err).toMatch(message);
      expect(r.err).toContain("Run with --help for all options.");
      expect(r.out).toBe("");
      noTrace(r.err);
    }
  });

  it("prints usage on --help", async () => {
    for (const argv of [["--help"], ["-h"], ["help"]]) expect(await run(argv)).toMatchObject({ code: 0, out: USAGE, err: "" });
  });
});

describe("report and --store", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "payee-check-cli-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const reportArgs = (reporter: string) => ["report", PLAIN, "--store", dir, "--reporter", reporter, "--reason", "Took payment, sent nothing.", "--evidence", "https://example.com/proof"];

  it("records reports in a local file, and check then uses them", async () => {
    const first = await run(reportArgs("alice.testnet"));
    expect(first.code).toBe(0);
    expect(first.out).toContain(`Recorded the report by alice.testnet against ${PLAIN}`);
    expect(first.out).toContain("Nothing was sent anywhere.");
    expect(first.calls).toEqual([]);

    const warned = await run([PLAIN, "--store", dir, "--token", "none"]);
    expect(warned.out).toContain("warn  reported");
    expect(warned.out).toContain('alice.testnet: "Took payment, sent nothing."  [link: https://example.com/proof]');
    expect(warned.out).toContain("Reports (claims by third parties, quoted as written)");

    await run(reportArgs("bob.testnet"));
    await run(["report", PLAIN, "--store", dir, "--reporter", "carol.testnet", "--reason", "Same here.", "--evidence", "4jM2fCA16gw1sjwP5Bdboj5e17QXpKfruxLLiNNYbpyx"]);
    const blocked = await run([PLAIN, "--store", dir, "--token", "none"]);
    expect(blocked.out).toContain("Verdict   BLOCK - Do not pay");
    expect(blocked.out).toContain("block reported_by_several");
    expect(JSON.parse(await readFile(join(dir, "blocklist.json"), "utf8")).reports).toHaveLength(3);
  });

  it("remembers code between runs in the store", async () => {
    await run([PLAIN, "--store", dir]);
    expect(JSON.parse(await readFile(join(dir, "code-seen.json"), "utf8")).accounts[PLAIN]).toMatchObject({ contractId: null, changedAtMs: null });
    expect((await run([PLAIN, "--store", dir])).out).toContain("Checked   account state, access keys, account age, code changes, token registration, shared blocklist");
  });

  it("explains a rejected report and a damaged store", async () => {
    const bad = await run(["report", PLAIN, "--store", dir, "--reporter", "alice.testnet", "--reason", "x".repeat(300), "--evidence", "ftp://example.com"]);
    expect(bad.code).toBe(1);
    expect(bad.err).toMatch(/^The report was not saved: invalid report \(/);
    expect(bad.err).toContain("the reason one line of at most 280 characters, and the evidence an https URL or a transaction hash");

    const missing = await run(["report", PLAIN, "--store", dir]);
    expect(missing.code).toBe(2);
    expect(missing.err).toMatch(/report needs --evidence\. Example: pnpm --filter @payminto\/payee-check report scam\.testnet/);

    await writeFile(join(dir, "blocklist.json"), "{ damaged");
    const damaged = await run([PLAIN, "--store", dir, "--token", "none"]);
    expect(damaged.out).toContain("Part of the check could not be completed: reports.");
    expect(damaged.out).toContain(`The store in ${dir} could not be read (the blocklist could not be read). Fix or remove the file, or pass another --store.`);
    const refused = await run(reportArgs("dave.testnet"));
    expect(refused.code).toBe(1);
    expect(refused.err).toMatch(/^The store could not be used: .*blocklist\.json is not JSON\. Check that the directory is writable/);
  });
});
