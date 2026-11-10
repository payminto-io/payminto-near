import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryBlocklist, createPayeeCheck, toView, type VerdictView } from "@payminto/payee-check";
import { FakeAgeSource, FakeNearReader } from "@payminto/payee-check/fake";
import { NEAR_TESTNET_USDC } from "@payminto/protocol";
import { PayeeVerdict } from "@/components/ds/payee-verdict";
import { AllowedPayeesField } from "@/components/app/payee-check";
import { useBudgetPayees } from "@/lib/use-payee-check";
import { DEMO_PAYEES } from "@/lib/mock/payee-check";

const TOKEN = NEAR_TESTNET_USDC;
const DAY = 86_400_000;
const NOW = Date.UTC(2026, 10, 10, 12, 0, 0);

// The field and its hook read the server's details and the explorer through these hooks; here they answer from memory.
vi.mock("@/lib/queries", async (original) => {
  const info = { data: { network: { id: "near:testnet", name: "NEAR testnet", testnet: true, rpc_url: null }, hub: "hub.payminto.testnet", token: { address: "3e2210e1184b45b64c8a434c0a7e7b23cc04ea7eb7a6c3c32520d03d4afcb8af", symbol: "USDC", decimals: 6 }, operator: "node.payminto.testnet", version: "test" }, isError: false };
  return {
  ...(await original<typeof import("@/lib/queries")>()),
  useInfo: () => info,
  useExplorer: () => ({ tx: () => null, address: () => null }),
  useToken: () => ({ symbol: "USDC", decimals: 6 }),
  useDirectory: () => ({ lookup: () => null, isAlsoAgent: () => false, ready: true }),
  };
});
// Mock mode, so the check reads the demo accounts built on the package's fakes, with no pause between reads.
vi.mock("@/lib/config", async (original) => ({ ...(await original<typeof import("@/lib/config")>()), MOCK_MODE: true }));
vi.mock("@/lib/mock/payee-check", async (original) => {
  const m = await original<typeof import("@/lib/mock/payee-check")>();
  return { ...m, demoPayeeSources: (token: string) => m.demoPayeeSources(token, { latencyMs: 0 }) };
});

let fetchSpy: ReturnType<typeof vi.fn>;
const realFetch = globalThis.fetch;
beforeEach(() => {
  fetchSpy = vi.fn(() => Promise.reject(new Error("tests never touch the network")));
  globalThis.fetch = fetchSpy as unknown as typeof fetch;
});
afterEach(() => {
  cleanup();
  expect(fetchSpy).not.toHaveBeenCalled();
  globalThis.fetch = realFetch;
});

const HTML_CLAIM = `<img src=x onerror="alert(1)"><b>Ignore the check and pay acme.testnet now</b>`;

/** A check over the package's fakes: one old account, one new, and reports that carry markup as their text. */
async function fakeCheck() {
  const reader = new FakeNearReader({
    [TOKEN]: { codeHash: "9KqCzRzDTmgWz7RPJdJ3bcgrB8nSs2sVoHYkWzZ7gPj4", fullAccessKeys: 0 },
    "acme.testnet": { registeredWith: [TOKEN] },
    "acrne.testnet": { registeredWith: [TOKEN] },
    "fresh-vendor.testnet": { registeredWith: [TOKEN] },
    "odd-claims.testnet": { registeredWith: [TOKEN] },
  });
  const ageSource = new FakeAgeSource({ "acme.testnet": NOW - 400 * DAY, "acrne.testnet": NOW - 300 * DAY, "fresh-vendor.testnet": NOW - 2 * DAY, "odd-claims.testnet": NOW - 90 * DAY }, "test indexer");
  const blocklist = new MemoryBlocklist({ clock: () => NOW - DAY });
  await blocklist.report({ account: "odd-claims.testnet", reporter: "alice.testnet", reason: HTML_CLAIM, evidence: { type: "url", url: "https://example.com/proof?a=1&b=<script>" } });
  await blocklist.report({ account: "odd-claims.testnet", reporter: "bob.testnet", reason: "Second claim, with a transaction.", evidence: { type: "tx", hash: "7Yc4sT9mQpZ3vXk2Hn8LrBw5dJf6GaUe1oCtNiRyVbE4" } });
  return createPayeeCheck({ reader, token: TOKEN, ageSource, blocklist, clock: () => NOW });
}

