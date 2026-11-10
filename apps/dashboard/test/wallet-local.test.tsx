import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { depositBudgetTx, revokeBudgetTx } from "@payminto/protocol";
import { localSigner } from "@/lib/config";
import { WalletError } from "@/lib/wallet";
import { localSignerDriver, type LocalAccount, type LocalDriverDeps, type PickRequest } from "@/lib/wallet-local";
import { LocalAccountPicker, nearText } from "@/components/app/local-account-picker";
import { okOutcome } from "./fake-wallet";

const SIGNER = { url: "http://127.0.0.1:4211", token: "run-token" };
const ALICE = "alice.test.near";
const SHOPPER = "shopper.test.near";
const ACCOUNTS: LocalAccount[] = [
  { accountId: ALICE, role: "Budget owner", does: "Owns the Budget of the research agent", publicKey: "ed25519:a", balances: { near: "19940000000000000000000000", usdc: "495000000" } },
  { accountId: SHOPPER, role: "Shopper", does: "Pays checkout links from a wallet", publicKey: "ed25519:s", balances: { near: "9990000000000000000000000", usdc: "195500000" } },
];
const TX = depositBudgetTx("usdc.test.near", "hub.test.near", "ab".repeat(32), 2_000_000n);

type Call = { url: string; method: string; headers: Record<string, string>; body: Record<string, unknown> | null };

/** A signer that answers like apps/local's, and records what it was asked. */
function signer(over: { accounts?: unknown; status?: number; outcomes?: unknown[] } = {}) {
  const calls: Call[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null;
    calls.push({ url, method: init?.method ?? "GET", headers: Object.fromEntries(new Headers(init?.headers).entries()), body });
    const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { "content-type": "application/json" } });
    if (over.status) return json({ error: { code: "X", message: "refused for the test" } }, over.status);
    if (url.endsWith("/v1/accounts")) return json(over.accounts ?? { development_only: true, network: "near:sandbox", accounts: ACCOUNTS });
    if (url.endsWith("/v1/sign-and-send")) return json({ outcomes: over.outcomes ?? (body!.transactions as unknown[]).map((_, i) => okOutcome(`hash${i + 1}`)) });
    if (url.endsWith("/v1/sign-message")) return json({ accountId: body!.accountId, publicKey: "ed25519:a", signature: "c2lnbmF0dXJl" });
    if (url.endsWith("/v1/sign-delegate")) return json({ accountId: body!.accountId, publicKey: "ed25519:a", receiverId: "hub.test.near", signedDelegate: "ZA==", maxBlockHeight: "400", nonce: "9" });
    return json({ error: { code: "NOT_FOUND", message: "no route" } }, 404);
  };
  return { calls, fetchImpl };
}

function memoryStorage(initial: Record<string, string> = {}) {
  const m = new Map(Object.entries(initial));
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k), map: m };
}

function driver(o: { pick?: (req: PickRequest) => string | null; network?: string; deps?: Partial<LocalDriverDeps>; signer?: ReturnType<typeof signer> } = {}) {
  const s = o.signer ?? signer();
  const picks: PickRequest[] = [];
  const notes: Array<{ account: string; hash: string; ok: boolean }> = [];
  const storage = memoryStorage();
  const at = { page: "/budgets/abc" };
  const d = localSignerDriver(SIGNER, {
    page: () => at.page,
    watchMs: 0,
    fetch: s.fetchImpl,
    pick: async (req) => {
      picks.push(req);
      return o.pick ? o.pick(req) : (req.expected ?? ALICE);
    },
    serverNetwork: async () => o.network ?? "near:sandbox",
    notify: (n) => notes.push(n),
    storage,
    ...o.deps,
  });
  return { d, s, picks, notes, storage, at };
}

afterEach(cleanup);

