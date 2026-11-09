/**
 * Browser wallet (EIP-1193) steps for the gateway: connect, put the wallet on the node's chain (adding it when the
 * wallet does not know it), read the token balance, sign an EIP-3009 authorization, or send a plain transfer.
 * Used by the hosted checkout (payer) and by refunds (the merchant's payout wallet).
 */
import {
  createPublicClient,
  createWalletClient,
  custom,
  erc20Abi,
  getAddress,
  numberToHex,
  type Address,
  type EIP1193Provider,
  type Hex,
} from "viem";
import { hspAgenticTypedData, networks, type HspEip712Json } from "@payminto/protocol";
import { checkoutSignData, refundSignData } from "./gateway";
import type { AuthorizationTemplate } from "./schemas";

export type ChainTarget = { chainId: number; name: string; rpcUrl?: string | null; explorer?: string | null };

export function injected(): EIP1193Provider | null {
  return typeof window !== "undefined" && window.ethereum ? window.ethereum : null;
}

function need(): EIP1193Provider {
  const p = injected();
  if (!p) throw new Error("No browser wallet found. Install or unlock one, then try again.");
  return p;
}

export async function connectWallet(): Promise<Address> {
  const wallet = createWalletClient({ transport: custom(need()) });
  const [account] = await wallet.requestAddresses();
  if (!account) throw new Error("The wallet did not share an account.");
  return getAddress(account);
}

/** Accounts the wallet already shared with this site, without prompting. */
export async function connectedAccount(): Promise<Address | null> {
  const p = injected();
  if (!p) return null;
  try {
    const accounts = (await p.request({ method: "eth_accounts" })) as string[];
    return accounts[0] ? getAddress(accounts[0]) : null;
  } catch {
    return null;
  }
}

/** wallet_addEthereumChain parameters, from what the node reports with the protocol package as the fallback. */
export function addChainParams(t: ChainTarget) {
  const known = networks[t.chainId]?.chain;
  const rpc = t.rpcUrl || known?.rpcUrls.default.http[0];
  if (!rpc) return null;
  const explorer = t.explorer || known?.blockExplorers?.default.url;
  return {
    chainId: numberToHex(t.chainId),
    chainName: t.name || known?.name || `Chain ${t.chainId}`,
    nativeCurrency: known?.nativeCurrency ?? { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: [rpc],
    ...(explorer ? { blockExplorerUrls: [explorer] } : {}),
  };
}

function errorCode(e: unknown): number | undefined {
  const any = e as { code?: number; cause?: { code?: number }; data?: { originalError?: { code?: number } } };
  return any?.code ?? any?.cause?.code ?? any?.data?.originalError?.code;
}

/** Switches the wallet to the target chain, adding it first when the wallet answers 4902 (unknown chain). */
export async function ensureChain(t: ChainTarget): Promise<void> {
  const provider = need();
  const current = Number.parseInt((await provider.request({ method: "eth_chainId" })) as string, 16);
  if (current === t.chainId) return;
  try {
    await provider.request({ method: "wallet_switchEthereumChain", params: [{ chainId: numberToHex(t.chainId) }] });
  } catch (e) {
    if (errorCode(e) !== 4902) throw e;
    const params = addChainParams(t);
    if (!params) throw new Error(`Add ${t.name} (chain ${t.chainId}) to your wallet, then try again.`);
    await provider.request({ method: "wallet_addEthereumChain", params: [params] });
  }
}

export async function tokenBalance(token: Address, owner: Address): Promise<bigint> {
  const client = createPublicClient({ transport: custom(need()) });
  return client.readContract({ address: token, abi: erc20Abi, functionName: "balanceOf", args: [owner] });
}

/** Signs the checkout's EIP-3009 authorization as the payer. */
export async function signAuthorization(template: AuthorizationTemplate, from: Address): Promise<Hex> {
  const wallet = createWalletClient({ transport: custom(need()) });
  const data = checkoutSignData(template, from);
  // Narrowed per kind so viem checks each typed-data shape on its own.
  return data.primaryType === "TransferWithAuthorization" ? wallet.signTypedData({ account: from, ...data }) : wallet.signTypedData({ account: from, ...data });
}

/**
 * Signs the EIP-712 data HSP's prepare_payment returned (GATEWAY.md section 17), exactly as returned: only JSON
 * integers become bigints. The HSP gateway, not the wallet, broadcasts the transfer.
 */
export async function signHspPayment(eip712: HspEip712Json, from: Address): Promise<Hex> {
  const wallet = createWalletClient({ transport: custom(need()) });
  const data = hspAgenticTypedData(eip712) as unknown as Omit<Parameters<typeof wallet.signTypedData>[0], "account">;
  return wallet.signTypedData({ account: from, ...data });
}

/** Signs a refund's router authorization as the payout wallet; returns the signed message and terms for /submit. */
export async function signRefund(args: Parameters<typeof refundSignData>[0]) {
  const wallet = createWalletClient({ transport: custom(need()) });
  const { typedData, terms } = refundSignData(args);
  const signature = await wallet.signTypedData({ account: args.from, ...typedData });
  const m = typedData.message;
  return {
    authorization: { from: m.from, to: m.to, value: m.value.toString(), validAfter: m.validAfter.toString(), validBefore: m.validBefore.toString(), nonce: m.nonce, signature },
    terms: { ...terms, fee: terms.fee.toString() },
  };
}

/**
 * A plain ERC-20 transfer from the connected wallet. `chain: null` sends on the wallet's current chain, which
 * ensureChain has already set, so no protocol Chain object crosses into this package's viem types.
 */
export async function sendTransfer(args: { token: Address; to: Address; amount: bigint; from: Address }): Promise<Hex> {
  const wallet = createWalletClient({ transport: custom(need()) });
  return wallet.writeContract({ account: args.from, chain: null, address: args.token, abi: erc20Abi, functionName: "transfer", args: [args.to, args.amount] });
}

/** Plain words for wallet failures; a rejected prompt is the payer's choice, not an error. */
export function walletErrorMessage(e: unknown): string {
  const code = errorCode(e);
  const msg = e instanceof Error ? e.message : String(e ?? "");
  if (code === 4001 || /user (rejected|denied)|rejected the request/i.test(msg)) return "You canceled in your wallet.";
  if (code === -32002) return "Your wallet already has a request open. Open the wallet to finish or dismiss it.";
  if (/insufficient funds/i.test(msg)) return "The wallet does not have enough to cover this transfer.";
  const short = (e as { shortMessage?: string })?.shortMessage;
  return short || msg || "The wallet could not complete the request.";
}

/** EIP-191 personal_sign from the connected wallet, for the payout-change proof (GATEWAY.md section 14.3). */
export async function signPersonalMessage(message: string): Promise<{ address: Address; signature: Hex }> {
  const wallet = createWalletClient({ transport: custom(need()) });
  const address = await connectWallet();
  const signature = await wallet.signMessage({ account: address, message });
  return { address, signature };
}
