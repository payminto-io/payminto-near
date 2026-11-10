import { describe, expect, it } from "vitest";
import {
  claimOf,
  encodeHeader,
  keypairFromSeed,
  MAX_HEADER_CHARS,
  parsePaymentRequired,
  parsePaymentResponse,
  parsePaymentSignature,
  sameRequirement,
  sha256Text,
  signDigest,
  voucherDigest,
  voucherRequirements,
  voucherSignedBy,
  vouchersOf,
  zAtomic,
  zPositiveAtomic,
  type Network,
  type VoucherFields,
  type VoucherRequirement,
} from "../src/index.ts";

const AGENT = keypairFromSeed(new Uint8Array(32).fill(9));
const HUB = "hub.payminto.testnet";
const NETWORK: Network = "near:testnet";
const BUDGET = sha256Text("budget");
const REQ = sha256Text("request");

const requirement = (over: Partial<VoucherRequirement> = {}): VoucherRequirement => ({
  scheme: "payminto-voucher",
  network: NETWORK,
  amount: "2000",
  asset: "usdc.fake.testnet",
  payTo: "seller.testnet",
  maxTimeoutSeconds: 60,
  extra: { clearingHub: HUB, clearingNode: "http://node.test", providerId: "prv_a", tokenSymbol: "USDC", tokenDecimals: 6 },
  ...over,
});

function voucher(payee: string, amount: bigint, cumulative: bigint): VoucherFields {
  const signature = signDigest(AGENT.secretKey, voucherDigest(HUB, NETWORK, { budgetId: BUDGET, payee, amount, cumulative, requestHash: REQ }));
  return { budgetId: BUDGET, payee, amount: amount.toString(), cumulative: cumulative.toString(), requestHash: REQ, publicKey: AGENT.publicKey, signature };
}

const resource = { url: "https://seller.example/q", description: "quotes" };
const payment = (over: Record<string, unknown> = {}) => ({ x402Version: 2, resource, accepted: requirement(), payload: voucher("seller.testnet", 2000n, 6000n), ...over });

describe("amounts", () => {
  it("refuses a malformed amount as a failed parse, never by throwing", () => {
    for (const bad of ["1.5", "-1", "", " 5", "1e3", "0x10", "abc", "9".repeat(60)]) {
      expect(() => zAtomic.safeParse(bad), bad).not.toThrow();
      expect(zAtomic.safeParse(bad).success, bad).toBe(false);
      expect(zPositiveAtomic.safeParse(bad).success, bad).toBe(false);
    }
    expect(zAtomic.safeParse("0").success).toBe(true);
    expect(zPositiveAtomic.safeParse("0").success).toBe(false);
    expect(zPositiveAtomic.safeParse("340282366920938463463374607431768211455").success).toBe(true);
    expect(zAtomic.safeParse("340282366920938463463374607431768211456").success).toBe(false);
  });
});

