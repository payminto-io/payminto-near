/** `pnpm swarm verify <round.json>` and `pnpm swarm prove <receipt.json>`: checks anyone can run on a file, with no node. */
import { readFileSync } from "node:fs";
import { z } from "zod";
import { formatAmount, isId32, isPublicKey, nodeDigest, receiptLeaf, verifyDigest, verifyMerkleProof, voucherDigest, type PublicKey } from "@payminto/protocol";
import { shown } from "./config.ts";
import { PROOF_FILE_KIND, verifyRound, VOID_TEXT, type RoundCheck } from "./rules.ts";

export type ToolResult = { code: 0 | 1 | 2; lines: string[] };

const usdc = (a: bigint | string) => `${formatAmount(a)} USDC`;

/** Reads a JSON file, or explains what is wrong with it and what to do. */
function readJson(path: string, what: string, example: string): { ok: true; value: unknown } | { ok: false; lines: string[] } {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    const why = code === "ENOENT" ? "there is no such file" : code === "EISDIR" ? "it is a directory" : code === "EACCES" ? "this user may not read it" : String(code ?? err);
    return { ok: false, lines: [`Cannot read ${path}: ${why}.`, `What to do: run \`pnpm swarm\` first, which writes ${what} for every round, then pass one of them, for example ${example}.`] };
  }
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch (err) {
    return { ok: false, lines: [`${path} is not valid JSON: ${err instanceof Error ? err.message : String(err)}.`, `What to do: pass ${what} written by \`pnpm swarm\`, for example ${example}.`] };
  }
}

const line = (c: RoundCheck) => `  ${c.ok ? "PASS" : "FAIL"}  ${c.name}: ${c.detail}`;

export function verifyRoundFile(path: string, example: string): ToolResult {
  const read = readJson(path, "a round file", example);
  if (!read.ok) return { code: 2, lines: read.lines };
  const v = verifyRound(read.value);
  const lines = [`Round file ${shown(path)}`];
  const o = v.outcome;
  if (o) {
    const file = read.value as { params: { round: string; reserveUnitPrice: string } };
    lines.push(`  round ${file.params.round}: reserve ${usdc(file.params.reserveUnitPrice)} per unit, pooled demand ${o.pooledUnits} units, ${o.bids.length} sealed bids`);
    for (const b of o.bids) {
      const bidText = b.unitPrice === null ? "not revealed" : `${usdc(b.unitPrice)} x ${b.capacity} units`;
      lines.push(`    ${b.seller.padEnd(26)} ${bidText.padEnd(26)} ${b.status === "valid" ? "valid" : `VOID ${b.reason}: ${VOID_TEXT[b.reason!]}`}`);
    }
    lines.push(o.winner ? `  recomputed from the messages: winner ${o.winner}, clearing price ${usdc(o.clearingPrice!)} per unit, ${o.awardedUnits} units awarded, total ${usdc(o.totalDue)}` : `  recomputed from the messages: no winner (${o.status})`);
  }
  lines.push("Checks:", ...v.checks.map(line));
  const failed = v.checks.filter((c) => !c.ok).length;
  lines.push(v.ok ? `VERIFIED: ${v.checks.length} of ${v.checks.length} checks passed. The published result follows from the signed messages and RULES.md.` : `NOT VERIFIED: ${failed} of ${v.checks.length} checks failed. The published result does not follow from the messages in this file.`);
  if (!o) lines.push("What to do: pass a round file written by `pnpm swarm`, for example " + example + ".");
  return { code: v.ok ? 0 : 1, lines };
}

const proofSchema = z.object({
  network: z.enum(["near:sandbox", "near:testnet", "near:mainnet"]),
  hub: z.string(),
  operator: z.string(),
  rpcUrl: z.string().nullable(),
  batchId: z.string().refine(isId32),
  proof: z.array(z.string().refine(isId32)).max(32),
  receipt: z.object({
    callId: z.string().refine(isId32),
    budgetId: z.string().refine(isId32),
    payee: z.string(),
    amount: z.string().regex(/^[0-9]+$/),
    cumulative: z.string().regex(/^[0-9]+$/),
    requestHash: z.string().refine(isId32),
    timestamp: z.number().int().nonnegative(),
    voucherSig: z.string(),
    digest: z.string(),
    nodeSignature: z.string(),
    node: z.string().refine(isPublicKey),
  }),
  swarm: z.object({
    kind: z.literal(PROOF_FILE_KIND),
    chain: z.string(),
    round: z.string(),
    buyer: z.string(),
    seller: z.string(),
    agentPk: z.string().refine(isPublicKey),
    batchRoot: z.string().refine(isId32),
  }),
});