describe("when the local signer is on", () => {
  it("is on only for the sandbox network with a loopback signer and a token", () => {
    expect(localSigner("sandbox", "http://127.0.0.1:4211", "tok")).toEqual({ url: "http://127.0.0.1:4211", token: "tok" });
    expect(localSigner("sandbox", "http://localhost:4211/", "tok")).toEqual({ url: "http://localhost:4211", token: "tok" });
  });

  it.each([
    ["testnet", "http://127.0.0.1:4211", "tok"],
    ["mainnet", "http://127.0.0.1:4211", "tok"],
    [undefined, "http://127.0.0.1:4211", "tok"],
    ["", "http://127.0.0.1:4211", "tok"],
    ["sandbox", undefined, "tok"],
    ["sandbox", "http://127.0.0.1:4211", undefined],
    ["sandbox", "https://signer.example.com", "tok"],
    ["sandbox", "http://192.168.1.20:4211", "tok"],
    ["sandbox", "http://127.0.0.1.evil.example:4211", "tok"],
    ["sandbox", "not a url", "tok"],
  ])("is off for network %s, signer %s", (network, url, token) => {
    expect(localSigner(network, url, token)).toBeNull();
  });

  it("is off in mock mode whatever else is set", () => {
    expect(localSigner("sandbox", "http://127.0.0.1:4211", "tok", true)).toBeNull();
  });
});