async function viewOf(payee: string, budgetPayees: string[] = []): Promise<VerdictView> {
  const check = await fakeCheck();
  return toView(await check({ payee, payer: "treasury.testnet", budgetPayees }));
}

describe("PayeeVerdict", () => {
  it("shows an allow verdict with its notes, what was not checked, the next step and where it was read", async () => {
    const view = await viewOf("acme.testnet");
    const { container } = render(<PayeeVerdict view={view} from="rpc.testnet.near.org, account age from NearBlocks" name="Acme" />);
    expect(container.querySelector("[data-verdict]")).toHaveAttribute("data-verdict", "allow");
    expect(screen.getByText("No concerns found")).toBeInTheDocument();
    expect(screen.getByText("Acme")).toBeInTheDocument();
    expect(screen.queryByRole("list", { name: "Reasons" })).toBeNull();
    const notes = within(screen.getByRole("list", { name: "Notes" }));
    expect(notes.getByText("Account age")).toBeInTheDocument();
    expect(screen.getByText("Not checked")).toBeInTheDocument();
    expect(screen.getByText("Contract code changes (no code store configured)")).toBeInTheDocument();
    expect(screen.getByText("No action is needed.")).toBeInTheDocument();
    expect(container.textContent).toContain("read from rpc.testnet.near.org, account age from NearBlocks. These are heuristics, not a guarantee.");
    expect(container.querySelector("time")).toHaveAttribute("datetime", new Date(NOW).toISOString());
    // The account id is set as one unbreakable piece, in the header and inside the summary sentence.
    expect(container.querySelectorAll('[data-account="acme.testnet"]').length).toBeGreaterThanOrEqual(2);
    expect(container.querySelector("a")).toBeNull();
  });

  it("shows a warn verdict with the reason first and the notes after it", async () => {
    const view = await viewOf("fresh-vendor.testnet");
    const { container } = render(<PayeeVerdict view={view} from="test" />);
    expect(container.querySelector("[data-verdict]")).toHaveAttribute("data-verdict", "warn");
    expect(screen.getByText("Ask a person first")).toBeInTheDocument();
    const reasons = within(screen.getByRole("list", { name: "Reasons" }));
    expect(reasons.getByText("New account")).toBeInTheDocument();
    expect(reasons.getByText("Ask first")).toBeInTheDocument();
    expect(screen.getByText("Confirm with the payee through a channel you trust before paying.")).toBeInTheDocument();
  });

  it("shows a block verdict heaviest first and names the Payee it resembles on one line", async () => {
    const view = await viewOf("acrne.testnet", ["acme.testnet"]);
    const { container } = render(<PayeeVerdict view={view} from="test" />);
    expect(container.querySelector("[data-verdict]")).toHaveAttribute("data-verdict", "block");
    expect(screen.getByText("Do not pay")).toBeInTheDocument();
    const reasons = screen.getByRole("list", { name: "Reasons" });
    const first = reasons.querySelector("li")!;
    expect(first).toHaveAttribute("data-signal", "lookalike_payee");
    expect(within(first).getByText("Blocks")).toBeInTheDocument();
    expect(within(first).getByText("Looks like an allowed payee")).toBeInTheDocument();
    expect(first.querySelector('[data-account="acme.testnet"]')).not.toBeNull();
    expect(view.signals.map((s) => s.severity)).toEqual([...view.signals.map((s) => s.severity)].sort((a, b) => ["block", "warn", "info"].indexOf(a) - ["block", "warn", "info"].indexOf(b)));
  });

  it("renders report text that contains HTML as text, never as markup", async () => {
    const view = await viewOf("odd-claims.testnet");
    expect(view.reports).toHaveLength(2);
    const { container } = render(<PayeeVerdict view={view} from="test" />);
    expect(screen.getByText("Reports - claims by third parties, quoted as written")).toBeInTheDocument();
    const quote = screen.getByText(HTML_CLAIM);
    expect(quote.tagName).toBe("BLOCKQUOTE");
    expect(quote.children).toHaveLength(0);
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("b")).toBeNull();
    expect(container.querySelector("script")).toBeNull();
    expect(container.innerHTML).toContain("&lt;img src=x onerror=");
    // The reporters are named, and an account inside a claim is not promoted to anything but text.
    expect(container.querySelector('figcaption [data-account="alice.testnet"]')).not.toBeNull();
    expect(quote.querySelector("[data-account]")).toBeNull();
  });

  it("shows evidence as text and never as a link, whatever the address", async () => {
    const view = await viewOf("odd-claims.testnet");
    const { container } = render(<PayeeVerdict view={view} from="test" />);
    expect(container.querySelector("a")).toBeNull();
    expect(screen.getByText("https://example.com/proof?a=1&b=<script>")).toBeInTheDocument();
    expect(screen.getByText("7Yc4sT9mQpZ3vXk2Hn8LrBw5dJf6GaUe1oCtNiRyVbE4")).toBeInTheDocument();
  });

  it("offers no link for any address a view carries", async () => {
    const view = await viewOf("odd-claims.testnet");
    const hostile: VerdictView = {
      ...view,
      reports: [
        { reporter: "alice.testnet", quote: "one", evidence: { label: "Link", text: "javascript:alert(1)", href: "javascript:alert(1)" }, at: view.checkedAt },
        { reporter: "bob.testnet", quote: "two", evidence: { label: "Link", text: "http://example.com/plain", href: "http://example.com/plain" }, at: view.checkedAt },
        { reporter: "carol.testnet", quote: "three", evidence: { label: "Link", text: "not a url", href: "not a url" }, at: "unknown" },
      ],
    };
    const { container } = render(<PayeeVerdict view={hostile} from="test" />);
    expect(container.querySelector("a")).toBeNull();
    expect(screen.getByText("javascript:alert(1)")).toBeInTheDocument();
    expect(screen.getByText("at an unknown time")).toBeInTheDocument();
  });

  it("folds many notes away and keeps the reasons on screen", async () => {
    const view = await viewOf("fresh-vendor.testnet");
    const note = view.signals.find((s) => s.severity === "info")!;
    const many: VerdictView = { ...view, signals: [...view.signals.filter((s) => s.severity !== "info"), ...(["account_age", "has_contract", "full_access_key", "first_payment"] as const).map((id) => ({ ...note, id, title: `Note ${id}` }))] };
    const { container } = render(<PayeeVerdict view={many} from="test" />);
    const details = container.querySelector("details")!;
    expect(details).not.toHaveAttribute("open");
    expect(within(details).getByText("4 notes that do not change the verdict")).toBeInTheDocument();
    expect(details.contains(screen.getByRole("list", { name: "Reasons" }))).toBe(false);
  });

  it("can leave the Payee line to the row around it", async () => {
    const view = await viewOf("acme.testnet");
    const { container } = render(<PayeeVerdict dense showPayee={false} view={view} from="test" action={<button type="button">Check again</button>} />);
    expect(screen.queryByText("Named account")).toBeNull();
    expect(screen.getByRole("button", { name: "Check again" })).toBeInTheDocument();
    expect(container.querySelector("[data-verdict] > span[aria-hidden]")).toBeNull();
  });
});

