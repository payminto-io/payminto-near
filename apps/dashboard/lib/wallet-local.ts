/**
 * The wallet of `pnpm local` (apps/local): a `WalletDriver` backed by the local signer service.
 *
 * DEVELOPMENT ONLY. No browser wallet can connect to a NEAR node on 127.0.0.1, so on a local sandbox the signer holds
 * the keys of a few named test accounts and signs for the dashboard. This driver is loaded only when `LOCAL_SIGNER` in
 * lib/config.ts is set, which needs the wallet network to be exactly `sandbox`. It checks twice more before it shows an
 * account: the signer must say it serves `near:sandbox`, and so must the Payminto server behind this dashboard.
 *
 * In place of the wallet modal it opens a small account picker. Every screen still shows the exact transaction before
 * it calls this driver, as it does with a real wallet.
 *
 * The choice of account belongs to the page it was made on. A person here plays several people (an owner on a Budget
 * page, a shopper on a checkout page), and a real wallet lets them switch accounts in its own window, which this has
 * not got. So a choice is forgotten when the page changes, and the next page that needs a signature asks again, with
 * the last account marked. Nothing is ever signed by an account picked for another page.
 */
import type { AccountId, WalletTx } from "@payminto/protocol";
import type { LocalSigner } from "./config";
import { WalletError, type DelegateSupport, type ExecutionOutcome, type SignMessageInput, type SignedMessage, type WalletDriver } from "./wallet";

export const LOCAL_NETWORK = "near:sandbox";

export type LocalAccount = {
  accountId: AccountId;
  /** "Budget owner", "Shopper" and so on. */
  role: string;
  /** What the account does in the walkthrough. */
  does: string;
  publicKey: string;
  /** yoctoNEAR and atomic USDC, as decimal strings. */
  balances: { near: string; usdc: string };
};

export type PickRequest = {
  accounts: LocalAccount[];
  /** The account the screen needs, when it needs one. */
  expected?: AccountId;
  /** The account chosen last, on this page or another, so it is easy to find again. */
  current: AccountId | null;
};
/** Shows the picker and resolves with the chosen account, or null when the person closes it. */
export type Picker = (req: PickRequest) => Promise<AccountId | null>;

/** A NEP-366 delegate action signed by a local account: the base64 Borsh `SignedDelegateAction` a relayer takes. */
export type SignedDelegate = { accountId: AccountId; publicKey: string; receiverId: AccountId; signedDelegate: string; maxBlockHeight: string; nonce: string };

export type LocalDriverDeps = {
  fetch?: typeof fetch;
  pick?: Picker;
  /** Reads the network id of the Payminto server behind this dashboard. */
  serverNetwork?: () => Promise<string>;
  /** Told about each sent transaction, so the page can say it ran on a local node. */
  notify?: (note: { account: AccountId; hash: string; ok: boolean }) => void;
  storage?: Pick<Storage, "getItem" | "setItem" | "removeItem"> | null;
  /** The page the person is on. A choice of account lasts while this stays the same. */
  page?: () => string;
  /** How often to look for a page change, in milliseconds; 0 looks only when the driver is used. */
  watchMs?: number;
};

export type LocalSignerDriver = WalletDriver & {
  accounts(): Promise<LocalAccount[]>;
  /** NEP-366: the chosen account signs the call for a relayer to submit and pay for. */
  signDelegateAction(tx: WalletTx, blockHeightOffset?: number): Promise<SignedDelegate>;
};

const STORAGE_KEY = "payminto.local.account";

const toBase64 = (b: Uint8Array): string => btoa(String.fromCharCode(...b));

