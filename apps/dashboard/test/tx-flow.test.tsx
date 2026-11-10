import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useState } from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { revokeBudgetTx } from "@payminto/protocol";
import { FlowError, setWalletDriver, signDelegateActions, type TxResult } from "@/lib/wallet";
import { splitAccounts } from "@/components/ds/account-id";
import { TxFlow, TxFlowProvider, useTxFlow, type TxPlan } from "@/components/ds/tx-flow";
import { FakeWallet, failedOutcome } from "./fake-wallet";

// The flow links hashes and accounts to the explorer, which it learns from the signed-in server. Tests have neither.
vi.mock("@/lib/queries", () => ({ useExplorer: () => ({ tx: (h: string) => `https://explorer.test/txns/${h}`, address: (a: string) => `https://explorer.test/address/${a}` }) }));

const HUB = "hub.payminto.testnet";
const OWNER = "alice.testnet";
const TX = revokeBudgetTx(HUB, "ab".repeat(32));
const base: TxPlan = { title: "Revoke this Budget on NEAR", description: "Stops new settlement.", summary: [{ label: "Budget", value: "Treasury Agent" }], txs: [TX], confirmLabel: "Revoke on NEAR", signer: OWNER, finalNote: "Revoked on chain." };

let wallet: FakeWallet;
beforeEach(() => {
  wallet = new FakeWallet({ account: OWNER });
  setWalletDriver(wallet);
});
afterEach(() => setWalletDriver(null));

const show = (plan: TxPlan, onFinal = vi.fn()) => {
  render(<TxFlow plan={plan} open onOpenChange={() => undefined} onFinal={onFinal} />);
  return onFinal;
};
const confirm = (label = base.confirmLabel) => fireEvent.click(screen.getByRole("button", { name: label }));

describe("TxFlow: a transaction the wallet sends itself", () => {
  it("shows the exact call, then final with the hash, and reports final once", async () => {
    const onFinal = show(base);
    expect(screen.getByText("revoke_budget")).toBeInTheDocument();
    expect(screen.getByText("The transaction your wallet will sign")).toBeInTheDocument();
    confirm();
    expect(await screen.findByText("Final on NEAR")).toBeInTheDocument();
    expect(screen.getByText("Revoked on chain.")).toBeInTheDocument();
    expect(onFinal).toHaveBeenCalledTimes(1);
    expect(wallet.sent).toEqual([TX]);
  });

  it("returns to the review with a note when the person cancels in the wallet", async () => {
    wallet.sendImpl = () => Promise.reject(new Error("User rejected the request"));
    const onFinal = show(base);
    confirm();
    expect(await screen.findByText("You canceled in your wallet. Nothing was sent.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: base.confirmLabel })).toBeEnabled();
    expect(onFinal).not.toHaveBeenCalled();
  });

  it("turns a contract's own error code into words when the plan knows how", async () => {
    wallet.sendImpl = async () => failedOutcome("h1", "ERR_PERMISSION_DENIED");
    show({ ...base, explainFailure: (e) => (/ERR_PERMISSION_DENIED/.test(e) ? "The DAO refused: this account may not do that." : e) });
    confirm();
    expect(await screen.findByText("Not completed")).toBeInTheDocument();
    expect(screen.getByText("The DAO refused: this account may not do that.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Review and try again" })).toBeInTheDocument();
  });

  it("refuses to send when the plan is blocked, and says why", () => {
    show({ ...base, blocked: "contractor-jo.testnet may not add proposals to this DAO." });
    expect(screen.getByRole("alert")).toHaveTextContent("contractor-jo.testnet may not add proposals to this DAO.");
    expect(screen.getByRole("button", { name: base.confirmLabel })).toBeDisabled();
  });
});

describe("TxFlow: the wallet signs and a relayer sends", () => {
  const gasless = (run: TxPlan["run"], over: Partial<TxPlan> = {}): TxPlan => ({ ...base, title: "Revoke this Budget without gas", confirmLabel: "Revoke without gas", txHeading: "The call your wallet will sign. The relayer sends it; your wallet sends nothing.", gasPayer: "relayer.payminto.testnet", run, ...over });

  it("says the relayer pays, walks through the steps, and never sends from the wallet", async () => {
    let release: (r: TxResult[]) => void = () => undefined;
    const onFinal = show(
      gasless(async ({ progress }) => {
        await signDelegateActions([TX]);
        progress({ title: "The relayer is sending it", body: "It pays the gas.", waiting: "Waiting for the relayer" });
        return new Promise<TxResult[]>((r) => (release = r));
      }),
    );
    expect(screen.getByText("Gas paid by")).toBeInTheDocument();
    expect(screen.getByText("The call your wallet will sign. The relayer sends it; your wallet sends nothing.")).toBeInTheDocument();
    confirm("Revoke without gas");
    expect(await screen.findByText("The relayer is sending it")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Waiting for the relayer" })).toBeDisabled();
    release([{ hash: "RelayedTx", status: "final" }]);
    expect(await screen.findByText("Final on NEAR")).toBeInTheDocument();
    expect(onFinal).toHaveBeenCalledTimes(1);
    expect(wallet.sent).toEqual([]);
    expect(wallet.delegated).toEqual([[TX]]);
  });

  it("shows a sent transaction that is not final yet, and checks again without sending", async () => {
    const recheck = vi.fn(async (): Promise<TxResult[]> => [{ hash: "RelayedTx", status: "final" }]);
    const onFinal = show(gasless(async () => [{ hash: "RelayedTx", status: "pending" }], { recheck }));
    confirm("Revoke without gas");
    expect(await screen.findByText("Sent, not final yet")).toBeInTheDocument();
    expect(onFinal).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "Review and try again" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Check again" }));
    expect(await screen.findByText("Final on NEAR")).toBeInTheDocument();
    expect(recheck).toHaveBeenCalledWith([{ hash: "RelayedTx", status: "pending" }]);
    expect(onFinal).toHaveBeenCalledTimes(1);
  });

  it("says the result is unknown and offers a check, never a blind retry", async () => {
    show(gasless(async () => [{ hash: "MaybeTx", status: "pending", unknown: true }], { recheck: async (r) => r }));
    confirm("Revoke without gas");
    expect(await screen.findByText("The result is unknown")).toBeInTheDocument();
    expect(screen.getByText(/Check the Budget before trying again/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Review and try again" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Revoke without gas" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Check again" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Check again" })).toBeEnabled());
    expect(screen.getByText("The result is unknown")).toBeInTheDocument();
  });

  it("shows a call the hub refused as not completed, with its transaction, and does not report final", async () => {
    const onFinal = show(gasless(async () => [{ hash: "FailedTx", status: "failed", error: "The hub refused the revoke: the signing account does not own this Budget. Nothing changed on the hub." }]));
    confirm("Revoke without gas");
    expect(await screen.findByText("Not completed")).toBeInTheDocument();
    expect(screen.getByText(/does not own this Budget/)).toBeInTheDocument();
    expect(screen.getByTitle("FailedTx")).toBeInTheDocument();
    expect(onFinal).not.toHaveBeenCalled();
  });

  it("shows a flow's own refusal as written, not as a wallet failure", async () => {
    show(gasless(async () => Promise.reject(new FlowError("The relayer does not pay for this action. Nothing was sent."))));
    confirm("Revoke without gas");
    expect(await screen.findByText("The relayer does not pay for this action. Nothing was sent.")).toBeInTheDocument();
    expect(screen.queryByText(/Your wallet could not finish/)).not.toBeInTheDocument();
  });
});

