/**
 * Payment URIs for the deposit screen of the any-chain checkout: a QR code a mobile wallet scans to fill in the token,
 * the network, the address and the amount, so a buyer types nothing.
 *
 * - EVM chains: EIP-681 (https://eips.ethereum.org/EIPS/eip-681). An ERC-20 is
 *   `ethereum:<token contract>@<chain id>/transfer?address=<deposit>&uint256=<base units>`, native ETH is
 *   `ethereum:<deposit>@<chain id>?value=<wei>`. The chain id is always written, so a wallet switches to the right
 *   network instead of sending on the one it is on.
 * - Solana: a Solana Pay transfer request (https://docs.solanapay.com/spec):
 *   `solana:<deposit>?amount=<decimal amount>&spl-token=<mint>`, the amount in user units, not base units.
 *
 * Anything else, or anything malformed or missing, is null: the screen then shows the address and amount alone. A URI is
 * never guessed, because a wrong token, network or amount sends money where it may be lost.
 */

/** What a payment URI needs of the origin token (an `IntentsOrigin` with its `contract_address` and `chain_id`). */
export type DepositUriOrigin = {
  /** The 1Click chain code: base, eth, arb, pol, op, sol, ... */
  chain: string;
  /** The EIP-155 chain id on an EVM chain; null elsewhere. */
  chainId: number | null;
  /** The ERC-20 contract or SPL mint; null for the chain's native coin. */
  contractAddress: string | null;
  decimals: number;
  symbol: string;
};

const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/;
/** A base58 ed25519 public key: 32 bytes are 32 to 44 base58 characters. */
const SOLANA_ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
/** A positive integer in base units, without sign, leading zeros, decimals or exponent. */
const POSITIVE_INTEGER = /^[1-9][0-9]*$/;
/**
 * Native coins a contract-less EVM row may stand for. A token row that lost its contract is missing data: it must
 * never become a native transfer of the same number of base units.
 */
const EVM_NATIVE_SYMBOLS = new Set(["ETH", "POL", "BNB", "AVAX"]);

/** Base units as a decimal string in user units, without trailing zeros: 4500000 with 6 decimals is `4.5`. */
function decimalAmount(atomic: string, decimals: number): string {
  if (decimals === 0) return atomic;
  const digits = atomic.padStart(decimals + 1, "0");
  const whole = digits.slice(0, -decimals);
  const frac = digits.slice(-decimals).replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : whole;
}

/**
 * The payment URI a wallet scans to send exactly `amountAtomic` base units of the origin token to `depositAddress`, or
 * null when this origin has no payment URI here or an input is malformed.
 */
export function depositPaymentUri(o: DepositUriOrigin, depositAddress: string, amountAtomic: string): string | null {
  if (typeof amountAtomic !== "string" || !POSITIVE_INTEGER.test(amountAtomic)) return null;
  if (!Number.isInteger(o.decimals) || o.decimals < 0 || o.decimals > 255) return null;
  if (typeof depositAddress !== "string") return null;
  const symbol = String(o.symbol ?? "").toUpperCase();

  if (o.chain === "sol") {
    if (!SOLANA_ADDRESS.test(depositAddress)) return null;
    const amount = `amount=${decimalAmount(amountAtomic, o.decimals)}`;
    if (o.contractAddress === null) return symbol === "SOL" ? `solana:${depositAddress}?${amount}` : null;
    if (!SOLANA_ADDRESS.test(o.contractAddress)) return null;
    return `solana:${depositAddress}?${amount}&spl-token=${o.contractAddress}`;
  }

  if (o.chainId === null || !Number.isSafeInteger(o.chainId) || o.chainId <= 0) return null;
  if (!EVM_ADDRESS.test(depositAddress)) return null;
  if (o.contractAddress === null) return EVM_NATIVE_SYMBOLS.has(symbol) ? `ethereum:${depositAddress}@${o.chainId}?value=${amountAtomic}` : null;
  if (!EVM_ADDRESS.test(o.contractAddress)) return null;
  return `ethereum:${o.contractAddress}@${o.chainId}/transfer?address=${depositAddress}&uint256=${amountAtomic}`;
}

/** An EVM transaction for `eth_sendTransaction` (EIP-1193): hex quantities, the chain it must be sent on. */
export type DepositEvmTransaction = { chainId: number; to: string; value: string; data: string };

/** `transfer(address,uint256)`, the first four bytes of its keccak-256. */
const ERC20_TRANSFER = "0xa9059cbb";
const word = (hex: string) => hex.toLowerCase().padStart(64, "0");

/**
 * The transaction a connected browser wallet sends to pay the deposit: the same token, network, address and amount as
 * `depositPaymentUri`, under the same checks, so the button and the QR can never disagree. An ERC-20 is a
 * `transfer(deposit, amount)` call on the token contract; a native coin is a plain transfer of the value. Null for
 * Solana and wherever the payment URI is null.
 */
export function depositEvmTransaction(o: DepositUriOrigin, depositAddress: string, amountAtomic: string): DepositEvmTransaction | null {
  if (o.chain === "sol") return null;
  if (depositPaymentUri(o, depositAddress, amountAtomic) === null || o.chainId === null) return null;
  const amount = BigInt(amountAtomic).toString(16);
  if (o.contractAddress === null) return { chainId: o.chainId, to: depositAddress, value: `0x${amount}`, data: "0x" };
  return { chainId: o.chainId, to: o.contractAddress, value: "0x0", data: `${ERC20_TRANSFER}${word(depositAddress.slice(2))}${word(amount)}` };
}
