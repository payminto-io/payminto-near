import { spawn, type ChildProcess } from "node:child_process";
import { createHash, createHmac } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createPublicClient,
  createWalletClient,
  http,
  encodeAbiParameters,
  keccak256,
  parseAbiParameters,
  parseEventLogs,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  depositFactoryAbi,
  depositFactoryBytecode,
  paymentRouterAbi,
  paymentRouterBytecode,
  eip3009Abi,
  mockStablecoinAbi,
  mockStablecoinBytecode,
  localAnvil,
  networks,
  tokenDomainSeparator,
  ID_PREFIXES,
  newId,
  isId,
  newPaymentId,
  newLinkId,
  newRefundId,
  newWebhookEndpointId,
  newEventId,
  newDeliveryId,
  newApiKeyId,
  newLinkSlug,
  newWebhookSecret,
  newApiKeySecret,
  hashApiKeySecret,
  isLivemode,
  isTerminalPaymentStatus,
  checkoutUrl,
  linkUrl,
  newMerchantId,
  newFeePlanId,
  paymentRef,
  refundRef,
  depositSalt,
  predictForwarder,
  readForwarderImplementation,
  assertDepositTerms,
  depositTermsArg,
  depositFlushData,
  proRataFee,
  paymentTermsNonce,
  paymentTermsToJson,
  paymentTermsFromJson,
  routerAuthorization,
  payWithAuthorizationData,
  receiveAuthorizationTypedData,
  recoverReceiveAuthorizer,
  isReceiveAuthorizationSignedBy,
  computeFees,
  feeBreakdownToJson,
  checkoutAuthorizationTemplate,
  checkoutTypedData,
  checkoutTransferTemplate,
  walletPaymentNonce,
  walletTransferAuthorization,
  transferAuthorizationTypedData,
  transferAuthorizationToJson,
  transferAuthorizationFromJson,
  recoverTransferAuthorizer,
  isTransferAuthorizationSignedBy,
  signWebhook,
  verifyWebhook,
  erc20TransferUri,
  WEBHOOK_EVENT_TYPES,
  type TokenDomain,
  type DepositTerms,
  type PaymentTerms,
  canonicalJson,
  canonicalOrder,
  metadataHash,
  orderHash,
  payoutChangeMessage,
  lineItemsTotal,
} from "../src/index.ts";

// Anvil default dev keys (public, local only).
const DEPLOYER = privateKeyToAccount("0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80");
const PAYER = privateKeyToAccount("0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d");
const RELAYER = privateKeyToAccount("0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a");
const MERCHANT = "0x90F79bf6EB2c4f870365E785982E1f101E93b906" as Address;
const OTHER = "0x15d34AAf54267DB7D7c367839AAf71A00a2C6A65" as Address;
const PLATFORM = "0x9965507D1a55bcC2695C58ba16FB37d819B0A4dc" as Address;
const ZERO = "0x0000000000000000000000000000000000000000" as Address;
const PORT = 19545 + Math.floor(Math.random() * 1000);

// Shared with contracts/test (DepositFactory.t.sol, MockStablecoin3009.t.sol, PaymentRouter.t.sol).
const VECTOR_ID = "pay_abcdefghijklmnopqrstuvwx";

let anvil: ChildProcess;
const transport = http(`http://127.0.0.1:${PORT}`);
const chain = { ...localAnvil, rpcUrls: { default: { http: [`http://127.0.0.1:${PORT}`] } } };
const pub = createPublicClient({ chain, transport });
const deployer = createWalletClient({ account: DEPLOYER, chain, transport });
const relayer = createWalletClient({ account: RELAYER, chain, transport });
let factory: Address;
let router: Address;
let token: Address;
let domain: TokenDomain;