describe("TxFlowProvider", () => {
  function Opener() {
    const { open, flow } = useTxFlow();
    return (
      <>
        <button onClick={() => open(base)}>open</button>
        {flow}
      </>
    );
  }
  function Screen() {
    const [showControl, setShowControl] = useState(true);
    return (
      <TxFlowProvider>
        {showControl && <Opener />}
        <button onClick={() => setShowControl(false)}>remove the control</button>
      </TxFlowProvider>
    );
  }

  it("keeps the flow open when the control that opened it goes away", async () => {
    render(<Screen />);
    fireEvent.click(screen.getByText("open"));
    expect(await screen.findByText("Revoke this Budget on NEAR")).toBeInTheDocument();
    fireEvent.click(screen.getByText("remove the control", { ignore: false }));
    expect(screen.queryByText("open")).not.toBeInTheDocument();
    expect(screen.getByText("Revoke this Budget on NEAR")).toBeInTheDocument();
  });
});

describe("account ids inside sentences", () => {
  it("finds named accounts and leaves host names and plain words alone", () => {
    const parts = (t: string) => splitAccounts(t).filter((p) => p.account).map((p) => p.text);
    expect(parts("This needs alice.testnet, and your wallet is connected as bob-2.testnet.")).toEqual(["alice.testnet", "bob-2.testnet"]);
    expect(parts("The relayer sponsors the hub hub.someone-else.testnet, not northwind-ops.sputnik-v2.testnet.")).toEqual(["hub.someone-else.testnet", "northwind-ops.sputnik-v2.testnet"]);
    expect(parts("Read from rpc.testnet.near.org, or the hub app.near")).toEqual(["app.near"]);
    expect(parts("Nothing was sent. Try again.")).toEqual([]);
    expect(splitAccounts("pay alice.testnet now").map((p) => p.text).join("")).toBe("pay alice.testnet now");
  });
});