/**
 * Re-checks a receipt proof file with nothing but the file: the Merkle path against the root recorded in it, the
 * voucher signature against the agent key recorded in it. It says plainly that the root is taken from the file.
 */
export function proveReceiptFile(path: string, example: string): ToolResult {
  const read = readJson(path, "a receipt proof file", example);
  if (!read.ok) return { code: 2, lines: read.lines };
  const parsed = proofSchema.safeParse(read.value);
  if (!parsed.success) {
    const problems = parsed.error.issues.slice(0, 6).map((i) => `  ${i.path.join(".") || "(file)"}: ${i.message}`);
    return { code: 2, lines: [`${path} is not a Payminto swarm receipt proof file:`, ...problems, `What to do: pass a file named round-<n>.receipt.json written by \`pnpm swarm\`, for example ${example}. A round file is checked with \`pnpm swarm verify\`.`] };
  }
  const f = parsed.data;
  const r = f.receipt;
  const amount = BigInt(r.amount);
  const cumulative = BigInt(r.cumulative);
  const fields = { callId: r.callId, budgetId: r.budgetId, payee: r.payee, amount, cumulative, requestHash: r.requestHash, timestampMs: BigInt(r.timestamp) * 1000n, voucherSig: r.voucherSig };
  const leaf = receiptLeaf(f.hub, f.network, f.batchId, fields);
  const pathOk = verifyMerkleProof(f.swarm.batchRoot, leaf, f.proof);
  const signed = verifyDigest(f.swarm.agentPk as PublicKey, voucherDigest(f.hub, f.network, { budgetId: r.budgetId, payee: r.payee, amount, cumulative, requestHash: r.requestHash }), r.voucherSig);
  const attested = nodeDigest({ callId: r.callId, budgetId: r.budgetId, payee: r.payee, amount, cumulative, requestHash: r.requestHash, timestamp: BigInt(r.timestamp), voucherSig: r.voucherSig });
  const nodeOk = attested === r.digest && verifyDigest(r.node as PublicKey, attested, r.nodeSignature);
  const ok = pathOk && signed && r.payee === f.swarm.seller;
  const lines = [
    `Receipt proof ${shown(path)}`,
    `  ${f.swarm.buyer} paid ${f.swarm.seller} ${usdc(r.amount)} for one unit of round ${f.swarm.round}`,
    `  chain: ${f.swarm.chain}; hub ${f.hub}, batch ${f.batchId}`,
    "Checks:",
    `  ${r.payee === f.swarm.seller ? "PASS" : "FAIL"}  the receipt pays the seller the file names: ${r.payee}`,
    `  ${signed ? "PASS" : "FAIL"}  the voucher for exactly ${r.amount} atomic units is signed by the buyer's key ${f.swarm.agentPk}`,
    `  ${pathOk ? "PASS" : "FAIL"}  the Merkle path folds from this receipt's leaf to the batch root: leaf ${leaf}, ${f.proof.length} steps, root ${f.swarm.batchRoot}`,
    `  INFO  the node's acceptance signature ${nodeOk ? "is valid" : "does not verify"} for node key ${r.node} (the node's word, not the chain's)`,
    ok ? "VERIFIED against the root recorded in this file." : "NOT VERIFIED: the receipt in this file does not match its own proof.",
    f.rpcUrl
      ? `The root above is what the hub stored. To read it from the chain yourself while the sandbox runs: pnpm verify:near --rpc-url ${f.rpcUrl} --hub ${f.hub} --receipt ${shown(path)}`
      : "The root above is what the simulated hub stored during the run. That hub lives only inside a run, so this command checks the file against its own recorded root; `pnpm swarm --serve` checks the same receipt against the live hub on its page.",
    "A proof shows the Call is in a settled batch and that the buyer's key signed it. It does not show that the GPU work was done.",
  ];
  return { code: ok ? 0 : 1, lines };
}
