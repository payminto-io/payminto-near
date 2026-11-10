/**
 * Plain rendering of a NEAR wallet transaction, so a person sees exactly what their wallet will be asked to sign:
 * receiver, method, arguments, attached deposit and gas. Pure, for tests.
 */
import type { WalletTx } from "@payminto/protocol";

const YOCTO_PER_NEAR = 10n ** 24n;
const GAS_PER_TGAS = 10n ** 12n;

/** Attached deposit in words: "None", "1 yoctoNEAR" (the NEP-141 security deposit) or an exact NEAR figure. */
export function depositText(yocto: string): string {
  const v = BigInt(yocto);
  if (v === 0n) return "None";
  if (v < 1_000_000n) return `${v} yoctoNEAR`;
  const whole = v / YOCTO_PER_NEAR;
  const frac = (v % YOCTO_PER_NEAR).toString().padStart(24, "0").replace(/0+$/, "");
  return `${whole}${frac ? `.${frac}` : ""} NEAR`;
}

/** Gas limit in Tgas, exact. Unused gas is refunded, so this is a ceiling, not a cost. */
export function gasText(gas: string): string {
  const v = BigInt(gas);
  const whole = v / GAS_PER_TGAS;
  const rest = v % GAS_PER_TGAS;
  return rest === 0n ? `${whole} Tgas` : `${whole}.${rest.toString().padStart(12, "0").replace(/0+$/, "")} Tgas`;
}

/** Arguments as indented JSON, with a JSON `msg` string (ft_transfer_call) expanded so its contents are readable. */
export function argsText(args: Record<string, unknown>): string {
  const shown: Record<string, unknown> = { ...args };
  if (typeof shown.msg === "string") {
    try {
      shown.msg = JSON.parse(shown.msg) as unknown;
    } catch {
      // Not JSON: show it as sent.
    }
  }
  return JSON.stringify(shown, null, 2);
}

export type TxLine = { receiver: string; method: string; args: string; deposit: string; gas: string };

export function txLines(tx: WalletTx): TxLine[] {
  return tx.actions.map((a) => ({ receiver: tx.receiverId, method: a.params.methodName, args: argsText(a.params.args), deposit: depositText(a.params.deposit), gas: gasText(a.params.gas) }));
}