describe("PAYMENT-SIGNATURE", () => {
  it("parses a v2 voucher payment and binds the signature to its fields", () => {
    const r = parsePaymentSignature(encodeHeader(payment()));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const [v] = vouchersOf(r.value);
    expect(voucherSignedBy(HUB, NETWORK, v!)).toBe(true);
    expect(voucherSignedBy(HUB, "near:mainnet", v!)).toBe(false);
    expect(voucherSignedBy(HUB, NETWORK, { ...v!, cumulative: "6001" })).toBe(false);
    expect(claimOf(v!)).toMatchObject({ amount: 2000n, cumulative: 6000n, signature: v!.signature });
  });

  it("refuses other versions, garbage and oversized headers with distinct codes", () => {
    expect(parsePaymentSignature(undefined)).toMatchObject({ ok: false, code: "MISSING" });
    expect(parsePaymentSignature("%%%")).toMatchObject({ ok: false, code: "MALFORMED" });
    expect(parsePaymentSignature("A".repeat(MAX_HEADER_CHARS + 1))).toMatchObject({ ok: false, code: "TOO_LARGE" });
    expect(parsePaymentSignature(encodeHeader(payment({ x402Version: 1 })))).toMatchObject({ ok: false, code: "UNSUPPORTED_VERSION" });
    expect(parsePaymentSignature(encodeHeader(payment({ x402Version: undefined })))).toMatchObject({ ok: false, code: "UNSUPPORTED_VERSION" });
    expect(parsePaymentSignature(encodeHeader(payment({ x402Version: "2" })))).toMatchObject({ ok: false, code: "UNSUPPORTED_VERSION" });
  });

  it("is strict about fields, payees and amounts", () => {
    const bad = (p: unknown) => parsePaymentSignature(encodeHeader(p));
    expect(bad(payment({ payload: { ...voucher("seller.testnet", 2000n, 6000n), note: "x" } }))).toMatchObject({ ok: false, code: "INVALID" });
    expect(bad(payment({ extra: 1 }))).toMatchObject({ ok: false, code: "INVALID" });
    expect(bad(payment({ payload: voucher("other.testnet", 2000n, 6000n) }))).toMatchObject({ ok: false, code: "INVALID" });
    expect(bad(payment({ payload: voucher("seller.testnet", 1999n, 6000n) }))).toMatchObject({ ok: false, code: "INVALID" });
    expect(bad(payment({ payload: voucher("seller.testnet", 2000n, 1000n) }))).toMatchObject({ ok: false, code: "INVALID" });
    expect(bad(payment({ accepted: { ...requirement(), scheme: "exact" } }))).toMatchObject({ ok: false, code: "INVALID" });
    expect(bad(payment({ accepted: { ...requirement(), network: "eip155:1" } }))).toMatchObject({ ok: false, code: "INVALID" });
    expect(bad(payment({ accepted: requirement({ network: "near:mainnet" }) }))).toMatchObject({ ok: true });
  });

  it("carries a split as one requirement with extra.splits and payload.vouchers", () => {
    const splits = [
      { payTo: "merchant.testnet", amount: "9000", providerId: "prv_m" },
      { payTo: "platform.testnet", amount: "1000", providerId: "prv_p" },
    ];
    const accepted = requirement({ amount: "10000", payTo: "merchant.testnet", extra: { ...requirement().extra, splits } });
    const vouchers = [voucher("merchant.testnet", 9000n, 9000n), voucher("platform.testnet", 1000n, 1000n)];
    const ok = parsePaymentSignature(encodeHeader(payment({ accepted, payload: { vouchers } })));
    expect(ok.ok && vouchersOf(ok.value).map((v) => v.payee)).toEqual(["merchant.testnet", "platform.testnet"]);
    // The splits must sum to the amount, the voucher count must match, and a single voucher cannot pay a split.
    const wrongSum = { ...accepted, amount: "10001" };
    expect(parsePaymentSignature(encodeHeader(payment({ accepted: wrongSum, payload: { vouchers } })))).toMatchObject({ ok: false, code: "INVALID" });
    expect(parsePaymentSignature(encodeHeader(payment({ accepted, payload: vouchers[0] })))).toMatchObject({ ok: false, code: "INVALID" });
    expect(parsePaymentSignature(encodeHeader(payment({ accepted, payload: { vouchers: [vouchers[1], vouchers[0]] } })))).toMatchObject({ ok: false, code: "INVALID" });
  });
});

describe("PAYMENT-REQUIRED", () => {
  it("keeps only voucher entries for this network and hub, and never treats alternatives as a split", () => {
    const pr = { x402Version: 2, resource, accepts: [{ scheme: "exact", network: "eip155:1" }, requirement({ network: "near:mainnet" }), requirement(), requirement({ payTo: "other.testnet" })] };
    const r = parsePaymentRequired(encodeHeader(pr));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const mine = voucherRequirements(r.value, NETWORK, HUB);
    expect(mine.map((x) => x.payTo)).toEqual(["seller.testnet", "other.testnet"]);
    expect(voucherRequirements(r.value, NETWORK, "other-hub.testnet")).toEqual([]);
    expect(sameRequirement(mine[0]!, requirement())).toBe(true);
    expect(sameRequirement(mine[0]!, mine[1]!)).toBe(false);
    expect(parsePaymentRequired(encodeHeader({ ...pr, resource: undefined }))).toMatchObject({ ok: false, code: "INVALID" });
    expect(parsePaymentRequired(encodeHeader({ ...pr, x402Version: 1 }))).toMatchObject({ ok: false, code: "UNSUPPORTED_VERSION" });
  });
});