function browserStorage(): LocalDriverDeps["storage"] {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

/** The server's own word on its network, through the dashboard's `/api` path. */
async function serverNetworkOf(f: typeof fetch): Promise<string> {
  const res = await f("/api/v1/info", { headers: { accept: "application/json" }, cache: "no-store" });
  if (!res.ok) throw new Error(`status ${res.status}`);
  return ((await res.json()) as { network?: { id?: string } }).network?.id ?? "";
}

/** Mounts the picker on its own root, so this driver needs nothing from the page it is used on. */
const mountedPicker: Picker = async (req) => {
  const [{ createElement }, { createRoot }, { LocalAccountPicker }] = await Promise.all([import("react"), import("react-dom/client"), import("@/components/app/local-account-picker")]);
  const host = document.createElement("div");
  host.dataset.localAccountPicker = "";
  document.body.appendChild(host);
  const root = createRoot(host);
  return new Promise<AccountId | null>((resolve) => {
    const done = (account: AccountId | null) => {
      resolve(account);
      // After the close animation, so the dialog does not vanish mid-fade.
      setTimeout(() => {
        root.unmount();
        host.remove();
      }, 250);
    };
    root.render(createElement(LocalAccountPicker, { ...req, onPick: done }));
  });
};

const toastNote: NonNullable<LocalDriverDeps["notify"]> = (note) => {
  void import("sonner").then(({ toast }) => {
    const text = `Transaction ${note.hash.slice(0, 8)}...${note.hash.slice(-6)} ran on the NEAR node on this machine. A local node has no public explorer.`;
    const action = { label: "Copy hash", onClick: () => void navigator.clipboard?.writeText(note.hash) };
    // At the top: the screen's own result (a sheet at the bottom of a phone) must stay readable underneath.
    const options = { description: text, action, duration: 6000, position: "top-center" as const };
    if (note.ok) toast.success(`Signed by ${note.account}`, options);
    else toast.error(`Signed by ${note.account}, and it failed`, options);
  });
};

type Stored = { account: AccountId; page: string };

export function localSignerDriver(signer: LocalSigner, deps: LocalDriverDeps = {}): LocalSignerDriver {
  const f = deps.fetch ?? ((input, init) => fetch(input, init));
  const pick = deps.pick ?? mountedPicker;
  const notify = deps.notify ?? toastNote;
  const storage = deps.storage === undefined ? browserStorage() : deps.storage;
  const serverNetwork = deps.serverNetwork ?? (() => serverNetworkOf(f));
  const page = deps.page ?? (() => window.location.pathname);
  const watchMs = deps.watchMs ?? 300;
  const listeners = new Set<(a: AccountId | null) => void>();
  /** The account that signs on `chosenOn`, and the last account chosen anywhere. */
  let current: AccountId | null = null;
  let chosenOn: string | null = null;
  let last: AccountId | null = null;
  let checked: Promise<void> | null = null;
  let watching = false;

  const unavailable = (why: string, cause?: unknown) => new WalletError("unavailable", why, { cause });

  async function call<T>(path: string, body?: Record<string, unknown>): Promise<T> {
    let res: Response;
    try {
      res = await f(`${signer.url}${path}`, {
        method: body ? "POST" : "GET",
        headers: { authorization: `Bearer ${signer.token}`, ...(body ? { "content-type": "application/json" } : {}) },
        ...(body ? { body: JSON.stringify({ network: LOCAL_NETWORK, ...body }) } : {}),
        cache: "no-store",
      });
    } catch (e) {
      throw unavailable("The local signer is not answering. Check that pnpm local is still running, then try again.", e);
    }
    const parsed = (await res.json().catch(() => null)) as (T & { error?: { code?: string; message?: string } }) | null;
    if (res.status === 401) throw unavailable("The local signer was restarted, so this page holds an old token. Reload the page.");
    if (!res.ok || !parsed) throw new WalletError("failed", `The local signer could not finish: ${parsed?.error?.message ?? `status ${res.status}`}`);
    return parsed;
  }

  /** Both the signer and the server behind this dashboard must be on the sandbox, or nothing is shown or signed. */
  function assertSandbox(): Promise<void> {
    checked ??= (async () => {
      const network = await serverNetwork().catch((e: unknown) => {
        throw unavailable("This dashboard could not ask its Payminto server which network it is on, so the local signer stays off.", e);
      });
      if (network !== LOCAL_NETWORK) throw unavailable(`The local signer only works on a local sandbox, and this dashboard's server is on ${network || "an unknown network"}. Use a NEAR wallet there.`);
    })();
    checked.catch(() => {
      checked = null;
    });
    return checked;
  }

  async function accounts(): Promise<LocalAccount[]> {
    await assertSandbox();
    const out = await call<{ network?: string; development_only?: boolean; accounts?: LocalAccount[] }>("/v1/accounts");
    if (out.network !== LOCAL_NETWORK || out.development_only !== true) throw unavailable("The service at the local signer address does not say it is a sandbox development signer, so this page will not use it.");
    return out.accounts ?? [];
  }

  function remember(value: Stored | null): void {
    try {
      if (value) storage?.setItem(STORAGE_KEY, JSON.stringify(value));
      else storage?.removeItem(STORAGE_KEY);
    } catch {
      // Storage blocked: the choice lasts until reload.
    }
  }

  function remembered(): Stored | null {
    try {
      const v = JSON.parse(storage?.getItem(STORAGE_KEY) ?? "null") as Partial<Stored> | null;
      return v && typeof v.account === "string" && typeof v.page === "string" ? { account: v.account, page: v.page } : null;
    } catch {
      return null;
    }
  }

  function set(account: AccountId | null): void {
    const changed = account !== current;
    current = account;
    chosenOn = account ? page() : null;
    if (account) last = account;
    if (account) remember({ account, page: chosenOn! });
    if (changed) for (const l of listeners) l(account);
  }

  /** The account chosen on this page, or null. A choice made on another page is dropped here, and the page is told. */
  function here(): AccountId | null {
    if (current && chosenOn !== page()) set(null);
    return current;
  }

  /** Notices a page change soon after it happens, so a screen never shows the previous page's account as connected. */
  function watch(): void {
    if (watching || watchMs <= 0 || typeof window === "undefined") return;
    watching = true;
    window.setInterval(here, watchMs);
  }

  async function connect(expected?: AccountId): Promise<AccountId> {
    const list = await accounts();
    if (list.length === 0) throw unavailable("The local signer holds no accounts.");
    const chosen = await pick({ accounts: list, expected, current: here() ?? last ?? remembered()?.account ?? null });
    if (!chosen) throw new WalletError("rejected", "You closed the account picker. Nothing was sent.");
    if (!list.some((a) => a.accountId === chosen)) throw new WalletError("failed", `${chosen} is not one of the local test accounts.`);
    set(chosen);
    watch();
    return chosen;
  }

  /** Who signs now: the account chosen on this page, or the picker's answer. A wallet asks too when it is not connected. */
  const signerNow = async (): Promise<AccountId> => here() ?? (await connect());

  async function send(txs: readonly WalletTx[]): Promise<ExecutionOutcome[]> {
    const account = await signerNow();
    await assertSandbox();
    const { outcomes } = await call<{ outcomes: ExecutionOutcome[] }>("/v1/sign-and-send", { accountId: account, transactions: txs });
    for (const o of outcomes) {
      const hash = o.transaction?.hash ?? o.transaction_outcome?.id ?? "";
      const failed = !!o.status && typeof o.status === "object" && o.status.Failure !== undefined;
      if (hash) notify({ account, hash, ok: !failed });
    }
    return outcomes;
  }

  return {
    accounts,
    connect,
    async disconnect() {
      set(null);
      remember(null);
    },
    async account() {
      if (here()) return current;
      // After a reload on the same page, the choice made there still stands, if the signer still has the account:
      // every `pnpm local` start makes new accounts under the same names.
      const stored = remembered();
      if (!stored) return null;
      last = stored.account;
      if (stored.page !== page()) return null;
      try {
        const list = await accounts();
        if (list.some((a) => a.accountId === stored.account)) {
          set(stored.account);
          watch();
        }
      } catch {
        // The signer is not answering: not connected, and the next signature says why.
      }
      return current;
    },
    async signAndSendTransaction(tx) {
      const [outcome] = await send([tx]);
      if (!outcome) throw new WalletError("failed", "The local signer returned no result.");
      return outcome;
    },
    signAndSendTransactions: (txs) => send(txs),
    async signMessage(input: SignMessageInput): Promise<SignedMessage> {
      // A message is signed by whoever it is about (a payout account proving itself), which is rarely the account
      // chosen for this page's transactions, so it always asks. An account named in the message is the one needed.
      const named = (await accounts()).filter((a) => input.message.includes(a.accountId)).sort((a, b) => b.accountId.length - a.accountId.length)[0];
      const account = await connect(named?.accountId);
      await assertSandbox();
      return call<SignedMessage>("/v1/sign-message", { accountId: account, message: input.message, recipient: input.recipient, nonce: toBase64(input.nonce) });
    },
    async signDelegateAction(tx, blockHeightOffset) {
      const account = await signerNow();
      await assertSandbox();
      return call<SignedDelegate>("/v1/sign-delegate", { accountId: account, transaction: tx, ...(blockHeightOffset === undefined ? {} : { blockHeightOffset }) });
    },
    // The gasless revoke and reclaim (lib/gasless.ts) ask through the shared driver interface, one call at a time.
    async signDelegateActions(delegates) {
      const account = await signerNow();
      await assertSandbox();
      const out: string[] = [];
      for (const tx of delegates) out.push((await call<SignedDelegate>("/v1/sign-delegate", { accountId: account, transaction: tx })).signedDelegate);
      return out;
    },
    async delegateSupport(): Promise<DelegateSupport> {
      return { wallet: here() ? "Local signer" : null, supported: true, capable: ["Local signer"] };
    },
    onAccountChange(cb) {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
  };
}
