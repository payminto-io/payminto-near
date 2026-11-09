/**
 * Measures real gas on a throwaway anvil: openMandate, openMandateWithPermit, settleBatch with 1, 2, 16 and 64 claims
 * (with netting, first and repeat settlement), and a plain ERC-20 transfer, then writes docs/gas.json and docs/GAS.md.
 * The OP Stack L1 data fee of each measured transaction is priced with read-only eth_calls to the HashKey Chain
 * mainnet GasPriceOracle (getL1Fee over the unsigned EIP-1559 transaction carrying the measured calldata).
 *
 *   pnpm --filter @payminto/node gas
 *
 * Transactions go to a local anvil only; mainnet is only read (L1_FEE_RPC_URL overrides the RPC, "none" skips it).
 * It never touches a shared database.
 */
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createPublicClient,
  erc20Abi,
  getAddress,
  http,
  keccak256,
  maxUint256,
  parseEventLogs,
  parseSignature,
  serializeTransaction,
  toBytes,
  type Address,
  type Hex,
} from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import {
  clearingHubAbi,
  gasPriceOracleAbi,
  hashkeyContracts,
  hashkeyMainnet,
  mockStablecoinAbi,
  permitTypedData,
  mandateId as computeMandateId,
  mandateTypedData,
  payeesRoot,
  policyHash,
  voucherTypedData,
  type Mandate,
} from "@payminto/protocol";
import { projectNetting } from "../src/netting.ts";
import { ANVIL_KEYS, deployClearing, mint, startAnvil } from "../test/helpers.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const HSK_BASE_FEE_GWEI = 500n; // research/01-hsp-hashkey-tech.md, measured 2026-10-24
const CALLS_PER_CLAIM = 10; // gas does not depend on it: the receipts tree is one bytes32 on chain
const L1_FEE_RPC_URL = process.env.L1_FEE_RPC_URL ?? "https://mainnet.hsk.xyz";

/** Read-only: the mainnet GasPriceOracle's L1 data fee for an unsigned EIP-1559 tx with this calldata, or null. */
async function mainnetL1Fees(calldata: Hex[]): Promise<{ fees: Array<bigint | null>; block: bigint | null }> {
  if (L1_FEE_RPC_URL === "none") return { fees: calldata.map(() => null), block: null };
  try {
    const client = createPublicClient({ chain: hashkeyMainnet, transport: http(L1_FEE_RPC_URL, { timeout: 15_000, retryCount: 2 }) });
    const block = await client.getBlockNumber();
    const fees = await Promise.all(
      calldata.map((data) =>
        client.readContract({
          address: hashkeyContracts[177].gasPriceOracle,
          abi: gasPriceOracleAbi,
          functionName: "getL1Fee",
          blockNumber: block,
          args: [
            serializeTransaction({
              chainId: 177,
              type: "eip1559",
              nonce: 1_000,
              to: getAddress(`0x${"11".repeat(20)}`),
              data,
              gas: 3_000_000n,
              maxFeePerGas: 501_000_000_000n,
              maxPriorityFeePerGas: 1_000_000n,
            }),
          ],
        }),
      ),
    );
    return { fees, block };
  } catch (err) {
    process.stderr.write(`L1 fee not measured (${err instanceof Error ? err.message.split("\n")[0] : String(err)})\n`);
    return { fees: calldata.map(() => null), block: null };
  }
}