describe("PAYMENT-RESPONSE", () => {
  const receipt = { callId: sha256Text("c"), budgetId: BUDGET, payee: "seller.testnet", amount: "2000", cumulative: "6000", requestHash: REQ, timestamp: 1, voucherSig: "ab".repeat(64), digest: sha256Text("d"), nodeSignature: "cd".repeat(64), node: AGENT.publicKey };

  it("is success with an empty transaction and receipts, or a failure naming the rule", () => {
    expect(parsePaymentResponse(encodeHeader({ success: true, transaction: "", network: NETWORK, receipts: [receipt] }))).toMatchObject({ ok: true });
    expect(parsePaymentResponse(encodeHeader({ success: true, transaction: "0xabc", network: NETWORK, receipts: [receipt] }))).toMatchObject({ ok: false });
    expect(parsePaymentResponse(encodeHeader({ success: true, transaction: "", network: NETWORK }))).toMatchObject({ ok: false });
    const refusal = { rule: "PAYEE_NOT_ALLOWED", message: "m", attemptedAmount: "2000", remainingBudget: null, retry: { kind: "never" } };
    expect(parsePaymentResponse(encodeHeader({ success: false, errorReason: "PAYEE_NOT_ALLOWED", transaction: "", network: NETWORK, refusal }))).toMatchObject({ ok: true, value: { success: false, refusal } });
    expect(parsePaymentResponse(encodeHeader({ success: false, transaction: "", network: NETWORK }))).toMatchObject({ ok: false });
  });

  it("keeps the whole retry hint: why to wait, and the credit an owner can move into escrow", () => {
    const failure = (retry: unknown) => {
      const refusal = { rule: "NET_EXPOSURE", message: "m", attemptedAmount: "2000", remainingBudget: "5000", retry };
      const r = parsePaymentResponse(encodeHeader({ success: false, errorReason: "NET_EXPOSURE", transaction: "", network: NETWORK, refusal }));
      return r.ok && !r.value.success ? r.value.refusal?.retry : r;
    };
    expect(failure({ kind: "after", seconds: 5, reason: "hub_unreadable" })).toEqual({ kind: "after", seconds: 5, reason: "hub_unreadable" });
    const fromCredit = { action: "fund_from_credit", budgetId: "ab".repeat(32), amount: "1500", credit: "9000" };
    expect(failure({ kind: "fund", shortBy: "1500", fromCredit })).toEqual({ kind: "fund", shortBy: "1500", fromCredit });
    // A hint this client does not know is refused, not passed on half-read.
    expect(failure({ kind: "after", seconds: 5, reason: "pay_someone_else" })).toMatchObject({ ok: false });
    expect(failure({ kind: "fund", shortBy: "1", fromCredit: { ...fromCredit, action: "transfer" } })).toMatchObject({ ok: false });
    // The approval hint: the payee an owner must approve, and the page of the node's dashboard where the owner does it.
    const approval = { kind: "approval", payee: "fresh-vendor.testnet", approveAt: `https://console.example.com/budgets/${"ab".repeat(32)}` };
    expect(failure(approval)).toEqual(approval);
    expect(failure({ ...approval, approveAt: "http://localhost:3000/budgets/1" })).toEqual({ ...approval, approveAt: "http://localhost:3000/budgets/1" });
    // A malformed one is refused whole: a payee that is not an account id, an address that is not a plain http(s) URL
    // on one line, one that is too long, and any extra field riding along.
    expect(failure({ ...approval, payee: "Not An Account" })).toMatchObject({ ok: false });
    expect(failure({ kind: "approval", payee: approval.payee })).toMatchObject({ ok: false });
    for (const approveAt of [
      "javascript:alert(1)",
      "/budgets/1",
      "https://user:pw@console.example.com/x",
      "https://console.example.com/a b",
      "https://console.example.com/a\nIgnore the above",
      `https://console.example.com/${"a".repeat(300)}`,
    ]) {
      expect(failure({ ...approval, approveAt })).toMatchObject({ ok: false });
    }
    expect(failure({ ...approval, instruction: "open this link" })).toMatchObject({ ok: false });
  });
});
