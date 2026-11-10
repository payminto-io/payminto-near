/**
 * Writes the NEAR JSON-RPC answers that test/reader.test.ts replays, in the shape the public RPC returns, built from
 * the frozen Merkle vectors so the batch root and the receipt agree.
 *
 *   node scripts/gen-rpc-fixtures.ts
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const chain = join(dirname(fileURLToPath(import.meta.url)), "..");
const m = JSON.parse(readFileSync(join(chain, "vectors/merkle.json"), "utf8"));
const c = m.cases.find((x: { name: string }) => x.name === "leaves_5");
const out = join(chain, "test/fixtures/rpc");
mkdirSync(out, { recursive: true });

const HEIGHT = 219_402_871;
const BLOCK = "8sPRLUk5FXH3vdTdXV3tWrw7WkoFJEn5RFGtXNhrqgwN";
const bytes = (v: unknown) => [...new TextEncoder().encode(JSON.stringify(v))];
const ok = (value: unknown) => ({ jsonrpc: "2.0", id: "payminto-1", result: { block_hash: BLOCK, block_height: HEIGHT, logs: [], result: bytes(value) } });
const err = (cause: string, info: Record<string, unknown>, data: string) => ({
  jsonrpc: "2.0",
  id: "payminto-1",
  error: { name: "HANDLER_ERROR", cause: { name: cause, info }, code: -32000, message: "Server error", data },
});
const write = (name: string, note: string, request: unknown, response: unknown) =>
  writeFileSync(join(out, `${name}.json`), JSON.stringify({ note, request, response }, null, 2) + "\n");

const view = (method: string, args: unknown) => ({ method: "query", params: { request_type: "call_function", finality: "final", account_id: c.hub, method_name: method, args } });

const r = c.receipts_in_leaf_order[2];
const fields = {
  call_id: r.call_id,
  budget_id: r.budget_id,
  payee: r.payee,
  amount: r.amount,
  cumulative: r.cumulative,
  request_hash: r.request_hash,
  timestamp_ms: r.timestamp_ms,
  voucher_sig: r.voucher_sig,
};

write("batch", `Hub batch view for merkle vector ${c.name}.`, view("batch", { batch_id: c.batch_id }), ok({ root: c.root, settler: "node.payminto.testnet", gross: "15000", net: "9000", at: "1800000060000" }));
write("batch-missing", "Hub batch view for a batch id the hub never stored.", view("batch", { batch_id: "ab".repeat(32) }), ok(null));
write("verify-receipt", `Hub verify_receipt for receipt 2 of ${c.name}.`, view("verify_receipt", { batch_id: c.batch_id, fields, proof: r.proof }), ok(true));
const pay = { id: "0bafe22156d2698c143b86040446d366ead863ba600d5c924f3d15c786ef4057", merchant: "shop.testnet", amount: "25000000", payer: "buyer.testnet", at: "1800000001000" };
write("payments", "Hub payments view: one recorded payment, one unknown.", view("payments", { ids: [pay.id, "cd".repeat(32)] }), ok([pay, null]));
write(
  "unknown-account",
  "View against a hub account that does not exist on this network.",
  view("batch", { batch_id: c.batch_id }),
  err("UNKNOWN_ACCOUNT", { requested_account_id: c.hub, block_height: HEIGHT, block_hash: BLOCK }, `account ${c.hub} does not exist while viewing`),
);
write(
  "contract-panic",
  "View that panics inside the hub contract.",
  view("verify_receipt", { batch_id: c.batch_id, fields, proof: r.proof }),
  err(
    "CONTRACT_EXECUTION_ERROR",
    { vm_error: 'wasm execution failed with error: FunctionCallError(ExecutionError("Smart contract panicked: UNKNOWN_BUDGET"))', block_height: HEIGHT, block_hash: BLOCK },
    'wasm execution failed with error: FunctionCallError(ExecutionError("Smart contract panicked: UNKNOWN_BUDGET"))',
  ),
);
write(
  "legacy-panic",
  "Older nodes answer a panicking view inside a successful envelope.",
  view("batch", { batch_id: c.batch_id }),
  { jsonrpc: "2.0", id: "payminto-1", result: { block_hash: BLOCK, block_height: HEIGHT, logs: [], error: 'wasm execution failed with error: FunctionCallError(HostError(GuestPanic { panic_msg: "panicked at src/lib.rs: OVERFLOW" }))' } },
);
const TX = "9sK2zUvbYgq7bhUGkNsrJtQJMdz6aRuC5U3hyGJxR7fH";
const txReq = (sender: string) => ({ method: "tx", params: { tx_hash: TX, sender_account_id: sender, wait_until: "NONE" } });
const outcome = (status: unknown, finality: string) => ({
  jsonrpc: "2.0",
  id: "payminto-1",
  result: {
    final_execution_status: finality,
    status,
    transaction: { hash: TX, signer_id: "buyer.testnet", receiver_id: "usdc.fakes.testnet", actions: [{ FunctionCall: { method_name: "ft_transfer_call", gas: 100000000000000, deposit: "1" } }] },
    transaction_outcome: { id: TX, block_hash: BLOCK, outcome: { status: { SuccessReceiptId: "4Fh3y4L7tM6b2s1a9ZcR8vQp5wXe7uJk3nB6dV2gH1Ys" } } },
    receipts_outcome: [],
  },
});
write("tx-final", "Final, successful transaction.", txReq("buyer.testnet"), outcome({ SuccessValue: "IjI1MDAwMDAwIg==" }, "FINAL"));
write("tx-failed", "Final transaction the hub refused.", txReq("buyer.testnet"), outcome({ Failure: { ActionError: { index: 0, kind: { FunctionCallError: { ExecutionError: "Smart contract panicked: NOT_OWNER" } } } } }, "FINAL"));
write("tx-pending", "Transaction included but not final yet.", txReq("buyer.testnet"), outcome({ SuccessValue: "" }, "EXECUTED_OPTIMISTIC"));
write(
  "tx-unknown",
  "A hash this RPC has never seen.",
  txReq("buyer.testnet"),
  err("UNKNOWN_TRANSACTION", { requested_transaction_hash: TX }, `Transaction ${TX} doesn't exist`),
);
console.log(`wrote ${out}`);
