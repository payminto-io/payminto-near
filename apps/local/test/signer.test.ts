import { describe, expect, it } from "vitest";
import { generateKey } from "near-kit";
import { depositBudgetTx, nep413Digest, signatureHex, verifyDigest, type PublicKey, type WalletTx } from "@payminto/protocol";
import { assertSandboxOnly, createSignerApp, isLoopbackUrl, parseWalletTx, SignerRefusal, type Outcome, type SignerBackend } from "../src/signer.ts";
import { nearBackend } from "../src/signer-near.ts";

const TOKEN = "run-token-0123456789abcdef";
const ORIGIN = "http://localhost:3210";
const HOST = "127.0.0.1:4211";
const ALICE = "alice.test.near";
const BUDGET = "ab".repeat(32);
const TX: WalletTx = depositBudgetTx("usdc.test.near", "hub.test.near", BUDGET, 2_000_000n);

function fakeBackend(over: Partial<SignerBackend> = {}): SignerBackend & { sent: Array<{ account: string; tx: WalletTx }> } {
  const sent: Array<{ account: string; tx: WalletTx }> = [];
  return {
    sent,
    rpcUrl: "http://127.0.0.1:3030",
    chainId: async () => "localnet",
    accounts: () => [{ accountId: ALICE, role: "Budget owner", does: "Owns a Budget", publicKey: "ed25519:11111111111111111111111111111111" }],
    balances: async () => ({ near: "20000000000000000000000000", usdc: "500000000" }),
    signAndSend: async (account, tx): Promise<Outcome> => {
      sent.push({ account, tx });
      return { transaction: { hash: `hash${sent.length}` }, status: { SuccessValue: "" } };
    },
    signMessage: async (account) => ({ accountId: account, publicKey: "ed25519:11111111111111111111111111111111", signature: "c2ln" }),
    signDelegate: async (account, tx) => ({ accountId: account, publicKey: "ed25519:11111111111111111111111111111111", receiverId: tx.receiverId, signedDelegate: "ZGVsZWdhdGU=", maxBlockHeight: "321", nonce: "7" }),
    ...over,
  };
}

function setup(over: Partial<SignerBackend> = {}) {
  const lines: string[] = [];
  const backend = fakeBackend(over);
  const app = createSignerApp({ backend, token: TOKEN, allowedOrigins: [ORIGIN], log: (l) => lines.push(l) });
  const call = (path: string, o: { method?: string; body?: unknown; token?: string | null; origin?: string; host?: string } = {}) =>
    app.request(`http://${HOST}${path}`, {
      method: o.method ?? (o.body === undefined ? "GET" : "POST"),
      headers: {
        host: o.host ?? HOST,
        ...(o.token === null ? {} : { authorization: `Bearer ${o.token ?? TOKEN}` }),
        ...(o.origin ? { origin: o.origin } : {}),
        ...(o.body === undefined ? {} : { "content-type": "application/json" }),
      },
      body: o.body === undefined ? undefined : JSON.stringify(o.body),
    });
  return { app, backend, lines, call };
}

const send = (over: Record<string, unknown> = {}) => ({ network: "near:sandbox", accountId: ALICE, transactions: [TX], ...over });
const codeOf = async (res: Response) => ((await res.json()) as { error?: { code?: string } }).error?.code;

describe("who may call the signer", () => {
  it("lists the accounts with roles and balances, and says it is a development signer for the sandbox", async () => {
    const { call } = setup();
    const res = await call("/v1/accounts", { origin: ORIGIN });
    expect(res.status).toBe(200);
    expect(res.headers.get("access-control-allow-origin")).toBe(ORIGIN);
    const body = (await res.json()) as { development_only: boolean; network: string; accounts: Array<{ accountId: string; role: string; balances: { usdc: string } }> };
    expect(body).toMatchObject({ development_only: true, network: "near:sandbox" });
    expect(body.accounts[0]).toMatchObject({ accountId: ALICE, role: "Budget owner", balances: { usdc: "500000000" } });
    expect(JSON.stringify(body)).not.toMatch(/secret/i);
  });

  it("needs this run's token", async () => {
    const { call, backend } = setup();
    expect((await call("/v1/accounts", { token: null })).status).toBe(401);
    expect((await call("/v1/accounts", { token: "another-run" })).status).toBe(401);
    const res = await call("/v1/sign-and-send", { body: send(), token: `${TOKEN}x` });
    expect(res.status).toBe(401);
    expect(await codeOf(res)).toBe("BAD_TOKEN");
    expect(backend.sent).toHaveLength(0);
  });

  it("refuses a browser on any other origin, with no CORS header, even with the token", async () => {
    const { call, backend } = setup();
    const res = await call("/v1/sign-and-send", { body: send(), origin: "https://evil.example" });
    expect(res.status).toBe(403);
    expect(await codeOf(res)).toBe("ORIGIN_NOT_ALLOWED");
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
    expect(backend.sent).toHaveLength(0);
  });

  it("answers a preflight only for the dashboard's origin", async () => {
    const { call } = setup();
    const ok = await call("/v1/sign-and-send", { method: "OPTIONS", origin: ORIGIN, token: null });
    expect(ok.status).toBe(204);
    expect(ok.headers.get("access-control-allow-origin")).toBe(ORIGIN);
    expect(ok.headers.get("access-control-allow-headers")).toContain("authorization");
    expect((await call("/v1/sign-and-send", { method: "OPTIONS", origin: "https://evil.example", token: null })).status).toBe(403);
  });

  it("answers only when addressed as a loopback host, so a rebound DNS name gets nothing", async () => {
    const { call } = setup();
    const res = await call("/v1/accounts", { host: "signer.evil.example" });
    expect(res.status).toBe(403);
    expect(await codeOf(res)).toBe("NOT_LOOPBACK");
  });
});

