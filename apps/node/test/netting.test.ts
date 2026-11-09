import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { erc20Abi, getAddress, keccak256, maxUint256, parseEventLogs, toBytes, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  clearingHubAbi,
  mandateId as computeMandateId,
  mandateTypedData,
  payeesRoot,
  policyHash,
  voucherTypedData,
  type Mandate,
} from "@payminto/protocol";
import { netDebits, projectNetting, grossGraph, type ClaimFlow } from "../src/netting.ts";
import { ANVIL_KEYS, deployClearing, mint, startAnvil, type Anvil } from "./helpers.ts";

const A = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8" as Address;
const B = "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC" as Address;
const C = "0x90F79bf6EB2c4f870365E785982E1f101E93b906" as Address;
const D = "0x15d34AAf54267DB7D7c367839AAf71A00a2C6A65" as Address;

describe("netting projection (pure)", () => {
  it("nets a two-agent cycle to one transfer", () => {
    const p = projectNetting([
      { agent: A, payee: B, delta: 300n },
      { agent: B, payee: A, delta: 100n },
    ]);
    expect(p.gross).toBe(400n);
    expect(p.transfers).toEqual([{ from: A, to: B, amount: 200n }]);
    expect(p.net).toBe(200n);
  });

  it("cancels a perfectly balanced cycle to zero transfers", () => {
    const p = projectNetting([
      { agent: A, payee: B, delta: 50n },
      { agent: B, payee: C, delta: 50n },
      { agent: C, payee: A, delta: 50n },
    ]);
    expect(p.transfers).toEqual([]);
    expect(p.gross).toBe(150n);
    expect(p.net).toBe(0n);
  });

  it("skips zero deltas and self-payments net to nothing", () => {
    const p = projectNetting([
      { agent: A, payee: A, delta: 70n },
      { agent: A, payee: B, delta: 0n },
    ]);
    expect(p.transfers).toEqual([]);
    expect(p.parties).toBe(1);
  });

  it("produces at most parties - 1 transfers and conserves value", () => {
    const flows: ClaimFlow[] = [
      { agent: A, payee: C, delta: 10n },
      { agent: A, payee: D, delta: 20n },
      { agent: B, payee: C, delta: 30n },
      { agent: B, payee: A, delta: 5n },
    ];
    const p = projectNetting(flows);
    expect(p.transfers.length).toBeLessThanOrEqual(p.parties - 1);
    const debits = netDebits(p);
    expect(debits.get(A)).toBe(25n);
    expect(debits.get(B)).toBe(35n);
    const received = new Map<string, bigint>();
    for (const t of p.transfers) received.set(t.to, (received.get(t.to) ?? 0n) + t.amount);
    expect(received.get(C)).toBe(40n);
    expect(received.get(D)).toBe(20n);
  });

  it("aggregates the gross obligations graph per edge", () => {
    expect(
      grossGraph([
        { agent: A, payee: B, amount: 1n, calls: 1 },
        { agent: A.toLowerCase() as Address, payee: B, amount: 2n, calls: 2 },
        { agent: B, payee: A, amount: 5n, calls: 1 },
      ]),
    ).toEqual([
      { from: A, to: B, amount: 3n, calls: 3 },
      { from: B, to: A, amount: 5n, calls: 1 },
    ]);
  });

  it("rejects negative deltas", () => {
    expect(() => projectNetting([{ agent: A, payee: B, delta: -1n }])).toThrow();
  });
});