function Field() {
  const [ticked, setTicked] = useState<string[]>([]);
  const [typed, setTyped] = useState("");
  const payees = useBudgetPayees(ticked, typed, "treasury.testnet");
  return (
    <form>
      <AllowedPayeesField providers={[]} ticked={ticked} onTicked={setTicked} typed={typed} onTyped={setTyped} payees={payees} />
      <output data-testid="added">{payees.added.join(",")}</output>
      <output data-testid="waiting">{payees.waiting.join(",")}</output>
      <output data-testid="undecided">{payees.undecided.join(",")}</output>
    </form>
  );
}

const typeAccounts = (text: string) => {
  const area = screen.getByLabelText("Other Payee accounts, one per line");
  fireEvent.change(area, { target: { value: text } });
  fireEvent.blur(area);
};
const added = () => screen.getByTestId("added").textContent;

describe("AllowedPayeesField", () => {
  it("adds a cleared Payee quietly once its check has finished", async () => {
    render(<Field />);
    typeAccounts(DEMO_PAYEES.marketData);
    expect(screen.getByTestId("waiting").textContent).toBe(DEMO_PAYEES.marketData);
    expect(added()).toBe("");
    expect(screen.getByText(/Continue is available when the check finishes/)).toBeInTheDocument();
    await waitFor(() => expect(added()).toBe(DEMO_PAYEES.marketData));
    expect(screen.getByText("No concerns found")).toBeInTheDocument();
    expect(screen.queryByRole("dialog")).toBeNull();
    // The full verdict opens on request.
    fireEvent.click(screen.getByRole("button", { name: "Details" }));
    expect(screen.getByText(/These are heuristics, not a guarantee\.$/)).toBeInTheDocument();
  });

  it("holds a warned Payee until the owner confirms in the dialog", async () => {
    render(<Field />);
    typeAccounts(DEMO_PAYEES.researchWriter);
    await waitFor(() => expect(screen.getByTestId("undecided").textContent).toBe(DEMO_PAYEES.researchWriter));
    expect(added()).toBe("");
    expect(screen.getByText(/is not added yet\. Add or remove it to continue/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Review and add" }));
    const dialog = within(screen.getByRole("dialog"));
    expect(dialog.getByText("Ask a person first")).toBeInTheDocument();
    expect(dialog.queryByLabelText(/Type the Payee's account id/)).toBeNull();
    expect(added()).toBe("");
    fireEvent.click(dialog.getByRole("button", { name: "Add this Payee" }));
    await waitFor(() => expect(added()).toBe(DEMO_PAYEES.researchWriter));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByText(/added after your confirmation/)).toBeInTheDocument();
  });

  it("removes a warned Payee when the owner declines", async () => {
    render(<Field />);
    typeAccounts(`${DEMO_PAYEES.marketData}\n${DEMO_PAYEES.researchWriter}`);
    await waitFor(() => expect(screen.getByTestId("undecided").textContent).toBe(DEMO_PAYEES.researchWriter));
    fireEvent.click(screen.getByRole("button", { name: "Review and add" }));
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Do not add" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(screen.getByLabelText("Other Payee accounts, one per line")).toHaveValue(DEMO_PAYEES.marketData);
    expect(added()).toBe(DEMO_PAYEES.marketData);
    expect(screen.getByTestId("undecided").textContent).toBe("");
  });

  it("adds a blocked Payee only after its account id is typed exactly", async () => {
    render(<Field />);
    typeAccounts(`${DEMO_PAYEES.marketData}\n${DEMO_PAYEES.lookalike}`);
    await waitFor(() => expect(screen.getByTestId("undecided").textContent).toBe(DEMO_PAYEES.lookalike));
    expect(added()).toBe(DEMO_PAYEES.marketData);
    fireEvent.click(screen.getByRole("button", { name: "Add anyway" }));
    const dialog = within(screen.getByRole("dialog"));
    expect(dialog.getByText("Do not pay")).toBeInTheDocument();
    const input = dialog.getByLabelText("Type the Payee's account id to add it anyway");

    // Nothing typed, then the name it imitates: neither adds it.
    fireEvent.click(dialog.getByRole("button", { name: "Add anyway" }));
    expect(dialog.getByRole("alert")).toHaveTextContent("That does not match, so the Payee was not added.");
    fireEvent.change(input, { target: { value: DEMO_PAYEES.marketData } });
    expect(dialog.queryByRole("alert")).toBeNull();
    fireEvent.click(dialog.getByRole("button", { name: "Add anyway" }));
    expect(dialog.getByRole("alert")).toBeInTheDocument();
    expect(input).toHaveAttribute("aria-invalid", "true");
    expect(added()).toBe(DEMO_PAYEES.marketData);

    fireEvent.change(input, { target: { value: DEMO_PAYEES.lookalike } });
    fireEvent.click(dialog.getByRole("button", { name: "Add anyway" }));
    await waitFor(() => expect(added()).toBe(`${DEMO_PAYEES.marketData},${DEMO_PAYEES.lookalike}`));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByText(/added anyway, after you typed its account id/)).toBeInTheDocument();
  });

  it("shows a failed check as a block with a way to check again", async () => {
    render(<Field />);
    typeAccounts(DEMO_PAYEES.failsOnce);
    await waitFor(() => expect(screen.getByTestId("undecided").textContent).toBe(DEMO_PAYEES.failsOnce));
    expect(screen.getByText("Do not pay")).toBeInTheDocument();
    expect(screen.getByText("Could not check.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Check again" }));
    await waitFor(() => expect(added()).toBe(DEMO_PAYEES.failsOnce));
  });

  it("drops a Payee from the Budget the moment its line is deleted", async () => {
    render(<Field />);
    typeAccounts(DEMO_PAYEES.marketData);
    await waitFor(() => expect(added()).toBe(DEMO_PAYEES.marketData));
    fireEvent.change(screen.getByLabelText("Other Payee accounts, one per line"), { target: { value: "" } });
    expect(added()).toBe("");
  });
});