describe("what the signer signs", () => {
  it("signs and sends function calls for a local account, and logs one line per signature without key material", async () => {
    const { call, backend, lines } = setup();
    const res = await call("/v1/sign-and-send", { body: send({ transactions: [TX, TX] }), origin: ORIGIN });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { outcomes: unknown[] }).outcomes).toHaveLength(2);
    expect(backend.sent.map((s) => s.account)).toEqual([ALICE, ALICE]);
    expect(lines).toEqual([
      `signed transaction account=${ALICE} receiver=usdc.test.near methods=ft_transfer_call tx=hash1 result=ok`,
      `signed transaction account=${ALICE} receiver=usdc.test.near methods=ft_transfer_call tx=hash2 result=ok`,
    ]);
  });

  it("stops at the first transaction that fails, as a wallet does", async () => {
    const { call, backend } = setup({ signAndSend: async () => ({ transaction: { hash: "failed1" }, status: { Failure: { ActionError: {} } } }) });
    void backend;
    const res = await call("/v1/sign-and-send", { body: send({ transactions: [TX, TX] }) });
    expect(((await res.json()) as { outcomes: unknown[] }).outcomes).toHaveLength(1);
  });

  it.each(["near:testnet", "near:mainnet", "testnet", undefined])("refuses network %s before anything is signed", async (network) => {
    const { call, backend, lines } = setup();
    for (const [path, body] of [
      ["/v1/sign-and-send", send({ network })],
      ["/v1/sign-message", { network, accountId: ALICE, message: "m", recipient: "hub.test.near", nonce: Buffer.alloc(32).toString("base64") }],
      ["/v1/sign-delegate", { network, accountId: ALICE, transaction: TX }],
    ] as const) {
      const res = await call(path, { body });
      expect(res.status).toBe(403);
      expect(await codeOf(res)).toBe("WRONG_NETWORK");
    }
    expect(backend.sent).toHaveLength(0);
    expect(lines.every((l) => l.startsWith("refused "))).toBe(true);
  });

  it("refuses an account it does not hold", async () => {
    const { call } = setup();
    const res = await call("/v1/sign-and-send", { body: send({ accountId: "node.test.near" }) });
    expect(res.status).toBe(404);
    expect(await codeOf(res)).toBe("UNKNOWN_ACCOUNT");
  });

  it.each([
    ["a transfer", { receiverId: "bob.test.near", actions: [{ type: "Transfer", params: { deposit: "1" } }] }],
    ["a key change", { receiverId: ALICE, actions: [{ type: "AddKey", params: { publicKey: "ed25519:x", accessKey: { permission: "FullAccess" } } }] }],
    ["an account deletion", { receiverId: ALICE, actions: [{ type: "DeleteAccount", params: { beneficiaryId: "bob.test.near" } }] }],
    ["no action", { receiverId: "hub.test.near", actions: [] }],
    ["a bad receiver", { receiverId: "NOT AN ACCOUNT", actions: TX.actions }],
  ])("refuses %s", async (_what, tx) => {
    const { call, backend } = setup();
    const res = await call("/v1/sign-and-send", { body: send({ transactions: [tx] }) });
    expect(res.status).toBe(400);
    expect(await codeOf(res)).toBe("BAD_TRANSACTION");
    expect(backend.sent).toHaveLength(0);
  });

  it("signs a NEP-413 message only with a 32 byte nonce", async () => {
    const { call, lines } = setup();
    const body = { network: "near:sandbox", accountId: ALICE, message: "Payminto payout change", recipient: "hub.test.near" };
    expect((await call("/v1/sign-message", { body: { ...body, nonce: Buffer.alloc(31).toString("base64") } })).status).toBe(400);
    const res = await call("/v1/sign-message", { body: { ...body, nonce: Buffer.alloc(32, 1).toString("base64") } });
    expect(res.status).toBe(200);
    expect(lines.at(-1)).toBe(`signed message account=${ALICE} receiver=hub.test.near methods=NEP-413 chars=22`);
  });

  it("signs a NEP-366 delegate and logs the account, the receiver and the methods", async () => {
    const { call, lines } = setup();
    const res = await call("/v1/sign-delegate", { body: { network: "near:sandbox", accountId: ALICE, transaction: { receiverId: "hub.test.near", actions: [{ type: "FunctionCall", params: { methodName: "revoke_budget", args: { budget_id: BUDGET }, gas: "30000000000000", deposit: "0" } }] } } });
    expect(res.status).toBe(200);
    expect((await res.json()) as { signedDelegate: string }).toMatchObject({ signedDelegate: "ZGVsZWdhdGU=", receiverId: "hub.test.near" });
    expect(lines.at(-1)).toBe(`signed delegate account=${ALICE} receiver=hub.test.near methods=revoke_budget valid_until_block=321`);
  });

  it("answers a backend failure without leaking it as a success, and has no other route", async () => {
    const { call, lines } = setup({
      signAndSend: async () => {
        throw new Error("the local NEAR node did not answer send_tx within 60 s");
      },
    });
    const res = await call("/v1/sign-and-send", { body: send() });
    expect(res.status).toBe(500);
    expect(await codeOf(res)).toBe("SIGNER_FAILED");
    expect(lines.at(-1)).toContain("did not answer");
    expect((await call("/v1/keys")).status).toBe(404);
  });
});

