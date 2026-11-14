import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { setMainnetWalletDriver, setWalletDriver } from "@/lib/wallet";
import type { IntentsPayout } from "@/lib/schemas";
import { AccountForm } from "@/components/gateway/any-chain-settings";
import { FakeWallet } from "./fake-wallet";

vi.mock("@/lib/session", () => ({ useApi: () => ({ gateway: { setIntentsPayout: vi.fn() } }) }));

const ACCOUNT = "northwind-usdc.near";
const payout: IntentsPayout = {
  object: "intents_payout",
  mode: "live",
  label: "Live - NEAR mainnet",
  settlement_network: "near:mainnet",
  account: null,
  verified: false,
  checks: { exists: null, usdc_registered: null, proven: false, proven_at: null },
  usdc: { contract: "17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1", asset_id: "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1", decimals: 6 },
  storage_step: null,
  enabled: false,
  proof_scope: { settlement_network: "near:mainnet", hub: "hub.test.near" },
  checked_at: null,
} as unknown as IntentsPayout;

let mainnet: FakeWallet;
beforeEach(() => {
  setWalletDriver(new FakeWallet({ account: "owner.testnet" }));
  mainnet = new FakeWallet({ connectAs: ACCOUNT });
  setMainnetWalletDriver(mainnet);
});
afterEach(() => {
  setWalletDriver(null);
  setMainnetWalletDriver(null);
});

function renderForm(walletTimeoutMs?: number) {
  render(
    <QueryClientProvider client={new QueryClient()}>
      <AccountForm p={payout} merchantId="mer_aaaaaaaaaaaaaaaaaaaaaaaa" onSaved={() => undefined} onCancel={null} {...(walletTimeoutMs ? { walletTimeoutMs } : {})} />
    </QueryClientProvider>,
  );
  fireEvent.change(screen.getByPlaceholderText("business.near"), { target: { value: ACCOUNT } });
}

describe("live mode: each wallet window opens from its own click", () => {
  it("connects first, and only a second click asks the wallet to sign", async () => {
    renderForm();
    // One click opens one wallet window: connecting signs nothing.
    fireEvent.click(screen.getByRole("button", { name: `Connect ${ACCOUNT}` }));
    expect(await screen.findByRole("button", { name: "Sign the message" })).toBeInTheDocument();
    expect(mainnet.signed).toHaveLength(0);
    fireEvent.click(screen.getByRole("button", { name: "Sign the message" }));
    expect(await screen.findByText(/Signed by/)).toBeInTheDocument();
    expect(mainnet.signed).toHaveLength(1);
    expect(mainnet.signed[0]!.message).toContain(`Payminto intents payout mer_aaaaaaaaaaaaaaaaaaaaaaaa ${ACCOUNT}`);
  });

  it("a wallet that never answers ends in a plain message and a way to try again, not an endless spinner", async () => {
    mainnet.signImpl = () => new Promise(() => undefined);
    renderForm(30);
    fireEvent.click(screen.getByRole("button", { name: `Connect ${ACCOUNT}` }));
    fireEvent.click(await screen.findByRole("button", { name: "Sign the message" }));
    expect(await screen.findByText(/Your wallet did not answer/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Sign the message" })).toBeEnabled();
  });
});