const anvil = await startAnvil();
try {
  const { hub, token } = await deployClearing(anvil);
  const deployer = anvil.wallet(ANVIL_KEYS[0]);
  const owner = privateKeyToAccount(ANVIL_KEYS[9]);
  const agentKeys = ANVIL_KEYS.slice(1, 9);
  const agents = agentKeys.map((k) => privateKeyToAccount(k));
  const gas = async (hash: Hex) => {
    const r = await anvil.pub.waitForTransactionReceipt({ hash });
    if (r.status !== "success") throw new Error(`tx ${hash} reverted`);
    return r;
  };

  // Plain ERC-20 transfers: to an address that never held the token (cold) and to one that does (warm).
  await mint(anvil, token, agents[0]!.address, 10n ** 12n);
  const a0 = anvil.wallet(agentKeys[0]!);
  const coldTo = getAddress(`0x${"c0".repeat(20)}`);
  const transferColdHash = await a0.writeContract({ address: token, abi: erc20Abi, functionName: "transfer", args: [coldTo, 1_000n] });
  const transferCold = (await gas(transferColdHash)).gasUsed;
  const transferWarm = (await gas(await a0.writeContract({ address: token, abi: erc20Abi, functionName: "transfer", args: [coldTo, 1_000n] }))).gasUsed;
  const transferInput = (await anvil.pub.getTransaction({ hash: transferColdHash })).input;

  // One mandate per agent, all funded and approved.
  const now = (await anvil.pub.getBlock()).timestamp;
  const mandates = new Map<Address, Hex>();
  let openMandateGas = 0n;
  let openMandateInput: Hex = "0x";
  for (const [i, a] of agents.entries()) {
    const policy = { perCallCap: "1000000", dailyCap: "1000000000", maxCallsPerMinute: 0, purpose: `gas ${i}` };
    const m: Mandate = {
      owner: owner.address,
      agent: a.address,
      token,
      totalCap: 10n ** 15n,
      validAfter: now - 60n,
      validUntil: now + 86_400n,
      payeesRoot: payeesRoot([]),
      policyHash: policyHash(policy),
      salt: keccak256(toBytes(`gas-${i}`)),
    };
    const sig = await owner.signTypedData(mandateTypedData(31337, hub, m));
    const openHash = await deployer.writeContract({ address: hub, abi: clearingHubAbi, functionName: "openMandate", args: [m, sig] });
    const r = await gas(openHash);
    if (i === 0) {
      openMandateGas = r.gasUsed;
      openMandateInput = (await anvil.pub.getTransaction({ hash: openHash })).input;
    }
    mandates.set(a.address, computeMandateId(31337, hub, m));
    await mint(anvil, token, a.address, 10n ** 12n);
    await gas(await anvil.wallet(agentKeys[i]!).writeContract({ address: token, abi: erc20Abi, functionName: "approve", args: [hub, maxUint256] }));
  }

  // Gasless onboarding: the same mandate plus the agent's EIP-2612 permit, in one call the operator pays for.
  const permitAgent = privateKeyToAccount(generatePrivateKey());
  const pm: Mandate = {
    owner: owner.address,
    agent: permitAgent.address,
    token,
    totalCap: 10n ** 15n,
    validAfter: now - 60n,
    validUntil: now + 86_400n,
    payeesRoot: payeesRoot([]),
    policyHash: policyHash({ perCallCap: "1000000", dailyCap: "1000000000", maxCallsPerMinute: 0, purpose: "gas permit" }),
    salt: keccak256(toBytes("gas-permit")),
  };
  const permitSig = parseSignature(
    await permitAgent.signTypedData(
      permitTypedData(
        { name: "USD Coin", version: "1", chainId: 31337, verifyingContract: token },
        { owner: permitAgent.address, spender: hub, value: maxUint256, nonce: 0n, deadline: now + 3_600n },
      ),
    ),
  );
  const permitOpenHash = await deployer.writeContract({
    address: hub,
    abi: clearingHubAbi,
    functionName: "openMandateWithPermit",
    args: [pm, await owner.signTypedData(mandateTypedData(31337, hub, pm)), maxUint256, now + 3_600n, Number(permitSig.v), permitSig.r, permitSig.s],
  });
  const openWithPermitGas = (await gas(permitOpenHash)).gasUsed;
  const openWithPermitInput = (await anvil.pub.getTransaction({ hash: permitOpenHash })).input;
  if ((await anvil.pub.readContract({ address: token, abi: mockStablecoinAbi, functionName: "allowance", args: [permitAgent.address, hub] })) !== maxUint256) {
    throw new Error("permit did not set the allowance");
  }

  // Payees: the agents themselves (so obligations net) plus eight provider wallets that start empty.
  const providers = Array.from({ length: 8 }, (_, i) => getAddress(`0x${(0xa000 + i).toString(16).padStart(40, "0")}`));
  const parties: Address[] = [...agents.map((a) => a.address), ...providers];
  const cumulative = new Map<string, bigint>();
  let seed = 12345;
  const rand = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);

  function pairs(k: number): Array<{ agentIdx: number; payee: Address }> {
    if (k === 1) return [{ agentIdx: 0, payee: providers[0]! }];
    if (k === 2) return [{ agentIdx: 1, payee: agents[2]!.address }, { agentIdx: 2, payee: providers[1]! }];
    const out = new Map<string, { agentIdx: number; payee: Address }>();
    while (out.size < k) {
      const agentIdx = Math.floor(rand() * agents.length);
      const payee = parties[Math.floor(rand() * parties.length)]!;
      if (payee === agents[agentIdx]!.address) continue;
      out.set(`${agentIdx}:${payee}`, { agentIdx, payee });
    }
    return [...out.values()];
  }

  type Row = { claims: number; calls: number; kind: "first" | "repeat"; gasUsed: bigint; transfers: number; calldataBytes: number; input: Hex };
  const rows: Row[] = [];
  let batchSeq = 0;
  async function settle(ps: Array<{ agentIdx: number; payee: Address }>, kind: Row["kind"]) {
    const claims = [];
    const flows = [];
    for (const { agentIdx, payee } of ps) {
      const agent = agents[agentIdx]!;
      const id = mandates.get(agent.address)!;
      const delta = BigInt(CALLS_PER_CLAIM) * BigInt(1_000 + Math.floor(rand() * 9_000));
      const cum = (cumulative.get(`${id}:${payee}`) ?? 0n) + delta;
      cumulative.set(`${id}:${payee}`, cum);
      const voucher = { mandateId: id, payee, cumulative: cum };
      claims.push({ voucher, agentSig: await agent.signTypedData(voucherTypedData(31337, hub, voucher)), payeeProof: [] as Hex[] });
      flows.push({ agent: agent.address, payee, delta });
    }
    const batchId = keccak256(toBytes(`gas-batch-${++batchSeq}`));
    const hash = await deployer.writeContract({
      address: hub,
      abi: clearingHubAbi,
      functionName: "settleBatch",
      args: [batchId, keccak256(toBytes(`root-${batchSeq}`)), token, claims],
    });
    const r = await gas(hash);
    const tx = await anvil.pub.getTransaction({ hash });
    const transfers = parseEventLogs({ abi: clearingHubAbi, logs: r.logs, eventName: "NetTransfer" }).length;
    if (transfers !== projectNetting(flows).transfers.length) throw new Error("projection mismatch");
    rows.push({ claims: ps.length, calls: ps.length * CALLS_PER_CLAIM, kind, gasUsed: r.gasUsed, transfers, calldataBytes: (tx.input.length - 2) / 2, input: tx.input });
  }
  for (const k of [1, 2, 16, 64]) {
    const ps = pairs(k);
    await settle(ps, "first"); // new (mandate, payee) slots and, for some providers, first token balance
    await settle(ps, "repeat"); // the steady state: same pairs, higher cumulative
  }

  // L1 data fee of each measured transaction, priced by the mainnet GasPriceOracle (read-only).
  const l1 = await mainnetL1Fees([transferInput, openMandateInput, openWithPermitInput, ...rows.map((r) => r.input)]);
  const [l1Transfer, l1Open, l1OpenPermit, ...l1Rows] = l1.fees;
  const result = {
    measuredAt: new Date().toISOString(),
    environment: "anvil (local), solc 0.8.24 optimizer 200 runs, MockStablecoin (OpenZeppelin ERC-20)",
    callsPerClaim: CALLS_PER_CLAIM,
    l1FeeSource: l1.block === null ? null : { rpc: L1_FEE_RPC_URL, chainId: 177, block: l1.block.toString(), oracle: hashkeyContracts[177].gasPriceOracle },
    erc20Transfer: { cold: transferCold.toString(), warm: transferWarm.toString(), l1FeeWei: l1Transfer?.toString() ?? null },
    openMandate: openMandateGas.toString(),
    openMandateWithPermit: openWithPermitGas.toString(),
    settleBatch: rows.map(({ input: _input, ...r }, i) => ({
      ...r,
      gasUsed: r.gasUsed.toString(),
      gasPerClaim: (r.gasUsed / BigInt(r.claims)).toString(),
      l1FeeWei: l1Rows[i]?.toString() ?? null,
    })),
  };
  writeFileSync(join(ROOT, "docs", "gas.json"), JSON.stringify(result, null, 2) + "\n");

  const fmt = (n: bigint) => n.toLocaleString("en-US");
  const hsk = (g: bigint) => {
    const wei = g * HSK_BASE_FEE_GWEI * 10n ** 9n;
    const s = (Number(wei / 10n ** 12n) / 1e6).toFixed(6);
    return s;
  };
  const big = rows.find((r) => r.claims === 64 && r.kind === "repeat")!;
  const bigL1 = l1Rows[rows.indexOf(big)] ?? null;
  const l2Wei = (g: bigint) => g * HSK_BASE_FEE_GWEI * 10n ** 9n;
  const hskWei = (wei: bigint | null | undefined) => (wei === null || wei === undefined ? "-" : (Number(wei / 10n ** 9n) / 1e9).toFixed(9));
  const share = (g: bigint, wei: bigint | null | undefined) =>
    wei === null || wei === undefined ? "-" : `${((Number(wei) / Number(l2Wei(g) + wei)) * 100).toFixed(3)}%`;
  const naive = BigInt(big.calls) * transferWarm;
  const lines = [
    "# Gas: measured, not estimated",
    "",
    "<!-- Generated by `pnpm --filter @payminto/node gas` (apps/node/scripts/measure-gas.ts). Re-run instead of editing numbers by hand. -->",
    "",
    `Measured on ${result.measuredAt.slice(0, 10)} on a local anvil with the repository's ClearingHub (solc 0.8.24, optimizer 200 runs) and MockStablecoin, an OpenZeppelin ERC-20.`,
    "Each settleBatch claim is the latest voucher of one (mandate, payee) pair, so it clears any number of calls: gas depends on claims and net transfers, never on calls, because the hub stores one receipts root per batch.",
    `The table assumes ${CALLS_PER_CLAIM} calls per claim only to show calls settled; any other number gives the same gas.`,
    "\"First\" settles new (mandate, payee) pairs and pays some providers for the first time (cold storage); \"repeat\" settles the same pairs again, which is the steady state.",
    "Obligations are a seeded random graph among 8 agents and 8 providers, where agents are also payees, so the hub nets them.",
    "",
    "## Headline",
    "",
    `${big.calls} calls settled in one batch for ${fmt(big.gasUsed)} gas versus ${fmt(naive)} gas for one ERC-20 transfer per call, about ${(Number(naive) / Number(big.gasUsed)).toFixed(1)}x less.`,
    `That batch had ${big.claims} claims and ${big.transfers} net transfers.`,
    `Per claim it costs ${fmt(big.gasUsed / BigInt(big.claims))} gas, so batching beats one transfer per call (${fmt(transferWarm)} gas) as soon as a (mandate, payee) pair has about ${(Number(big.gasUsed / BigInt(big.claims)) / Number(transferWarm)).toFixed(2)} calls or more per batch, and every extra call on a pair is free on chain.`,
    "The node reports the same comparison live in `GET /v1/overview` (`gasSaved`), using the measured existing-recipient transfer gas as the naive cost per call.",
    "",
    "## Measurements",
    "",
    "| Operation | Claims | Calls settled | Net transfers | Gas used | Gas per claim | Calldata bytes | HSK at 500 gwei | L1 data fee (HSK) | L1 share |",
    "|---|---|---|---|---|---|---|---|---|---|",
    `| ERC-20 transfer, new recipient | - | 1 | 1 | ${fmt(transferCold)} | - | ${(transferInput.length - 2) / 2} | ${hsk(transferCold)} | ${hskWei(l1Transfer)} | ${share(transferCold, l1Transfer)} |`,
    `| ERC-20 transfer, existing recipient | - | 1 | 1 | ${fmt(transferWarm)} | - | ${(transferInput.length - 2) / 2} | ${hsk(transferWarm)} | ${hskWei(l1Transfer)} | ${share(transferWarm, l1Transfer)} |`,
    `| openMandate (once per mandate) | - | - | - | ${fmt(openMandateGas)} | - | ${(openMandateInput.length - 2) / 2} | ${hsk(openMandateGas)} | ${hskWei(l1Open)} | ${share(openMandateGas, l1Open)} |`,
    `| openMandateWithPermit (mandate plus allowance, agent sends nothing) | - | - | - | ${fmt(openWithPermitGas)} | - | ${(openWithPermitInput.length - 2) / 2} | ${hsk(openWithPermitGas)} | ${hskWei(l1OpenPermit)} | ${share(openWithPermitGas, l1OpenPermit)} |`,
    ...rows.map(
      (r, i) =>
        `| settleBatch, ${r.kind} | ${r.claims} | ${r.calls} | ${r.transfers} | ${fmt(r.gasUsed)} | ${fmt(r.gasUsed / BigInt(r.claims))} | ${r.calldataBytes} | ${hsk(r.gasUsed)} | ${hskWei(l1Rows[i])} | ${share(r.gasUsed, l1Rows[i])} |`,
    ),
    "",
    "## Cost at a given gas price",
    "",
    "cost in HSK = gasUsed x gasPrice (gwei) x 10^-9.",
    "cost in USD = cost in HSK x HSK/USD.",
    "Naive cost of N calls paid one by one = N x ERC-20 transfer gas x gasPrice, versus one settleBatch for all of them.",
    "The HSK column uses a base fee of 500 gwei, the HashKey Chain mainnet value measured on 2026-10-24 (research/01-hsp-hashkey-tech.md); re-check it at submission time.",
    "HSK/USD: fill in from a live price source at submission time (not stated here on purpose).",
    "",
    "## L1 data fee",
    "",
    "HashKey Chain is an OP Stack L2, so every transaction also pays an L1 data fee for posting its data to Ethereum, on top of the gas above.",
    l1.block === null
      ? "The L1 fee was not measured on this run (mainnet RPC unreachable or L1_FEE_RPC_URL=none); re-run with network access."
      : `The L1 fee column is the HashKey Chain mainnet GasPriceOracle (\`${hashkeyContracts[177].gasPriceOracle}\`) \`getL1Fee\` at block ${l1.block}, read with eth_call over an unsigned EIP-1559 transaction that carries exactly the measured calldata.`,
    ...(l1.block !== null && bigL1 !== null
      ? [
          `For the ${big.claims}-claim batch it is ${hskWei(bigL1)} HSK against ${hsk(big.gasUsed)} HSK of L2 execution at 500 gwei, ${share(big.gasUsed, bigL1)} of the total, so the 500 gwei L2 base fee dominates and batching savings carry over almost unchanged.`,
        ]
      : []),
    "The L1 fee moves with Ethereum blob and base fees; the node prices it into the operator balance preflight before every settlement (viem op-stack `estimateL1Fee`) and stores the fee each settlement actually paid (`l1Fee` from the OP Stack receipt) per batch.",
    "",
    "## Caveats",
    "",
    "- The gas and \"HSK at 500 gwei\" columns are L2 execution only; the L1 data fee is the separate column above.",
    "- Mainnet USDC.e is a proxied token with more logic than MockStablecoin, so each transferFrom costs somewhat more there; re-run this against a fork for exact mainnet numbers.",
    "- Payee allowlist proofs add calldata and about one hash per proof level per claim; these measurements use mandates without an allowlist.",
    "",
  ];
  writeFileSync(join(ROOT, "docs", "GAS.md"), lines.join("\n"));
  process.stdout.write(lines.slice(10, 13).join("\n") + "\nwrote docs/GAS.md and docs/gas.json\n");
} finally {
  anvil.stop();
}
