/**
 * The business's browser wallet on an EVM chain (EIP-1193, `window.ethereum`), for one job: proving that a payout
 * address of the any-chain checkout is its own with a `personal_sign` (EIP-191). Each request opens the wallet's own
 * window, so the page asks for one thing per click: the accounts, then the signature.
 */

export type Eip1193Provider = { request(args: { method: string; params?: unknown[] }): Promise<unknown> };

let override: Eip1193Provider | null = null;

/** Demo mode installs its own wallet here; null puts the browser's back. */
export function setEvmProvider(p: Eip1193Provider | null): void {
  override = p;
}

/** The wallet this page talks to: the demo's, else the browser's injected one, else none. */
export function evmProvider(): Eip1193Provider | null {
  if (override) return override;
  if (typeof window === "undefined") return null;
  const injected = (window as unknown as { ethereum?: Eip1193Provider }).ethereum;
  return injected && typeof injected.request === "function" ? injected : null;
}

export class NoEvmWallet extends Error {
  constructor() {
    super("No browser wallet found. Install or unlock an Ethereum wallet such as MetaMask or Rabby in this browser, then try again.");
  }
}

/** `eth_requestAccounts`: the accounts the wallet shares with this page, lowercased. */
export async function requestEvmAccounts(): Promise<string[]> {
  const p = evmProvider();
  if (!p) throw new NoEvmWallet();
  const out = await p.request({ method: "eth_requestAccounts" });
  return Array.isArray(out) ? out.filter((a): a is string => typeof a === "string").map((a) => a.toLowerCase()) : [];
}

/** The message as `0x`-prefixed hex of its UTF-8 bytes, the form `personal_sign` takes. */
export function utf8Hex(text: string): string {
  return `0x${Array.from(new TextEncoder().encode(text), (b) => b.toString(16).padStart(2, "0")).join("")}`;
}

/** `personal_sign` (EIP-191) of exactly `message` by `address`; answers the 65-byte signature as hex. */
export async function personalSign(message: string, address: string): Promise<string> {
  const p = evmProvider();
  if (!p) throw new NoEvmWallet();
  const sig = await p.request({ method: "personal_sign", params: [utf8Hex(message), address] });
  if (typeof sig !== "string" || !/^0x[0-9a-fA-F]+$/.test(sig)) throw new Error("The wallet answered without a signature.");
  return sig;
}

/** A wallet's error in plain words: a refusal says so; anything else keeps the wallet's own message. */
export function evmWalletErrorMessage(e: unknown, what: "sign" | "pay" = "sign"): string {
  const code = typeof e === "object" && e !== null && "code" in e ? (e as { code: unknown }).code : undefined;
  if (code === 4001) return what === "pay" ? "You declined the payment in your wallet. No money moved." : "You declined the request in your wallet. Nothing was signed.";
  if (code === -32002) return "Your wallet already has a request open. Finish or close it in the wallet, then try again.";
  return e instanceof Error && e.message ? e.message : "The wallet could not complete the request.";
}

/** A transaction for `eth_sendTransaction`, with the chain it must go out on (`depositEvmTransaction` of `@payminto/protocol`). */
export type EvmPayment = { chainId: number; to: string; value: string; data: string };

const TX_HASH = /^0x[0-9a-fA-F]{64}$/;

/**
 * Pays from the browser wallet: the account, then the payment's chain (switching the wallet to it when it is on another
 * one), then the one transaction. It never sends on a chain other than the payment's: a wallet that cannot switch stops
 * here, before anything is signed. Answers the paying account and the transaction hash.
 */
/** What a payment takes from the wallet: `token` is the ERC-20 contract, or null for the chain's native coin. */
export type EvmNeed = { token: string | null; amount: bigint; decimals: number; symbol: string; chainName: string };

/** Base units in user units, without trailing zeros: 1501657 with 6 decimals is `1.501657`, 0 is `0`. */
function units(v: bigint, decimals: number): string {
  if (decimals === 0) return v.toString();
  const s = v.toString().padStart(decimals + 1, "0");
  const frac = s.slice(-decimals).replace(/0+$/, "");
  return frac ? `${s.slice(0, -decimals)}.${frac}` : s.slice(0, -decimals);
}

/** The wallet's balance of what the payment takes, read through the wallet's own connection to the chain. */
async function balanceOf(p: Eip1193Provider, from: string, need: EvmNeed): Promise<bigint> {
  if (need.token === null) return BigInt(String(await p.request({ method: "eth_getBalance", params: [from, "latest"] })));
  const data = `0x70a08231${from.slice(2).toLowerCase().padStart(64, "0")}`;
  const out = String(await p.request({ method: "eth_call", params: [{ to: need.token, data }, "latest"] }));
  return out === "0x" ? 0n : BigInt(out);
}

export async function payWithEvmWallet(tx: EvmPayment, chainName = "this network", need?: EvmNeed): Promise<{ from: string; hash: string }> {
  const p = evmProvider();
  if (!p) throw new NoEvmWallet();
  const [from] = await requestEvmAccounts();
  if (!from) throw new Error("Your wallet did not share an account with this page.");
  const want = `0x${tx.chainId.toString(16)}`;
  const on = await p.request({ method: "eth_chainId" });
  if (typeof on !== "string" || BigInt(on) !== BigInt(tx.chainId)) {
    try {
      await p.request({ method: "wallet_switchEthereumChain", params: [{ chainId: want }] });
    } catch (e) {
      const code = typeof e === "object" && e !== null && "code" in e ? (e as { code: unknown }).code : undefined;
      if (code === 4902) throw new Error(`Your wallet does not have ${chainName} yet. Add the ${chainName} network in your wallet, then try again.`);
      throw e;
    }
  }
  // A transfer the account cannot cover fails in the wallet after it opens ("Send failed"), with no word on why: say it here.
  if (need) {
    const have = await balanceOf(p, from, need);
    if (have < need.amount) {
      const who = `${from.slice(0, 6)}...${from.slice(-4)}`;
      throw new Error(
        `Your wallet ${who} holds ${units(have, need.decimals)} ${need.symbol} on ${need.chainName}, and this payment needs ${units(need.amount, need.decimals)} ${need.symbol}. Pick an account that holds it in your wallet, or add ${need.symbol} on ${need.chainName}, then try again.`,
      );
    }
  }
  const hash = await p.request({ method: "eth_sendTransaction", params: [{ from, to: tx.to, value: tx.value, data: tx.data }] });
  if (typeof hash !== "string" || !TX_HASH.test(hash)) throw new Error("The wallet answered without a transaction hash.");
  return { from, hash };
}

/**
 * Where a transaction the wallet answered stands, read through the wallet's own connection: `mined` (it succeeded),
 * `reverted` (it ran and failed: nothing moved), `pending` (the chain knows it, not in a block yet) or `unknown` (the
 * chain has never seen it: the wallet may still be sending it, or it failed before it was sent, as a wallet's
 * "Send failed" does).
 */
export async function checkEvmTransaction(hash: string): Promise<"mined" | "reverted" | "pending" | "unknown"> {
  const p = evmProvider();
  if (!p) throw new NoEvmWallet();
  const rc = (await p.request({ method: "eth_getTransactionReceipt", params: [hash] })) as { status?: string } | null;
  if (rc) return rc.status === "0x0" ? "reverted" : "mined";
  const tx = await p.request({ method: "eth_getTransactionByHash", params: [hash] });
  return tx ? "pending" : "unknown";
}