// Contract parity: random obligation graphs settled on a real ClearingHub must emit exactly the projected transfers.
describe("netting projection matches ClearingHub.settleBatch", () => {
  let anvil: Anvil;
  let hub: Address;
  let token: Address;
  const agentKeys = ANVIL_KEYS.slice(1, 6);
  const agents = agentKeys.map((k) => privateKeyToAccount(k));
  const owner = privateKeyToAccount(ANVIL_KEYS[6]);
  const outsiders = [getAddress("0x00000000000000000000000000000000000000a1"), getAddress("0x00000000000000000000000000000000000000b2")];
  const mandates = new Map<Address, Hex>();
  const cumulative = new Map<string, bigint>();

  beforeAll(async () => {
    anvil = await startAnvil();
    ({ hub, token } = await deployClearing(anvil));
    const now = (await anvil.pub.getBlock()).timestamp;
    for (const [i, a] of agents.entries()) {
      await mint(anvil, token, a.address, 1_000_000_000n);
      const w = anvil.wallet(agentKeys[i]!);
      await anvil.pub.waitForTransactionReceipt({
        hash: await w.writeContract({ address: token, abi: erc20Abi, functionName: "approve", args: [hub, maxUint256] }),
      });
      const m: Mandate = {
        owner: owner.address,
        agent: a.address,
        token,
        totalCap: 10n ** 15n,
        validAfter: now - 10n,
        validUntil: now + 86_400n,
        payeesRoot: payeesRoot([]),
        policyHash: policyHash({ perCallCap: "1", dailyCap: "1", maxCallsPerMinute: 0, purpose: "parity" }),
        salt: keccak256(toBytes(`parity-${i}`)),
      };
      const sig = await owner.signTypedData(mandateTypedData(31337, hub, m));
      await anvil.pub.waitForTransactionReceipt({
        hash: await anvil.wallet(ANVIL_KEYS[0]).writeContract({ address: hub, abi: clearingHubAbi, functionName: "openMandate", args: [m, sig] }),
      });
      mandates.set(a.address, computeMandateId(31337, hub, m));
    }
  }, 60_000);

  afterAll(() => anvil?.stop());

  // Deterministic pseudo-random generator so failures reproduce.
  function rng(seed: number) {
    let s = seed >>> 0;
    return () => {
      s = (s * 1664525 + 1013904223) >>> 0;
      return s / 2 ** 32;
    };
  }

  for (const seed of [1, 7, 42, 1337, 9001]) {
    it(`seed ${seed}`, async () => {
      const r = rng(seed);
      const parties: Address[] = [...agents.map((a) => a.address), ...outsiders];
      const pairs = new Map<string, { agentIdx: number; payee: Address }>();
      const n = 3 + Math.floor(r() * 14);
      while (pairs.size < n) {
        const agentIdx = Math.floor(r() * agents.length);
        const payee = parties[Math.floor(r() * parties.length)]!;
        pairs.set(`${agentIdx}:${payee}`, { agentIdx, payee });
      }
      const claims = [];
      const flows: ClaimFlow[] = [];
      for (const { agentIdx, payee } of pairs.values()) {
        const agent = agents[agentIdx]!;
        const id = mandates.get(agent.address)!;
        const key = `${id}:${payee}`;
        const delta = BigInt(1 + Math.floor(r() * 1_000_000));
        const cum = (cumulative.get(key) ?? 0n) + delta;
        cumulative.set(key, cum);
        const voucher = { mandateId: id, payee, cumulative: cum };
        claims.push({ voucher, agentSig: await agent.signTypedData(voucherTypedData(31337, hub, voucher)), payeeProof: [] as Hex[] });
        flows.push({ agent: agent.address, payee, delta });
      }
      const projection = projectNetting(flows);
      const batchId = keccak256(toBytes(`parity-batch-${seed}`));
      const hash = await anvil.wallet(ANVIL_KEYS[0]).writeContract({
        address: hub,
        abi: clearingHubAbi,
        functionName: "settleBatch",
        args: [batchId, keccak256(toBytes(`root-${seed}`)), token, claims],
      });
      const rcpt = await anvil.pub.waitForTransactionReceipt({ hash });
      expect(rcpt.status).toBe("success");
      const events = parseEventLogs({ abi: clearingHubAbi, logs: rcpt.logs, eventName: "NetTransfer" }).map((l) => ({
        from: getAddress(l.args.from as Address),
        to: getAddress(l.args.to as Address),
        amount: l.args.amount as bigint,
      }));
      expect(events).toEqual(projection.transfers);
      const settled = parseEventLogs({ abi: clearingHubAbi, logs: rcpt.logs, eventName: "BatchSettled" })[0]!;
      expect(settled.args.gross).toBe(projection.gross);
      expect(settled.args.net).toBe(projection.net);
      expect(settled.args.transfers).toBe(BigInt(projection.transfers.length));
    });
  }
});
