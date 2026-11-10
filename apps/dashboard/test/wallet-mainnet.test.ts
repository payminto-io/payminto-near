import { afterEach, describe, expect, it, vi } from "vitest";
import { intentsPayoutProofRequest, storageDepositTx } from "@payminto/protocol";
import {
  connectMainnet,
  mainnetAccount,
  sendOnMainnet,
  setMainnetWalletDriver,
  setWalletDriver,
  signMessageOnMainnet,
  walletState,
  type WalletDriver,
} from "@/lib/wallet";
import { FakeWallet } from "./fake-wallet";

/** NEAR Connect as the installed 0.12.0 builds it: every constructor's options are kept, nothing reaches a network. */
const built: Array<{ network?: string; features?: Record<string, boolean>; storage?: { get(k: string): Promise<string | null>; set(k: string, v: string): Promise<void> } }> = [];
vi.mock("@hot-labs/near-connect", () => ({
  NearConnector: class {
    whenManifestLoaded = Promise.resolve();
    availableWallets = [];
    constructor(o: (typeof built)[number]) {
      built.push(o);
    }
    async getConnectedWallet(): Promise<never> {
      throw new Error("No wallet selected");
    }
    on() {}
    off() {}
  },
}));

const ACCOUNT = "northwind-usdc.near";
const USDC = "17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1";
const STORAGE = storageDepositTx(USDC, ACCOUNT, "1250000000000000000000");
const proofRequest = () => intentsPayoutProofRequest("mer_aaaaaaaaaaaaaaaaaaaaaaaa", ACCOUNT, 1_794_000_000, { settlementNetwork: "near:mainnet", hub: "hub.test.near" });

afterEach(() => {
  setWalletDriver(null);
  setMainnetWalletDriver(null);
  built.length = 0;
});

describe("the NEAR mainnet connection for the any-chain payout", () => {
  it("is separate from the dashboard's own wallet: it signs and sends through its own driver only", async () => {
    const testnet = new FakeWallet({ account: "owner.testnet" });
    const mainnet = new FakeWallet({ connectAs: ACCOUNT });
    setWalletDriver(testnet);
    setMainnetWalletDriver(mainnet);
    const req = proofRequest();
    const signed = await signMessageOnMainnet(req.message, req.recipient, ACCOUNT, req.nonce);
    expect(signed.accountId).toBe(ACCOUNT);
    expect(mainnet.signed).toHaveLength(1);
    expect(testnet.signed).toHaveLength(0);
    expect(await sendOnMainnet(STORAGE, ACCOUNT)).toEqual({ hash: "tx0", status: "final" });
    expect(mainnet.sent).toEqual([STORAGE]);
    expect(testnet.sent).toEqual([]);
    // The dashboard's own connection never moved.
    expect(walletState()).toEqual({ status: "idle", account: null });
    expect(await mainnetAccount()).toBe(ACCOUNT);
  });

  it("refuses a signature or a transaction from another account before anything reaches the server or NEAR", async () => {
    const mainnet = new FakeWallet({ connectAs: "someone-else.near" });
    setMainnetWalletDriver(mainnet);
    const req = proofRequest();
    await expect(signMessageOnMainnet(req.message, req.recipient, ACCOUNT, req.nonce)).rejects.toMatchObject({ kind: "wrong_account" });
    await expect(sendOnMainnet(STORAGE, ACCOUNT)).rejects.toMatchObject({ kind: "wrong_account", message: expect.stringContaining(ACCOUNT) });
    expect(mainnet.sent).toEqual([]);
  });

  it("says a person canceled in the wallet in plain words, and that nothing was sent", async () => {
    const mainnet = new FakeWallet({ account: ACCOUNT });
    mainnet.sendImpl = () => Promise.reject(new Error("User rejected the request"));
    setMainnetWalletDriver(mainnet);
    await expect(sendOnMainnet(STORAGE, ACCOUNT)).rejects.toMatchObject({ kind: "rejected", message: "You canceled in your wallet. Nothing was sent." });
  });

  it("builds NEAR Connect for mainnet with its own storage, so the two connections never share a remembered wallet", async () => {
    const keys = new Map<string, string>();
    vi.stubGlobal("localStorage", { getItem: (k: string) => keys.get(k) ?? null, setItem: (k: string, v: string) => void keys.set(k, v), removeItem: (k: string) => void keys.delete(k) });
    try {
      expect(await mainnetAccount()).toBeNull();
      expect(built).toHaveLength(1);
      expect(built[0]).toMatchObject({ network: "mainnet", features: { mainnet: true, signMessage: true, signAndSendTransaction: true } });
      await built[0]!.storage!.set("selected-wallet", "meteor-wallet");
      expect([...keys.keys()]).toEqual(["payminto-mainnet:selected-wallet"]);
      expect(await built[0]!.storage!.get("selected-wallet")).toBe("meteor-wallet");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("connects on request and reports the account it shared", async () => {
    const mainnet: WalletDriver = new FakeWallet({ connectAs: ACCOUNT });
    setMainnetWalletDriver(mainnet);
    expect(await mainnetAccount()).toBeNull();
    expect(await connectMainnet(ACCOUNT)).toBe(ACCOUNT);
    expect(await mainnetAccount()).toBe(ACCOUNT);
  });
});