async function waitForRpc() {
  for (let i = 0; i < 100; i++) {
    try {
      await pub.getChainId();
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  throw new Error("anvil did not start");
}

async function deploy(abi: any, bytecode: Hex): Promise<Address> {
  const hash = await deployer.deployContract({ abi, bytecode });
  const rcpt = await pub.waitForTransactionReceipt({ hash });
  return rcpt.contractAddress!;
}

async function balanceOf(account: Address): Promise<bigint> {
  return pub.readContract({ address: token, abi: mockStablecoinAbi, functionName: "balanceOf", args: [account] });
}

beforeAll(async () => {
  anvil = spawn("anvil", ["--port", String(PORT), "--silent"], { stdio: "ignore" });
  await waitForRpc();
  factory = await deploy(depositFactoryAbi, depositFactoryBytecode);
  router = await deploy(paymentRouterAbi, paymentRouterBytecode);
  token = await deploy(mockStablecoinAbi, mockStablecoinBytecode);
  domain = { ...networks[31337]!.token.eip712, chainId: localAnvil.id, verifyingContract: token };
  await pub.waitForTransactionReceipt({
    hash: await deployer.writeContract({ address: token, abi: mockStablecoinAbi, functionName: "mint", args: [PAYER.address, 100_000_000n] }),
  });
}, 30_000);

afterAll(() => {
  anvil?.kill();
});

describe("ids and secrets", () => {
  it("formats every id as prefix_ + 24 lowercase base32 characters", () => {
    const makers = [newPaymentId, newLinkId, newRefundId, newWebhookEndpointId, newEventId, newDeliveryId, newApiKeyId];
    const kinds = ["payment", "link", "refund", "webhookEndpoint", "event", "delivery", "apiKey"] as const;
    makers.forEach((make, i) => {
      const id = make();
      const kind = kinds[i]!;
      expect(id).toMatch(new RegExp(`^${ID_PREFIXES[kind]}_[a-z2-7]{24}$`));
      expect(isId(kind, id)).toBe(true);
    });
    expect(newPaymentId()).toMatch(/^pay_/);
    expect(newLinkId()).toMatch(/^plink_/);
    expect(newRefundId()).toMatch(/^re_/);
    expect(newWebhookEndpointId()).toMatch(/^we_/);
    expect(newEventId()).toMatch(/^evt_/);
    expect(newDeliveryId()).toMatch(/^whd_/);
    expect(newApiKeyId()).toMatch(/^key_/);
    expect(newMerchantId()).toMatch(/^mer_[a-z2-7]{24}$/);
    expect(newFeePlanId()).toMatch(/^fp_[a-z2-7]{24}$/);
  });

  it("does not repeat and rejects malformed ids", () => {
    const ids = new Set(Array.from({ length: 2000 }, () => newId("payment")));
    expect(ids.size).toBe(2000);
    expect(isId("payment", VECTOR_ID)).toBe(true);
    expect(isId("refund", VECTOR_ID)).toBe(false);
    expect(isId("payment", "pay_ABCDEFGHIJKLMNOPQRSTUVWX")).toBe(false);
    expect(isId("payment", "pay_abcdefghijklmnopqrstuvw")).toBe(false);
    expect(isId("payment", "pay_abcdefghijklmnopqrstuv01")).toBe(false);
    expect(isId("payment", 42)).toBe(false);
  });

  it("formats slugs and secrets", () => {
    expect(newLinkSlug()).toMatch(/^[a-z2-7]{8}$/);
    const whsec = newWebhookSecret();
    expect(whsec).toMatch(/^whsec_[A-Za-z0-9_-]{43}$/);
    expect(newApiKeySecret(true)).toMatch(/^sk_live_[a-z2-7]{52}$/);
    expect(newApiKeySecret(false)).toMatch(/^sk_test_[a-z2-7]{52}$/);
    const secret = newApiKeySecret(false);
    expect(hashApiKeySecret(secret)).toBe(`0x${createHash("sha256").update(secret).digest("hex")}`);
  });

  it("knows livemode, terminal states and URLs", () => {
    expect(isLivemode(177)).toBe(true);
    expect(isLivemode(133)).toBe(false);
    expect(isLivemode(31337)).toBe(false);
    expect(isTerminalPaymentStatus("paid")).toBe(true);
    expect(isTerminalPaymentStatus("expired")).toBe(true);
    expect(isTerminalPaymentStatus("partially_paid")).toBe(false);
    expect(isTerminalPaymentStatus("processing")).toBe(false);
    expect(checkoutUrl("https://pay.example.com/", VECTOR_ID)).toBe(`https://pay.example.com/pay/${VECTOR_ID}`);
    expect(linkUrl("http://localhost:3000", "abcd2345")).toBe("http://localhost:3000/l/abcd2345");
  });
});

describe("ref and salt derivation", () => {
  it("matches the Solidity vectors", () => {
    expect(depositSalt(31337, VECTOR_ID)).toBe("0x646eeebbfb022ec366fb008fe076baa5f9ac01b6d01cc0a557e37e5e67a658a3");
    expect(paymentRef(177, VECTOR_ID)).toBe("0xf55b2aea1c660c824731e91908c895f215780f4d626de335933de5259f432d99");
    expect(
      paymentTermsNonce({
        paymentRef: "0x0000000000000000000000000000000000000000000000000000000000000001",
        payout: "0x1111111111111111111111111111111111111111",
        feeRecipient: "0x2222222222222222222222222222222222222222",
        fee: 500_000n,
      }),
    ).toBe("0x071f2bfc6c4465dc7f2a03d0fa4cfe0b22de949b101bc721ad07d2c1093f98f7");
  });

  it("separates chains, payments and purposes", () => {
    const id = newPaymentId();
    expect(paymentRef(177, id)).not.toBe(paymentRef(133, id));
    expect(paymentRef(177, id)).not.toBe(depositSalt(177, id));
    expect(depositSalt(177, id)).not.toBe(depositSalt(177, newPaymentId()));
    expect(refundRef(177, id)).not.toBe(paymentRef(177, id));
    expect(refundRef(177, "re_abcdefghijklmnopqrstuvwx")).toBe(
      keccak256(encodeAbiParameters(parseAbiParameters("string, uint256, string"), ["payminto.refund.v1", 177n, "re_abcdefghijklmnopqrstuvwx"])),
    );
  });

  it("binds the router nonce to every term", () => {
    const t: PaymentTerms = { paymentRef: paymentRef(177, VECTOR_ID), payout: MERCHANT, feeRecipient: PLATFORM, fee: 5n };
    const n = paymentTermsNonce(t);
    expect(paymentTermsNonce({ ...t, payout: OTHER })).not.toBe(n);
    expect(paymentTermsNonce({ ...t, feeRecipient: OTHER })).not.toBe(n);
    expect(paymentTermsNonce({ ...t, fee: 6n })).not.toBe(n);
    expect(paymentTermsNonce({ ...t, paymentRef: paymentRef(133, VECTOR_ID) })).not.toBe(n);
    expect(paymentTermsFromJson(JSON.parse(JSON.stringify(paymentTermsToJson(t))))).toEqual(t);
  });
});

describe("pro-rata fee", () => {
  it("is min(fee, floor(paid * fee / amountDue)) and path independent", () => {
    const t = { fee: 500_000n, amountDue: 100_000_000n };
    expect(proRataFee({ ...t, paid: 0n })).toBe(0n);
    expect(proRataFee({ ...t, paid: 40_000_000n })).toBe(200_000n);
    expect(proRataFee({ ...t, paid: 100_000_000n })).toBe(500_000n);
    expect(proRataFee({ ...t, paid: 150_000_000n })).toBe(500_000n);
    expect(proRataFee({ fee: 1n, amountDue: 3n, paid: 2n })).toBe(0n);
    expect(proRataFee({ fee: 0n, amountDue: 3n, paid: 2n })).toBe(0n);
    expect(() => proRataFee({ fee: 1n, amountDue: 0n, paid: 1n })).toThrow();
  });
});

describe("deposit forwarders (live anvil)", () => {
  it("predicts DepositFactory.addressOf for every split field and splits on flush", async () => {
    const implementation = await readForwarderImplementation(pub, factory);
    const salt = depositSalt(localAnvil.id, newPaymentId());
    const terms: DepositTerms = { token, payout: MERCHANT, feeRecipient: PLATFORM, fee: 12_500n, amountDue: 2_500_000n };
    const onchain = (t: DepositTerms) =>
      pub.readContract({ address: factory, abi: depositFactoryAbi, functionName: "addressOf", args: [depositTermsArg(t), salt] });
    const predicted = predictForwarder(factory, implementation, terms, salt);
    expect(predicted).toBe(await onchain(terms));
    for (const changed of [
      { ...terms, token: OTHER },
      { ...terms, payout: OTHER },
      { ...terms, feeRecipient: OTHER },
      { ...terms, fee: 12_501n },
      { ...terms, amountDue: 2_500_001n },
      { ...terms, fee: 0n, feeRecipient: ZERO },
    ]) {
      const p = predictForwarder(factory, implementation, changed, salt);
      expect(p).not.toBe(predicted);
      expect(p).toBe(await onchain(changed));
    }
    expect(() => predictForwarder(factory, implementation, { ...terms, amountDue: 0n }, salt)).toThrow(/amountDue/);
    expect(() => assertDepositTerms({ ...terms, fee: terms.amountDue + 1n })).toThrow(/fee/);
    expect(() => assertDepositTerms({ ...terms, feeRecipient: ZERO })).toThrow(/feeRecipient/);
    expect(() => assertDepositTerms({ ...terms, payout: ZERO })).toThrow(/payout/);
    await expect(onchain({ ...terms, amountDue: 0n })).rejects.toThrow();

    // A payer sends to the address before it has code; anyone flushes it, split between merchant and platform.
    expect(await pub.getCode({ address: predicted })).toBeUndefined();
    const payer = createWalletClient({ account: PAYER, chain, transport });
    await pub.waitForTransactionReceipt({
      hash: await payer.writeContract({ address: token, abi: mockStablecoinAbi, functionName: "transfer", args: [predicted, 2_500_000n] }),
    });
    const [merchantBefore, platformBefore] = [await balanceOf(MERCHANT), await balanceOf(PLATFORM)];
    const rcpt = await pub.waitForTransactionReceipt({ hash: await relayer.sendTransaction({ to: factory, data: depositFlushData(terms, salt) }) });
    const [deployed] = parseEventLogs({ abi: depositFactoryAbi, logs: rcpt.logs, eventName: "ForwarderDeployed" });
    expect(deployed?.args.forwarder).toBe(predicted);
    expect((await balanceOf(MERCHANT)) - merchantBefore).toBe(2_487_500n);
    expect((await balanceOf(PLATFORM)) - platformBefore).toBe(12_500n);
    expect(await balanceOf(predicted)).toBe(0n);
  });
});

describe("EIP-3009 (live anvil)", () => {
  it("uses the token's own EIP-712 domain", async () => {
    const onchain = await pub.readContract({ address: token, abi: mockStablecoinAbi, functionName: "DOMAIN_SEPARATOR" });
    expect(tokenDomainSeparator(localAnvil.id, token, domain)).toBe(onchain);
  });

  it("signs a plain TransferWithAuthorization the token accepts once", async () => {
    const now = BigInt((await pub.getBlock()).timestamp);
    const message = { from: PAYER.address, to: MERCHANT, value: 1_250_000n, validAfter: 0n, validBefore: now + 1800n, nonce: refundRef(31337, newRefundId()) };
    expect(transferAuthorizationFromJson(transferAuthorizationToJson(message))).toEqual(message);
    const signature = await PAYER.signTypedData(transferAuthorizationTypedData(domain, message));
    expect(await recoverTransferAuthorizer(domain, message, signature)).toBe(PAYER.address);
    expect(await isTransferAuthorizationSignedBy(domain, message, signature)).toBe(true);
    expect(await isTransferAuthorizationSignedBy(domain, { ...message, value: 1_250_001n }, signature)).toBe(false);
    expect(await isTransferAuthorizationSignedBy({ ...domain, version: "2" }, message, signature)).toBe(false);
    expect(await isTransferAuthorizationSignedBy(domain, message, "0x1234")).toBe(false);

    const args = [message.from, message.to, message.value, message.validAfter, message.validBefore, message.nonce, signature] as const;
    const rcpt = await pub.waitForTransactionReceipt({
      hash: await relayer.writeContract({ address: token, abi: eip3009Abi, functionName: "transferWithAuthorization", args }),
    });
    const [used] = parseEventLogs({ abi: eip3009Abi, logs: rcpt.logs, eventName: "AuthorizationUsed" });
    expect(used?.args).toEqual({ authorizer: PAYER.address, nonce: message.nonce });
    await expect(
      pub.simulateContract({ account: RELAYER, address: token, abi: eip3009Abi, functionName: "transferWithAuthorization", args }),
    ).rejects.toThrow(/authorization is used or canceled/);
  });

  it("routes a checkout ReceiveWithAuthorization through the PaymentRouter with a fee", async () => {
    const paymentId = newPaymentId();
    const now = BigInt((await pub.getBlock()).timestamp);
    const terms: PaymentTerms = { paymentRef: paymentRef(localAnvil.id, paymentId), payout: MERCHANT, feeRecipient: PLATFORM, fee: 50_000n };
    const template = checkoutAuthorizationTemplate({ domain, router, terms, value: 10_000_000n, expiresAt: now + 1800n });
    // The template is what a CheckoutView carries; it must survive JSON, and the payer's wallet fills in `from`.
    const wire = JSON.parse(JSON.stringify(template)) as typeof template;
    const typed = checkoutTypedData(wire, PAYER.address);
    const message = routerAuthorization({ router, terms, from: PAYER.address, value: 10_000_000n, validBefore: now + 1800n });
    expect(typed.message).toEqual(message);
    expect(typed.primaryType).toBe("ReceiveWithAuthorization");
    expect(message).toMatchObject({ to: router, validAfter: 0n, nonce: paymentTermsNonce(terms) });
    expect(paymentTermsFromJson(wire.terms)).toEqual(terms);
    expect(() => routerAuthorization({ router, terms: { ...terms, fee: 10_000_001n }, from: PAYER.address, value: 10_000_000n, validBefore: 1n })).toThrow();

    const signature = await PAYER.signTypedData(typed);
    expect(await recoverReceiveAuthorizer(domain, message, signature)).toBe(PAYER.address);
    expect(await isReceiveAuthorizationSignedBy(domain, message, signature)).toBe(true);
    // A receive signature is not a transfer signature.
    expect(await isTransferAuthorizationSignedBy(domain, message, signature)).toBe(false);
    expect(await isReceiveAuthorizationSignedBy(domain, receiveAuthorizationTypedData(domain, { ...message, to: OTHER }).message, signature)).toBe(false);

    // The node cannot swap the terms: the nonce no longer matches what the payer signed.
    await expect(
      pub.call({ account: RELAYER.address, to: router, data: payWithAuthorizationData(token, { ...terms, payout: OTHER }, message, signature) }),
    ).rejects.toThrow(/invalid signature/);

    const [merchantBefore, platformBefore] = [await balanceOf(MERCHANT), await balanceOf(PLATFORM)];
    const rcpt = await pub.waitForTransactionReceipt({
      hash: await relayer.sendTransaction({ to: router, data: payWithAuthorizationData(token, terms, message, signature) }),
    });
    const [routed] = parseEventLogs({ abi: paymentRouterAbi, logs: rcpt.logs, eventName: "PaymentRouted" });
    expect(routed?.args).toEqual({ paymentRef: terms.paymentRef, from: PAYER.address, payout: MERCHANT, value: 10_000_000n, fee: 50_000n });
    const [used] = parseEventLogs({ abi: eip3009Abi, logs: rcpt.logs, eventName: "AuthorizationUsed" });
    expect(used?.args.nonce).toBe(paymentTermsNonce(terms));
    expect((await balanceOf(MERCHANT)) - merchantBefore).toBe(9_950_000n);
    expect((await balanceOf(PLATFORM)) - platformBefore).toBe(50_000n);
    expect(await balanceOf(router)).toBe(0n);
  });
});

describe("fees (section 14.1)", () => {
  const plan = { platform_fee_bps: 50, platform_fee_fixed: "0", min_fee: null, max_fee: null };
  const free = { fee_bps: 0, fee_fixed: "0", bearer: "merchant" as const };
  const quote = (amount: bigint, p: Parameters<typeof computeFees>[0]["plan"], m: Parameters<typeof computeFees>[0]["method"]) =>
    computeFees({ amount, plan: p, method: m });

  it("takes the platform fee out of the merchant's amount by default", () => {
    expect(quote(100_000_000n, plan, free)).toEqual({
      amount: 100_000_000n,
      surcharge: 0n,
      amount_due: 100_000_000n,
      platform_fee: 500_000n,
      method_fee: 0n,
      fee_total: 500_000n,
      net_amount: 99_500_000n,
    });
    expect(quote(100_000_000n, plan, null)).toEqual(quote(100_000_000n, plan, free));
  });

  it("floors the bps part and adds the fixed part", () => {
    const r = quote(199n, { ...plan, platform_fee_bps: 100, platform_fee_fixed: 7n }, null);
    expect(r.platform_fee).toBe(8n); // 7 + floor(1.99)
    expect(quote(99n, plan, null).platform_fee).toBe(0n);
  });

  it("clamps the platform fee to min_fee and max_fee", () => {
    expect(quote(1_000_000n, { ...plan, min_fee: "10000" }, null).platform_fee).toBe(10_000n);
    expect(quote(1_000_000_000n, { ...plan, max_fee: 1_000_000n }, null).platform_fee).toBe(1_000_000n);
    expect(quote(1_000_000n, { ...plan, min_fee: 5_000n, max_fee: 5_000n }, null).platform_fee).toBe(5_000n);
    expect(() => quote(1n, { ...plan, min_fee: 2n, max_fee: 1n }, null)).toThrow(/max_fee/);
  });

  it("charges a merchant-borne method fee to the merchant", () => {
    const r = quote(10_000_000n, plan, { fee_bps: 100, fee_fixed: "20000", bearer: "merchant" });
    expect(r).toMatchObject({ surcharge: 0n, amount_due: 10_000_000n, platform_fee: 50_000n, method_fee: 120_000n, fee_total: 170_000n, net_amount: 9_830_000n });
  });

  it("adds a customer-borne method fee as a surcharge", () => {
    const r = quote(10_000_000n, plan, { fee_bps: 100, fee_fixed: "20000", bearer: "customer" });
    // The platform fee is on the merchant price, not on the surcharge.
    expect(r).toMatchObject({ surcharge: 120_000n, amount_due: 10_120_000n, platform_fee: 50_000n, method_fee: 120_000n, fee_total: 170_000n, net_amount: 9_950_000n });
  });

  it("never lets fee_total exceed amount_due, cutting the platform fee first", () => {
    const r1 = quote(1_000n, { ...plan, min_fee: 5_000n }, null);
    expect(r1).toMatchObject({ amount_due: 1_000n, platform_fee: 1_000n, fee_total: 1_000n, net_amount: 0n });
    const r2 = quote(1_000n, { ...plan, min_fee: 5_000n }, { fee_bps: 0, fee_fixed: 300n, bearer: "merchant" });
    expect(r2).toMatchObject({ amount_due: 1_000n, method_fee: 300n, platform_fee: 700n, fee_total: 1_000n, net_amount: 0n });
    const r3 = quote(1_000n, plan, { fee_bps: 0, fee_fixed: 5_000n, bearer: "merchant" });
    expect(r3).toMatchObject({ amount_due: 1_000n, method_fee: 1_000n, platform_fee: 0n, fee_total: 1_000n, net_amount: 0n });
    const r4 = quote(1_000n, { ...plan, min_fee: 5_000n }, { fee_bps: 0, fee_fixed: 300n, bearer: "customer" });
    expect(r4).toMatchObject({ surcharge: 300n, amount_due: 1_300n, method_fee: 300n, platform_fee: 1_000n, fee_total: 1_300n, net_amount: 0n });
  });

  it("holds the invariants across a grid of inputs", () => {
    const amounts = [1n, 2n, 99n, 100n, 9_999n, 10_000n, 1_000_001n, 123_456_789n, 10n ** 18n];
    const plans = [
      plan,
      { platform_fee_bps: 0, platform_fee_fixed: 0n },
      { platform_fee_bps: 1000, platform_fee_fixed: 1_000n, min_fee: 500n, max_fee: 2_000_000n },
      { platform_fee_bps: 25, platform_fee_fixed: 0n, min_fee: 10_000n },
    ];
    const methods = [null, free, { fee_bps: 290, fee_fixed: 300_000n, bearer: "customer" as const }, { fee_bps: 10_000, fee_fixed: 1n, bearer: "merchant" as const }];
    for (const amount of amounts)
      for (const p of plans)
        for (const m of methods) {
          const r = quote(amount, p, m);
          expect(r.amount).toBe(amount);
          expect(r.amount_due).toBe(amount + r.surcharge);
          expect(r.fee_total).toBe(r.platform_fee + r.method_fee);
          expect(r.fee_total <= r.amount_due).toBe(true);
          expect(r.net_amount).toBe(r.amount_due - r.fee_total);
          expect(r.platform_fee >= 0n && r.method_fee >= 0n && r.net_amount >= 0n).toBe(true);
          if (m?.bearer !== "customer") expect(r.surcharge).toBe(0n);
        }
  });

  it("rejects invalid inputs", () => {
    expect(() => quote(0n, plan, null)).toThrow(/positive/);
    expect(() => quote(-1n, plan, null)).toThrow();
    expect(() => quote(1n, { ...plan, platform_fee_bps: 1001 }, null)).toThrow(/platform_fee_bps/);
    expect(() => quote(1n, { ...plan, platform_fee_bps: 1.5 }, null)).toThrow(/platform_fee_bps/);
    expect(() => quote(1n, plan, { ...free, fee_bps: 10_001 })).toThrow(/fee_bps/);
    expect(() => quote(1n, plan, { ...free, fee_fixed: "-1" })).toThrow(/fee_fixed/);
  });

  it("serializes to JSON strings", () => {
    expect(feeBreakdownToJson(quote(100_000_000n, plan, null))).toEqual({
      amount: "100000000",
      surcharge: "0",
      amount_due: "100000000",
      platform_fee: "500000",
      method_fee: "0",
      fee_total: "500000",
      net_amount: "99500000",
    });
  });
});

describe("webhook signatures", () => {
  const secret = "whsec_test_secret";
  const body = JSON.stringify({ id: "evt_x", type: "payment.paid", created: 1_800_000_000, livemode: false, data: { object: {} } });
  const t = 1_800_000_000;

  it("signs t=<unix>,v1=<hex HMAC-SHA256(secret, t.body)>", async () => {
    const expected = createHmac("sha256", secret).update(`${t}.${body}`).digest("hex");
    expect(await signWebhook(secret, body, t)).toBe(`t=${t},v1=${expected}`);
    expect(await signWebhook(secret, new TextEncoder().encode(body), t)).toBe(`t=${t},v1=${expected}`);
    await expect(signWebhook(secret, body, 1.5)).rejects.toThrow();
  });

  it("verifies within the tolerance and rejects everything else", async () => {
    const header = await signWebhook(secret, body, t);
    expect(await verifyWebhook(body, header, secret, { now: t })).toBe(true);
    expect(await verifyWebhook(new TextEncoder().encode(body), header, secret, { now: t + 300 })).toBe(true);
    expect(await verifyWebhook(body, header, secret, { now: t + 301 })).toBe(false);
    expect(await verifyWebhook(body, header, secret, { now: t - 301 })).toBe(false);
    expect(await verifyWebhook(body, header, secret, { now: t + 3600, toleranceSec: 3600 })).toBe(true);
    expect(await verifyWebhook(`${body} `, header, secret, { now: t })).toBe(false);
    expect(await verifyWebhook(body, header, "whsec_other", { now: t })).toBe(false);
    expect(await verifyWebhook(body, header.replace(`t=${t}`, `t=${t + 1}`), secret, { now: t })).toBe(false);
    expect(await verifyWebhook(body, header.toUpperCase().replace("T=", "t=").replace("V1=", "v1="), secret, { now: t })).toBe(true);
    expect(await verifyWebhook(body, `t=${t}`, secret, { now: t })).toBe(false);
    expect(await verifyWebhook(body, header.split(",")[1], secret, { now: t })).toBe(false);
    expect(await verifyWebhook(body, "garbage", secret, { now: t })).toBe(false);
    expect(await verifyWebhook(body, null, secret, { now: t })).toBe(false);
    expect(await verifyWebhook(body, `t=${t},v1=deadbeef`, secret, { now: t })).toBe(false);
    // Several v1 values (for example during a secret rotation): any match passes.
    const v1 = header.split("v1=")[1];
    expect(await verifyWebhook(body, `t=${t},v1=${"0".repeat(64)},v1=${v1}`, secret, { now: t })).toBe(true);
    // Defaults to the current time.
    const fresh = await signWebhook(secret, body, Math.floor(Date.now() / 1000));
    expect(await verifyWebhook(body, fresh, secret)).toBe(true);
    expect(await verifyWebhook(body, header, secret)).toBe(false);
  });

  it("lists the subscribable event types", () => {
    expect(WEBHOOK_EVENT_TYPES).toContain("payment.paid");
    expect(WEBHOOK_EVENT_TYPES).toContain("refund.failed");
    expect(WEBHOOK_EVENT_TYPES).toHaveLength(10);
  });
});

describe("EIP-681", () => {
  it("builds an ERC-20 transfer URI with checksummed addresses", () => {
    const uri = erc20TransferUri({
      token: "0x054ed45810dbbab8b27668922d110669c9d88d0a",
      chainId: 177,
      to: MERCHANT.toLowerCase() as Address,
      amount: "1500000",
    });
    expect(uri).toBe(`ethereum:0x054ed45810DbBAb8B27668922D110669c9D88D0a@177/transfer?address=${MERCHANT}&uint256=1500000`);
    expect(() => erc20TransferUri({ token: MERCHANT, chainId: 177, to: MERCHANT, amount: -1n })).toThrow();
  });
});

describe("order commitment", () => {
  const base = {
    payment_id: "pay_aaaaaaaaaaaaaaaaaaaaaaaa",
    amount: "25000000",
    token: "0x054ed45810dbbab8b27668922d110669c9d88d0a" as Address,
    payout: MERCHANT.toLowerCase() as Address,
    reference: "inv-7",
    description: null,
    line_items: [{ name: "Pro plan", quantity: 1, unit_amount: "25000000" }],
  };

  it("spells the payout proof message with the checksummed payout, bound to the chain and the node's hub", () => {
    const hub = "0x5fbdb2315678afecb367f032d93f642f64180aa3" as Address;
    expect(payoutChangeMessage("new", MERCHANT.toLowerCase() as Address, 1_800_000_000, { chainId: 133, hub })).toBe(
      `Payminto payout change new ${MERCHANT} 1800000000 chain 133 hub 0x5FbDB2315678afecb367f032d93F642f64180aa3`,
    );
    // Another node (chain or hub) gets another message, so a proof cannot be replayed there.
    expect(payoutChangeMessage("new", MERCHANT, 1_800_000_000, { chainId: 177, hub })).not.toBe(payoutChangeMessage("new", MERCHANT, 1_800_000_000, { chainId: 133, hub }));
  });

  it("builds the checkout wallet TransferWithAuthorization to the forwarder with a deterministic nonce", () => {
    const ref = paymentRef(133, "pay_aaaaaaaaaaaaaaaaaaaaaaaa");
    const domain = { name: "USD Coin", version: "2", chainId: 133, verifyingContract: "0x054ed45810dbbab8b27668922d110669c9d88d0a" as Address };
    const forwarder = OTHER;
    const template = checkoutTransferTemplate({ domain, forwarder, paymentRef: ref, paid: 0n, value: 2_000_000n, expiresAt: 1_800_000_000 });
    const wire = JSON.parse(JSON.stringify(template)) as typeof template;
    const typed = checkoutTypedData(wire, PAYER.address);
    expect(typed.primaryType).toBe("TransferWithAuthorization");
    expect(typed.message).toEqual(walletTransferAuthorization({ forwarder, paymentRef: ref, paid: 0n, value: 2_000_000n, expiresAt: 1_800_000_000, from: PAYER.address }));
    expect(typed.message).toMatchObject({ to: forwarder, validAfter: 0n, validBefore: 1_800_000_000n, nonce: walletPaymentNonce(ref, 0n) });
    // Each payable state of a payment has its own nonce.
    expect(walletPaymentNonce(ref, 1n)).not.toBe(walletPaymentNonce(ref, 0n));
  });

  it("hashes metadata canonically, and the zero hash when there is none", () => {
    expect(metadataHash(undefined)).toBe(`0x${"00".repeat(32)}`);
    expect(metadataHash({})).toBe(`0x${"00".repeat(32)}`);
    expect(metadataHash({ b: "2", a: "1" })).toBe(keccak256(new TextEncoder().encode('{"a":"1","b":"2"}')));
    expect(metadataHash({ b: "2", a: "1" })).toBe(metadataHash({ a: "1", b: "2" }));
  });

  it("serializes sorted, without whitespace or metadata, with checksummed addresses", () => {
    const order = { ...base, metadata_hash: metadataHash({ crm: "c-1" }) };
    const json = canonicalOrder(order);
    expect(json).toBe(
      `{"amount":"25000000","description":null,"line_items":[{"name":"Pro plan","quantity":1,"unit_amount":"25000000"}],` +
        `"metadata_hash":"${metadataHash({ crm: "c-1" })}","payment_id":"pay_aaaaaaaaaaaaaaaaaaaaaaaa",` +
        `"payout":"${MERCHANT}","reference":"inv-7","token":"0x054ed45810DbBAb8B27668922D110669c9D88D0a"}`,
    );
    expect(json).not.toContain("c-1");
    expect(orderHash(order)).toBe(keccak256(new TextEncoder().encode(json)));
    expect(orderHash({ ...order, metadata_hash: metadataHash({ crm: "c-2" }) })).not.toBe(orderHash(order));
    expect(canonicalJson({ z: [{ b: 1, a: 2 }], a: null })).toBe('{"a":null,"z":[{"a":2,"b":1}]}');
    expect(lineItemsTotal([{ name: "a", quantity: 3, unit_amount: "7" }, { name: "b", quantity: 1, unit_amount: "4" }])).toBe(25n);
  });
});
