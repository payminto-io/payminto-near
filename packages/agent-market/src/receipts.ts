import { z } from "zod";
import { formatAmount, isAccountId, isId32, networks } from "@payminto/protocol";
import { USDC_DECIMALS } from "./constants.ts";
import { MarketError } from "./errors.ts";
import { argument } from "./http.ts";
import { atomicOrZeroSchema, atomicSchema } from "./schemas.ts";

const id32 = z.string().refine((v) => isId32(v), "must be 64 lowercase hex characters");
const account = z.string().refine((v) => isAccountId(v), "must be a NEAR account id");

/**
 * One input the agent bought through Payminto while doing a market job. Every field ends up in a Markdown table or in
 * a shell command a stranger may paste, so each one is validated to a strict pattern before it is rendered.
 */
export const inputReceiptSchema = z.strictObject({
  /** The Payminto call id of the purchase. */
  callId: id32,
  /** The account the purchase paid. */
  payee: account,
  /** The price in atomic units of the hub's token. */
  amountAtomic: atomicSchema,
  /** The Payminto hub contract that clears this purchase. */
  hub: account,
  /** The hub's network. Payminto hubs run on testnet and on a local sandbox; the market's own payment is on mainnet. */
  network: z.enum(["near:testnet", "near:sandbox"]),
  /** The batch the purchase was settled in, or null while it is cleared but not settled on chain yet. */
  batchId: id32.nullable(),
  /** A short label for what was bought. Free text from a service directory: escaped and cut before rendering. */
  service: z.string().max(200).optional(),
  /** Where the buyer finds the receipt file to pass to `--receipt`: a relative path or file name. */
  receiptFile: z
    .string()
    .regex(/^[A-Za-z0-9_][A-Za-z0-9._/-]{0,199}$/, "must be a plain relative path")
    .refine((v) => !v.includes(".."), "must not contain ..")
    .optional(),
  /** The RPC endpoint to read the hub through. Defaults to the public endpoint of the network. */
  rpcUrl: z
    .string()
    .max(200)
    .regex(/^https?:\/\/[A-Za-z0-9.-]+(:\d{1,5})?(\/[A-Za-z0-9._/-]*)?$/, "must be a plain http or https URL")
    .optional(),
});
export type InputReceipt = z.infer<typeof inputReceiptSchema>;

export type ReceiptsOptions = {
  /** How amounts are labelled. Default: USDC with six decimals. */
  token?: { symbol: string; decimals: number };
  /** The spend ceiling the job ran under, in atomic units. Shown next to the total when given. */
  spendCeilingAtomic?: string;
  /** Rows shown before the table is cut with a count of the rest. Default 50. */
  maxRows?: number;
  /** Set for a dry run: the section then says its receipts are samples that are on no chain and will not verify. */
  sample?: boolean;
  /**
   * Set when the receipts are real receipts of a simulated hub (an in-memory model of the hub contract, as in a dry run
   * on the demo stack). The section then says so, makes no claim that they are on a chain, and prints no command,
   * because there is no chain for a command to read.
   */
  simulatedHub?: boolean;
};

export const RECEIPTS_HEADING = "## Verifiable costs";

const rpcOf = (r: InputReceipt): string => r.rpcUrl ?? networks[r.network]!.rpcUrl;

/**
 * The exact command that checks one receipt, or null while the purchase is not settled on chain. With a receipt file
 * it proves the single call; without one it shows that the batch is stored on the hub.
 */
export function verifyCommand(receipt: InputReceipt): string | null {
  const r = argument(inputReceiptSchema, receipt, "receipt");
  if (r.batchId === null) return null;
  const base = `pnpm verify:near --rpc-url ${rpcOf(r)} --hub ${r.hub}`;
  return r.receiptFile ? `${base} --receipt ${r.receiptFile}` : `${base} --batch ${r.batchId}`;
}

