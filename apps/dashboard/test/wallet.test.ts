import { afterEach, describe, expect, it } from "vitest";
import { depositBudgetTx, payoutProofRequest, revokeBudgetTx } from "@payminto/protocol";
import {
  connectWallet,
  disconnectWallet,
  ensureConnected,
  readOutcome,
  restoreWallet,
  setWalletDriver,
  signAndSendTransaction,
  signAndSendTransactions,
  signMessage,
  toWalletError,
  walletErrorMessage,
  walletState,
} from "@/lib/wallet";
import { FakeWallet, failedOutcome, ftOutcome } from "./fake-wallet";

const HUB = "hub.payminto.testnet";
const TOKEN = "usdc.fakes.testnet";
const BUDGET = "a".repeat(64);

afterEach(() => setWalletDriver(null));

describe("connection", () => {
  it("connects, reports the account and disconnects", async () => {
    const w = new FakeWallet({ connectAs: "northwind.testnet" });
    setWalletDriver(w);
    expect(await restoreWallet()).toBeNull();
    expect(await connectWallet()).toBe("northwind.testnet");
    expect(walletState()).toEqual({ status: "connected", account: "northwind.testnet" });
    await disconnectWallet();
    expect(walletState()).toEqual({ status: "idle", account: null });
  });

  it("restores a connection the wallet already shared, without a prompt", async () => {
    const w = new FakeWallet({ account: "acme.testnet" });
    setWalletDriver(w);
    expect(await ensureConnected()).toBe("acme.testnet");
  });

  it("follows the wallet signing out on its own", async () => {
    const w = new FakeWallet({ account: "acme.testnet" });
    setWalletDriver(w);
    await restoreWallet();
    w.emit(null);
    expect(walletState().account).toBeNull();
  });

  it("turns a closed wallet picker into a plain cancel, and leaves the state as it was", async () => {
    const w = new FakeWallet();
    w.connectImpl = () => Promise.reject(new Error("User rejected"));
    setWalletDriver(w);
    const err = await connectWallet().catch((e: unknown) => e);
    expect(toWalletError(err).kind).toBe("rejected");
    expect(walletErrorMessage(err)).toBe("You canceled in your wallet. Nothing was sent.");
    expect(walletState().status).toBe("idle");
  });

  it("treats disconnecting an already signed-out wallet as done", async () => {
    setWalletDriver(new FakeWallet());
    await expect(disconnectWallet()).resolves.toBeUndefined();
  });
});

describe("transactions", () => {
  it("sends the builder's transaction untouched and reads a final outcome", async () => {
    const w = new FakeWallet({ account: "acme.testnet" });
    setWalletDriver(w);
    const tx = revokeBudgetTx(HUB, BUDGET);
    expect(await signAndSendTransaction(tx)).toEqual({ hash: "tx0", status: "final" });
    expect(w.sent).toEqual([tx]);
  });

  it("fails a deposit the hub returned, naming the panic", () => {
    const tx = depositBudgetTx(TOKEN, HUB, BUDGET, 5_000_000n);
    const o = { ...ftOutcome("h1", "0"), receipts_outcome: [{ outcome: { status: { Failure: { ExecutionError: "Smart contract panicked: UNKNOWN_BUDGET" } } } }] };
    const r = readOutcome(tx, o);
    expect(r).toMatchObject({ hash: "h1", status: "failed" });
    expect(r.status === "failed" && r.error).toContain("UNKNOWN_BUDGET");
    expect(r.status === "failed" && r.error).toContain("returned to your wallet");
  });

  it("passes a deposit the hub kept in full", () => {
    const tx = depositBudgetTx(TOKEN, HUB, BUDGET, 5_000_000n);
    expect(readOutcome(tx, ftOutcome("h2", "5000000"))).toEqual({ hash: "h2", status: "final" });
  });

  it("fails a transaction NEAR reports as failed", () => {
    const r = readOutcome(revokeBudgetTx(HUB, BUDGET), failedOutcome("h3", "NOT_OWNER"));
    expect(r).toEqual({ hash: "h3", status: "failed", error: "Smart contract panicked: NOT_OWNER" });
  });

  it("reports the rest of a batch as not sent when the wallet stops part way", async () => {
    const w = new FakeWallet({ account: "acme.testnet" });
    w.batchLimit = 1;
    setWalletDriver(w);
    const res = await signAndSendTransactions([revokeBudgetTx(HUB, BUDGET), depositBudgetTx(TOKEN, HUB, BUDGET, 1n)]);
    expect(res[0]).toEqual({ hash: "tx0", status: "final" });
    expect(res[1]).toMatchObject({ status: "failed", error: expect.stringContaining("not sent") });
  });

  it("maps a rejected approval to a cancel", async () => {
    const w = new FakeWallet({ account: "acme.testnet" });
    w.sendImpl = () => Promise.reject(new Error("User cancelled the transaction"));
    setWalletDriver(w);
    await expect(signAndSendTransaction(revokeBudgetTx(HUB, BUDGET))).rejects.toMatchObject({ kind: "rejected" });
  });
});

describe("NEP-413 messages", () => {
  it("signs with a fresh 32-byte nonce and returns what a verifier needs", async () => {
    const w = new FakeWallet({ account: "payout.testnet" });
    setWalletDriver(w);
    const a = await signMessage("hello", HUB, "payout.testnet");
    const b = await signMessage("hello", HUB);
    expect(w.signed[0]!.nonce).toHaveLength(32);
    expect(a).toMatchObject({ accountId: "payout.testnet", message: "hello", recipient: HUB, publicKey: "ed25519:fakeKey" });
    expect(Buffer.from(a.nonce, "base64")).toHaveLength(32);
    expect(a.nonce).not.toBe(b.nonce);
  });

  it("refuses a signature from another account before anything is sent", async () => {
    setWalletDriver(new FakeWallet({ account: "someone-else.testnet" }));
    await expect(signMessage("hello", HUB, "payout.testnet")).rejects.toMatchObject({ kind: "wrong_account" });
  });

  it("signs a payout proof with the nonce the protocol derives from the message", async () => {
    const w = new FakeWallet({ account: "payout.testnet" });
    setWalletDriver(w);
    const req = payoutProofRequest("new", "payout.testnet", 1_762_000_000, { network: "near:testnet", hub: HUB });
    const p = await signMessage(req.message, req.recipient, "payout.testnet", req.nonce);
    expect(w.signed[0]).toEqual({ message: req.message, recipient: HUB, nonce: req.nonce });
    expect(p.recipient).toBe(HUB);
  });
});