describe("the local signer driver", () => {
  it("connects through the account picker and remembers the choice", async () => {
    const { d, picks, storage, s } = driver({ pick: () => SHOPPER });
    const seen: Array<string | null> = [];
    d.onAccountChange((a) => seen.push(a));
    expect(await d.account()).toBeNull();
    expect(await d.connect()).toBe(SHOPPER);
    expect(picks[0]).toMatchObject({ accounts: ACCOUNTS, expected: undefined, current: null });
    expect(await d.account()).toBe(SHOPPER);
    expect(JSON.parse(storage.map.get("payminto.local.account")!)).toEqual({ account: SHOPPER, page: "/budgets/abc" });
    expect(seen).toEqual([SHOPPER]);
    expect(s.calls[0]).toMatchObject({ url: "http://127.0.0.1:4211/v1/accounts", method: "GET" });
    expect(s.calls[0]!.headers.authorization).toBe("Bearer run-token");
    await d.disconnect();
    expect(await d.account()).toBeNull();
    expect(seen).toEqual([SHOPPER, null]);
  });

  it("tells the picker which account the screen needs", async () => {
    const { d, picks } = driver();
    await d.connect(ALICE);
    expect(picks[0]!.expected).toBe(ALICE);
  });

  it("treats a closed picker as the person's own choice, not an error", async () => {
    const { d } = driver({ pick: () => null });
    const err = await d.connect().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(WalletError);
    expect((err as WalletError).kind).toBe("rejected");
    expect(await d.account()).toBeNull();
  });

  it("after a reload, restores the account chosen on this page, only while the signer still has it", async () => {
    const stored = (account: string, page = "/budgets/abc") => memoryStorage({ "payminto.local.account": JSON.stringify({ account, page }) });
    const still = driver({ deps: { storage: stored(ALICE) } });
    expect(await still.d.account()).toBe(ALICE);
    expect(still.picks).toHaveLength(0);
    const gone = driver({ deps: { storage: stored("old.test.near") } });
    expect(await gone.d.account()).toBeNull();
    const elsewhere = driver({ deps: { storage: stored(ALICE, "/pay/pay_1") } });
    expect(await elsewhere.d.account()).toBeNull();
    // The account chosen elsewhere is still offered as the last one used.
    await elsewhere.d.connect();
    expect(elsewhere.picks[0]!.current).toBe(ALICE);
    const garbage = driver({ deps: { storage: memoryStorage({ "payminto.local.account": "alice.test.near" }) } });
    expect(await garbage.d.account()).toBeNull();
  });

  it("forgets the choice when the page changes, tells the screen, and asks again before it signs", async () => {
    // The person picks the owner on the Budget page, and the shopper when the checkout page asks.
    let asked = 0;
    const { d, at, picks, s } = driver({ pick: () => (++asked === 1 ? ALICE : SHOPPER) });
    const seen: Array<string | null> = [];
    d.onAccountChange((a) => seen.push(a));
    await d.connect();
    expect(await d.account()).toBe(ALICE);
    // The person opens a checkout page: the owner chosen on the Budget page must not pay there unasked.
    at.page = "/pay/pay_123";
    expect(await d.account()).toBeNull();
    expect(seen).toEqual([ALICE, null]);
    await d.signAndSendTransaction(TX);
    expect(picks).toHaveLength(2);
    expect(picks[1]).toMatchObject({ current: ALICE });
    expect(s.calls.find((c) => c.url.endsWith("/v1/sign-and-send"))!.body).toMatchObject({ accountId: SHOPPER });
    // On the same page the choice stands for the next signature.
    await d.signAndSendTransaction(TX);
    expect(picks).toHaveLength(2);
  });

  it("signs and sends as the chosen account on near:sandbox, and reports each transaction as run on a local node", async () => {
    const { d, s, notes } = driver();
    await d.connect(ALICE);
    const outcomes = await d.signAndSendTransactions([TX, revokeBudgetTx("hub.test.near", "ab".repeat(32))]);
    expect(outcomes.map((o) => o.transaction?.hash)).toEqual(["hash1", "hash2"]);
    const sent = s.calls.find((c) => c.url.endsWith("/v1/sign-and-send"))!;
    expect(sent.body).toMatchObject({ network: "near:sandbox", accountId: ALICE });
    expect((sent.body!.transactions as unknown[])[0]).toEqual(JSON.parse(JSON.stringify(TX)));
    expect(notes).toEqual([
      { account: ALICE, hash: "hash1", ok: true },
      { account: ALICE, hash: "hash2", ok: true },
    ]);
    expect((await d.signAndSendTransaction(TX)).transaction?.hash).toBe("hash1");
  });

  it("signs a NEP-413 message with the nonce in base64 and a NEP-366 delegate", async () => {
    const { d, s, picks } = driver();
    await d.connect(ALICE);
    // A message always asks who signs, and the account it names is the one the picker marks as needed.
    const message = `Payminto payout change new ${SHOPPER} 1794290000 network near:sandbox hub hub.test.near`;
    const signed = await d.signMessage({ message, recipient: "hub.test.near", nonce: new Uint8Array(32).fill(1) });
    expect(picks.at(-1)).toMatchObject({ expected: SHOPPER, current: ALICE });
    expect(signed).toEqual({ accountId: SHOPPER, publicKey: "ed25519:a", signature: "c2lnbmF0dXJl" });
    const msg = s.calls.find((c) => c.url.endsWith("/v1/sign-message"))!;
    expect(msg.body).toMatchObject({ network: "near:sandbox", accountId: SHOPPER, message, recipient: "hub.test.near", nonce: btoa(String.fromCharCode(...new Uint8Array(32).fill(1))) });
    await d.connect(ALICE);
    const delegate = await d.signDelegateAction(revokeBudgetTx("hub.test.near", "ab".repeat(32)));
    expect(delegate).toMatchObject({ accountId: ALICE, signedDelegate: "ZA==", maxBlockHeight: "400" });
  });

  it("asks for an account before it signs anything, and signs nothing when the picker is closed", async () => {
    const { d, s, picks } = driver({ pick: () => null });
    const err = await d.signAndSendTransaction(TX).catch((e: unknown) => e);
    expect((err as WalletError).kind).toBe("rejected");
    expect(picks).toHaveLength(1);
    expect(s.calls.some((c) => c.url.endsWith("/v1/sign-and-send"))).toBe(false);
  });

  it.each(["near:testnet", "near:mainnet", ""])("shows no account and signs nothing when the server behind the dashboard is on %s", async (network) => {
    const { d, s, picks } = driver({ network });
    const err = await d.connect().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(WalletError);
    expect((err as WalletError).kind).toBe("unavailable");
    expect((err as WalletError).message).toContain("local sandbox");
    expect(picks).toHaveLength(0);
    expect(s.calls).toHaveLength(0);
  });

  it("refuses a service that does not say it is a sandbox development signer", async () => {
    for (const accounts of [{ network: "near:testnet", development_only: true, accounts: ACCOUNTS }, { network: "near:sandbox", accounts: ACCOUNTS }]) {
      const { d, picks } = driver({ signer: signer({ accounts }) });
      const err = await d.connect().catch((e: unknown) => e);
      expect((err as WalletError).kind).toBe("unavailable");
      expect(picks).toHaveLength(0);
    }
  });

  it("says in plain words when the signer is gone or was restarted", async () => {
    const down = driver({ deps: { fetch: async () => Promise.reject(new TypeError("Failed to fetch")) } });
    expect(((await down.d.connect().catch((e: unknown) => e)) as WalletError).message).toMatch(/pnpm local is still running/);
    const restarted = driver({ signer: signer({ status: 401 }) });
    expect(((await restarted.d.connect().catch((e: unknown) => e)) as WalletError).message).toMatch(/Reload the page/);
    const refused = driver();
    await refused.d.connect(ALICE);
    const failing = localSignerDriver(SIGNER, { fetch: signer({ status: 422 }).fetchImpl, pick: async () => ALICE, serverNetwork: async () => "near:sandbox", notify: () => {}, page: () => "/", watchMs: 0, storage: memoryStorage({ "payminto.local.account": JSON.stringify({ account: ALICE, page: "/" }) }) });
    expect(await failing.account()).toBeNull();
  });
});