/** A label from a directory, made safe inside a Markdown table cell. */
function cell(label: string): string {
  const clean = label.replace(/[\p{Cc}\p{Zl}\p{Zp}]+/gu, " ").replace(/[|`<>[\]\\*_~#!]/g, " ").replace(/\s+/g, " ").trim();
  return clean.length > 60 ? `${clean.slice(0, 57)}...` : clean || "input";
}

/**
 * The "Verifiable costs" section of a market deliverable: the Payminto receipts of the inputs the agent bought while
 * doing the job. Pure: the same receipts always give the same text.
 *
 * It is the honest link between the two systems. The job is paid through the market, and this section says so; what
 * Payminto adds is that the agent's own spending on inputs is bounded and can be checked on chain by anyone.
 */
export function renderReceiptsSection(receipts: readonly InputReceipt[], options: ReceiptsOptions = {}): string {
  const parsed = z.array(inputReceiptSchema).max(10_000).safeParse(receipts);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    throw new MarketError("INVALID_ARGUMENT", `a receipt is invalid: ${first ? `${first.path.join(".")}: ${first.message}` : "invalid"}`);
  }
  const rows = parsed.data;
  const token = options.token ?? { symbol: "USDC", decimals: USDC_DECIMALS };
  if (!/^[A-Za-z0-9.]{1,16}$/.test(token.symbol) || !Number.isInteger(token.decimals) || token.decimals < 0 || token.decimals > 24) {
    throw new MarketError("INVALID_ARGUMENT", "the token label must be a short symbol with 0 to 24 decimals");
  }
  const ceiling = options.spendCeilingAtomic === undefined ? null : BigInt(atomicOrZeroSchema.parse(options.spendCeilingAtomic));
  const maxRows = Math.max(1, Math.min(options.maxRows ?? 50, 200));
  const money = (atomic: bigint | string) => `${formatAmount(atomic, token.decimals)} ${token.symbol}`;
  const total = rows.reduce((sum, r) => sum + BigInt(r.amountAtomic), 0n);

  const lines: string[] = [
    RECEIPTS_HEADING,
    "",
    "The Payminto worker added this section from structured receipts; the model did not write it.",
    "This job is paid through the NEAR AI Agent Market, which holds and pays out its own jobs.",
    "Payminto did not settle, hold or route that payment.",
    "",
  ];
  if (options.sample) lines.push("DRY RUN: the receipts below are samples. They are on no chain, and the commands below will not verify them.", "");
  if (options.simulatedHub) {
    lines.push(
      "SIMULATED: these receipts come from a simulated hub, an in-memory model of the Payminto hub contract that ran inside the process that did this job.",
      "They are not on NEAR or on any other chain, so nobody can check them against a hub contract.",
      "",
    );
  }
  if (rows.length === 0) {
    lines.push(`The agent bought no paid inputs for this job${ceiling === null ? "" : `, out of the ${money(ceiling)} it was allowed to spend on them`}.`);
    return lines.join("\n");
  }

  const networkNames = [...new Set(rows.map((r) => r.network))].sort().join(", ");
  lines.push(
    `While doing this job the agent bought ${rows.length} paid input${rows.length === 1 ? "" : "s"} with its own Payminto Budget and spent ${money(total)}${ceiling === null ? "" : ` of the ${money(ceiling)} it was allowed for this job`}.`,
    options.simulatedHub
      ? "Each purchase below has the receipt the simulated hub's clearing node signed for it."
      : `Each purchase has a receipt that anyone can check against the Payminto hub contract on NEAR (${networkNames}), which is a different network from the one the market is paid on.`,
    "",
    "| # | Input | Call id | Payee | Amount | Hub account | Batch id |",
    "|---|---|---|---|---|---|---|",
  );
  const shown = rows.slice(0, maxRows);
  shown.forEach((r, i) => {
    lines.push(`| ${i + 1} | ${cell(r.service ?? "input")} | \`${r.callId}\` | \`${r.payee}\` | ${money(r.amountAtomic)} | \`${r.hub}\` | ${r.batchId === null ? "not settled yet" : `\`${r.batchId}\``} |`);
  });
  if (rows.length > shown.length) lines.push("", `${rows.length - shown.length} more purchase${rows.length - shown.length === 1 ? "" : "s"} not listed here are included in the total.`);
  if (options.simulatedHub) {
    lines.push("", "A run against a Payminto hub on NEAR testnet or on a local NEAR sandbox prints, for each receipt, the command that proves it.");
    return lines.join("\n");
  }

  lines.push("", "### Check a receipt yourself", "", "Run these from a checkout of the Payminto repository.", "They read the hub contract through a public RPC endpoint and need no keys and no Payminto node.");
  shown.forEach((r, i) => {
    const command = verifyCommand(r);
    lines.push("");
    if (command === null) {
      lines.push(`Receipt ${i + 1} is cleared but not settled on chain yet, so it has no batch to check against until the node's next batch.`);
      return;
    }
    lines.push(
      r.receiptFile
        ? `Receipt ${i + 1}, proving this single call with its receipt file:`
        : `Receipt ${i + 1}, showing that its batch is stored on the hub (proving the single call needs its receipt file, which the seller can send):`,
      "",
      "```",
      command,
      "```",
    );
  });
  lines.push(
    "",
    "A passing check proves that the call is in a batch root its settler committed on chain and that the Budget's agent key signed it.",
    "It does not prove what the paid service delivered for that call.",
  );
  return lines.join("\n");
}

/**
 * Turns purchases as the Payminto seller agent reports them (`{ callId, payee, amountAtomic, service? }`) into input
 * receipts, by adding where they clear. `batchOf` and `fileOf` say, per call, which batch settled it and where its
 * receipt file is; both may be left out.
 */
export function toInputReceipts(
  purchases: ReadonlyArray<{ callId: string; payee: string; amountAtomic: string; service?: string | null }>,
  where: { hub: string; network: InputReceipt["network"]; rpcUrl?: string; batchOf?: (callId: string) => string | null | undefined; fileOf?: (callId: string) => string | undefined },
): InputReceipt[] {
  return purchases.map((p) => {
    const file = where.fileOf?.(p.callId);
    return argument(inputReceiptSchema, {
      callId: p.callId,
      payee: p.payee,
      amountAtomic: p.amountAtomic,
      hub: where.hub,
      network: where.network,
      batchId: where.batchOf?.(p.callId) ?? null,
      ...(p.service ? { service: p.service.slice(0, 200) } : {}),
      ...(file ? { receiptFile: file } : {}),
      ...(where.rpcUrl ? { rpcUrl: where.rpcUrl } : {}),
    }, "receipt");
  });
}
