import { afterEach, describe, expect, it } from "vitest";
import { reclaimTx, revokeBudgetTx } from "@payminto/protocol";
import { DELEGATE_WALLETS_TESTNET, delegateSupport, delegateUnsupportedText, setWalletDriver, signDelegateActions, toWalletError } from "@/lib/wallet";
import { FakeWallet } from "./fake-wallet";

const HUB = "hub.payminto.testnet";
const BUDGET = "ab".repeat(32);

afterEach(() => setWalletDriver(null));

describe("delegate actions (NEP-366) through the wallet module", () => {
  it("asks the wallet to sign and returns one signed delegate per request, sending nothing", async () => {
    const w = new FakeWallet({ account: "alice.testnet" });
    w.delegateImpl = async (delegates) => delegates.map((_, i) => `c2lnbmVk${i}`);
    setWalletDriver(w);
    const txs = [revokeBudgetTx(HUB, BUDGET), reclaimTx(HUB, BUDGET)];
    expect(await signDelegateActions(txs)).toEqual(["c2lnbmVk0", "c2lnbmVk1"]);
    expect(w.delegated).toEqual([txs]);
    expect(w.sent).toEqual([]);
  });

  it("reports what the connected wallet can do, and no wallet when none is connected", async () => {
    const w = new FakeWallet({ account: "alice.testnet" });
    setWalletDriver(w);
    expect(await delegateSupport()).toEqual({ wallet: "Fake Wallet", supported: true, capable: ["Fake Wallet", "Other Wallet"] });
    setWalletDriver(new FakeWallet());
    expect(await delegateSupport()).toMatchObject({ wallet: null, supported: false });
  });

  it("refuses a wallet that cannot sign delegates before asking it, and names the ones that can", async () => {
    const w = new FakeWallet({ account: "alice.testnet" });
    w.support = { wallet: "MyNearWallet", supported: false, capable: ["Meteor Wallet", "Ledger"] };
    setWalletDriver(w);
    const err = toWalletError(await signDelegateActions([revokeBudgetTx(HUB, BUDGET)]).catch((e: unknown) => e));
    expect(err.kind).toBe("unsupported");
    expect(err.message).toBe("MyNearWallet cannot sign an action for a relayer to send. Connect Meteor Wallet or Ledger to do this without gas.");
    expect(w.delegated).toEqual([]);
  });

  it("falls back to the wallets verified on testnet when the live list is not known", () => {
    expect(delegateUnsupportedText({ wallet: "MyNearWallet", supported: false, capable: [] })).toBe(
      "MyNearWallet cannot sign an action for a relayer to send. Connect Meteor Wallet, Intear Wallet, Ledger or NEAR CLI to do this without gas.",
    );
    expect(DELEGATE_WALLETS_TESTNET).toEqual(["Meteor Wallet", "Intear Wallet", "Ledger", "NEAR CLI"]);
    expect(delegateUnsupportedText({ wallet: "Ledger", supported: true, capable: [] })).toBeNull();
    expect(delegateUnsupportedText({ wallet: null, supported: false, capable: [] })).toBeNull();
  });

  it("treats a cancel as a cancel, and a wallet that returns too few signatures as a failure", async () => {
    const w = new FakeWallet({ account: "alice.testnet" });
    w.delegateImpl = () => Promise.reject(new Error("User rejected the request"));
    setWalletDriver(w);
    expect(toWalletError(await signDelegateActions([revokeBudgetTx(HUB, BUDGET)]).catch((e: unknown) => e)).kind).toBe("rejected");
    w.delegateImpl = async () => [];
    const err = toWalletError(await signDelegateActions([revokeBudgetTx(HUB, BUDGET)]).catch((e: unknown) => e));
    expect(err.kind).toBe("failed");
    expect(err.message).toContain("Nothing was sent");
  });
});