describe("the account picker", () => {
  it("lists every account with its role, what it does and its balances, and says it is for development", () => {
    render(<LocalAccountPicker accounts={ACCOUNTS} current={null} onPick={() => {}} />);
    expect(screen.getByText("Local test accounts")).toBeInTheDocument();
    expect(screen.getByText("Development only")).toBeInTheDocument();
    expect(screen.getByText(ALICE)).toBeInTheDocument();
    expect(screen.getByText("Budget owner")).toBeInTheDocument();
    expect(screen.getByText("Shopper")).toBeInTheDocument();
    expect(screen.getByText("Pays checkout links from a wallet")).toBeInTheDocument();
    expect(screen.getByText("495.00 USDC (mock) and 19.94 NEAR")).toBeInTheDocument();
    expect(screen.getByText(/refuses every other network/)).toBeInTheDocument();
  });

  it("puts the account a step needs first and marks it", () => {
    render(<LocalAccountPicker accounts={ACCOUNTS} expected={SHOPPER} current={ALICE} onPick={() => {}} />);
    const rows = screen.getAllByRole("button").filter((b) => b.textContent?.includes(".test.near"));
    expect(rows[0]).toHaveTextContent(SHOPPER);
    expect(rows[0]).toHaveTextContent("Needed here");
    expect(screen.getByText(/must be signed by/)).toBeInTheDocument();
    expect(rows[1]).toHaveTextContent("Last used");
  });

  it("answers once with the chosen account, or with nothing when closed", () => {
    const onPick = vi.fn();
    render(<LocalAccountPicker accounts={ACCOUNTS} current={null} onPick={onPick} />);
    const row = screen.getByText(SHOPPER);
    fireEvent.click(row);
    // A second click on the closing dialog must not answer again.
    fireEvent.click(row);
    expect(onPick).toHaveBeenCalledTimes(1);
    expect(onPick).toHaveBeenCalledWith(SHOPPER);
    cleanup();
    const onClose = vi.fn();
    render(<LocalAccountPicker accounts={ACCOUNTS} current={null} onPick={onClose} />);
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(onClose).toHaveBeenCalledWith(null);
  });

  it("shows NEAR with two decimals, down to nothing", () => {
    expect(nearText("19940000000000000000000000")).toBe("19.94 NEAR");
    expect(nearText("205363487500000000000")).toBe("0.00 NEAR");
    expect(nearText("0")).toBe("0.00 NEAR");
  });
});
