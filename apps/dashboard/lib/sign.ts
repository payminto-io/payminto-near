/**
 * Owner-side mandate construction and signing for the create wizard.
 * Uses the shared protocol helpers only; EIP-712 types are never re-derived here.
 */
import { createWalletClient, custom, getAddress, isAddress, numberToHex, toHex, type Address, type EIP1193Provider, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import {
  mandateId,
  mandateToJson,
  mandateTypedData,
  payeesRoot,
  policyHash,
  type Mandate,
  type MandateJson,
  type Policy,
} from "@payminto/protocol";

export type MandateDraft = {
  agent: Address;
  token: Address;
  totalCap: bigint;
  validForSeconds: number;
  payees: Address[];
  policy: Policy;
};

export type SignedMandate = { mandate: MandateJson; mandateId: Hex; ownerSignature: Hex; owner: Address };

declare global {
  interface Window {
    ethereum?: EIP1193Provider;
  }
}

export function hasInjectedWallet(): boolean {
  return typeof window !== "undefined" && Boolean(window.ethereum);
}

export function buildMandate(draft: MandateDraft, owner: Address, nowSec = Math.floor(Date.now() / 1000)): Mandate {
  const salt = toHex(crypto.getRandomValues(new Uint8Array(32)));
  return {
    owner: getAddress(owner),
    agent: getAddress(draft.agent),
    token: getAddress(draft.token),
    totalCap: draft.totalCap,
    // A small backdate tolerates clock skew between this browser and the chain.
    validAfter: BigInt(nowSec - 60),
    validUntil: BigInt(nowSec + draft.validForSeconds),
    payeesRoot: payeesRoot(draft.payees),
    policyHash: policyHash(draft.policy),
    salt,
  };
}

/** Signs with the browser wallet (EIP-1193), switching it to the node's chain first when needed. */
export async function signWithInjected(chainId: number, hub: Address, draft: MandateDraft): Promise<SignedMandate> {
  const provider = window.ethereum;
  if (!provider) throw new Error("No browser wallet found. Install or unlock one, then try again.");
  const wallet = createWalletClient({ transport: custom(provider) });
  const [owner] = await wallet.requestAddresses();
  if (!owner) throw new Error("The wallet did not share an account.");
  const current = await wallet.getChainId();
  if (current !== chainId) {
    try {
      await provider.request({ method: "wallet_switchEthereumChain", params: [{ chainId: numberToHex(chainId) }] });
    } catch {
      throw new Error(`Switch your wallet to chain ${chainId} and sign again. It is on chain ${current}.`);
    }
  }
  const m = buildMandate(draft, owner);
  const ownerSignature = await wallet.signTypedData({ account: owner, ...mandateTypedData(chainId, hub, m) });
  return { mandate: mandateToJson(m), mandateId: mandateId(chainId, hub, m), ownerSignature, owner };
}

/** Local anvil only: signs with a pasted development key that never leaves this tab. */
export async function signWithDevKey(chainId: number, hub: Address, draft: MandateDraft, key: string): Promise<SignedMandate> {
  if (chainId !== 31337) throw new Error("Development keys are only accepted on the local test network (chain 31337).");
  const pk = (key.startsWith("0x") ? key : `0x${key}`) as Hex;
  if (!/^0x[0-9a-fA-F]{64}$/.test(pk)) throw new Error("A private key is 32 bytes of hex.");
  const account = privateKeyToAccount(pk);
  const m = buildMandate(draft, account.address);
  const ownerSignature = await account.signTypedData(mandateTypedData(chainId, hub, m));
  return { mandate: mandateToJson(m), mandateId: mandateId(chainId, hub, m), ownerSignature, owner: account.address };
}

export function parseAddressList(text: string): { valid: Address[]; invalid: string[] } {
  const parts = text.split(/[\s,]+/).map((s) => s.trim()).filter(Boolean);
  const valid: Address[] = [];
  const invalid: string[] = [];
  for (const p of parts) {
    if (isAddress(p)) valid.push(getAddress(p));
    else invalid.push(p);
  }
  return { valid, invalid };
}

/** Mock mode only: a throwaway key so the wizard can be demoed without a wallet. Nothing reaches a chain. */
export async function signWithEphemeral(chainId: number, hub: Address, draft: MandateDraft): Promise<SignedMandate> {
  const account = privateKeyToAccount(generatePrivateKey());
  const m = buildMandate(draft, account.address);
  const ownerSignature = await account.signTypedData(mandateTypedData(chainId, hub, m));
  return { mandate: mandateToJson(m), mandateId: mandateId(chainId, hub, m), ownerSignature, owner: account.address };
}