describe("sandbox only", () => {
  it("refuses to start against anything but a loopback RPC that reports the sandbox chain id", async () => {
    await expect(assertSandboxOnly(fakeBackend())).resolves.toBeUndefined();
    await expect(assertSandboxOnly(fakeBackend({ rpcUrl: "https://rpc.testnet.near.org" }))).rejects.toThrow(/not a loopback/);
    await expect(assertSandboxOnly(fakeBackend({ chainId: async () => "testnet" }))).rejects.toThrow(/reports testnet/);
    await expect(assertSandboxOnly(fakeBackend({ chainId: async () => "mainnet" }))).rejects.toThrow(/reports mainnet/);
  });

  it("knows a loopback address from a look-alike", () => {
    expect(isLoopbackUrl("http://127.0.0.1:3030")).toBe(true);
    expect(isLoopbackUrl("http://localhost:3030")).toBe(true);
    expect(isLoopbackUrl("https://127.0.0.1:3030")).toBe(false);
    expect(isLoopbackUrl("http://127.0.0.1.evil.example")).toBe(false);
    expect(isLoopbackUrl("http://rpc.testnet.near.org")).toBe(false);
    expect(isLoopbackUrl("not a url")).toBe(false);
  });

  it("parses a wallet transaction and keeps only what it checked", () => {
    expect(parseWalletTx(TX)).toEqual(TX);
    expect(() => parseWalletTx(null)).toThrow(SignerRefusal);
    expect(() => parseWalletTx({ ...TX, actions: [{ ...TX.actions[0]!, params: { ...TX.actions[0]!.params, deposit: "-1" } }] })).toThrow(/deposit/);
  });
});

describe("the key side", () => {
  it("signs NEP-413 so that the node's own verifier accepts it, base64 as wallets return it", async () => {
    const key = generateKey();
    const publicKey = key.publicKey.toString();
    const backend = nearBackend({ rpcUrl: "http://127.0.0.1:1", token: "usdc.test.near", holders: [{ accountId: ALICE, role: "r", does: "d", publicKey, secretKey: key.secretKey, near: null as never }] });
    const input = { message: "Payminto payout change new alice.test.near 1794290000 network near:sandbox hub hub.test.near", recipient: "hub.test.near", nonce: new Uint8Array(32).fill(9) };
    const signed = await backend.signMessage(ALICE, input);
    const hex = signatureHex(signed.signature);
    expect(signed).toMatchObject({ accountId: ALICE, publicKey });
    expect(hex).not.toBeNull();
    expect(verifyDigest(publicKey as PublicKey, nep413Digest(input), hex!)).toBe(true);
    expect(verifyDigest(publicKey as PublicKey, nep413Digest({ ...input, recipient: "other.test.near" }), hex!)).toBe(false);
    // What the signer hands out never includes the secret.
    expect(JSON.stringify(backend.accounts())).not.toContain(key.secretKey.slice(8));
    await expect(backend.signMessage("bob.test.near", input)).rejects.toThrow(/no local key/);
  });
});
