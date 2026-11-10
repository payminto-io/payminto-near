import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { nep413Digest, storageDepositTx } from "@payminto/protocol";
import { setMainnetWalletDriver, setWalletDriver } from "@/lib/wallet";
import type { IntentsPayout } from "@/lib/schemas";
import { MainnetConnection, signPayoutProof, StorageStep } from "@/components/gateway/any-chain-settings";
import { FakeWallet } from "./fake-wallet";

// The flow links hashes to the dashboard's explorer, which it learns from the signed-in server. Tests have neither.
vi.mock("@/lib/queries", () => ({ useExplorer: () => ({ tx: (h: string) => `https://testnet.explorer.test/txns/${h}`, address: (a: string) => `https://testnet.explorer.test/address/${a}` }) }));

const ACCOUNT = "northwind-usdc.near";
const USDC = "17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1";
const STORAGE = storageDepositTx(USDC, ACCOUNT, "1250000000000000000000");
const payout = (mode: "live" | "simulated"): IntentsPayout => ({
  object: "intents_payout",
  mode,
  label: mode === "live" ? "Live - NEAR mainnet" : "Simulated - no real money",
  settlement_network: mode === "live" ? "near:mainnet" : "near:mainnet (simulated)",
  account: ACCOUNT,
  verified: false,
  checks: { exists: true, usdc_registered: false, proven: true, proven_at: "2026-11-14T09:00:00.000Z" },
  usdc: { contract: USDC, asset_id: `nep141:${USDC}`, decimals: 6 },
  storage_step: { why: `${ACCOUNT} is not registered with USDC yet.`, deposit_near: "0.00125", transaction: STORAGE },
  enabled: false,
  proof_scope: { settlement_network: mode === "live" ? "near:mainnet" : "near:mainnet (simulated)", hub: "hub.test.near" },
  checked_at: "2026-11-14T09:00:00.000Z",
});

let testnet: FakeWallet;
let mainnet: FakeWallet;
beforeEach(() => {
  testnet = new FakeWallet({ account: "owner.testnet" });
  mainnet = new FakeWallet({ connectAs: ACCOUNT });
  setWalletDriver(testnet);
  setMainnetWalletDriver(mainnet);
});
afterEach(() => {
  setWalletDriver(null);
  setMainnetWalletDriver(null);
});

describe("live mode: the any-chain payout account on NEAR mainnet", () => {
  it("shows the storage deposit in full, labeled NEAR mainnet, before the mainnet wallet opens, then sends it there", async () => {
    const onDone = vi.fn();
    render(<StorageStep p={payout("live")} account={ACCOUNT} onDone={onDone} />);
    fireEvent.click(screen.getByRole("button", { name: "Review the storage deposit" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("NEAR mainnet")).toBeInTheDocument();
    expect(within(dialog).getByText("storage_deposit")).toBeInTheDocument();
    expect(within(dialog).getByText("0.00125 NEAR, once")).toBeInTheDocument();
    expect(within(dialog).getByText(/"registration_only": true/)).toBeInTheDocument();
    // Nothing has reached any wallet while the person reads.
    expect(mainnet.sent).toEqual([]);
    fireEvent.click(within(dialog).getByRole("button", { name: "Open my NEAR mainnet wallet" }));
    expect(await within(dialog).findByText("Final on NEAR")).toBeInTheDocument();
    expect(mainnet.sent).toEqual([STORAGE]);
    expect(testnet.sent).toEqual([]);
    // The hash links to NearBlocks, not to the dashboard's own explorer.
    expect(within(dialog).getByRole("link", { name: /transaction/ })).toHaveAttribute("href", "https://nearblocks.io/txns/tx0");
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it("refuses a mainnet wallet connected as another account, and sends nothing", async () => {
    mainnet = new FakeWallet({ connectAs: "someone-else.near" });
    setMainnetWalletDriver(mainnet);
    render(<StorageStep p={payout("live")} account={ACCOUNT} onDone={() => undefined} />);
    fireEvent.click(screen.getByRole("button", { name: "Review the storage deposit" }));
    fireEvent.click(await screen.findByRole("button", { name: "Open my NEAR mainnet wallet" }));
    expect(await screen.findByText("Not completed")).toBeInTheDocument();
    // Account names are set apart for reading, so the sentence is checked as the dialog's text.
    expect(screen.getByRole("dialog").textContent).toContain("This needs northwind-usdc.near on NEAR mainnet, and your wallet is connected as someone-else.near.");
    expect(mainnet.sent).toEqual([]);
  });

  it("signs the ownership proof with the mainnet wallet, over the message bound to near:mainnet and this server", async () => {
    const signed = await signPayoutProof({ live: true, merchantId: "mer_aaaaaaaaaaaaaaaaaaaaaaaa", account: ACCOUNT, timestamp: 1_794_000_000, scope: { settlementNetwork: "near:mainnet", hub: "hub.test.near" } });
    expect(signed.accountId).toBe(ACCOUNT);
    expect(mainnet.signed).toHaveLength(1);
    expect(testnet.signed).toHaveLength(0);
    expect(mainnet.signed[0]!.message).toBe(`Payminto intents payout mer_aaaaaaaaaaaaaaaaaaaaaaaa ${ACCOUNT} 1794000000 network near:mainnet hub hub.test.near`);
    expect(nep413Digest({ ...mainnet.signed[0]!, nonce: mainnet.signed[0]!.nonce })).toMatch(/^[0-9a-f]{64}$/);
  });

  it("says plainly that the mainnet connection is separate and for two steps only", () => {
    render(<MainnetConnection />);
    const note = screen.getByRole("note", { name: "NEAR mainnet wallet" });
    expect(within(note).getByText(/Real money/)).toBeInTheDocument();
    expect(within(note).getByText(/the message that proves the account is yours, and its USDC storage deposit/)).toBeInTheDocument();
  });
});

describe("simulated mode keeps the dashboard's own wallet", () => {
  it("reviews the storage deposit and sends it with the dashboard's wallet, never the mainnet one", async () => {
    testnet = new FakeWallet({ account: ACCOUNT });
    setWalletDriver(testnet);
    render(<StorageStep p={payout("simulated")} account={ACCOUNT} onDone={() => undefined} />);
    fireEvent.click(screen.getByRole("button", { name: "Review the storage deposit" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).queryByText("NEAR mainnet")).toBeNull();
    fireEvent.click(within(dialog).getByRole("button", { name: "Send the storage deposit" }));
    expect(await within(dialog).findByText("Final on NEAR")).toBeInTheDocument();
    expect(testnet.sent).toEqual([STORAGE]);
    expect(mainnet.sent).toEqual([]);
    const signed = await signPayoutProof({ live: false, merchantId: "mer_aaaaaaaaaaaaaaaaaaaaaaaa", account: ACCOUNT, timestamp: 1, scope: { settlementNetwork: "near:mainnet (simulated)", hub: "hub.test.near" } });
    expect(signed.accountId).toBe(ACCOUNT);
    expect(mainnet.signed).toHaveLength(0);
  });
});
