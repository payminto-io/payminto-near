import { describe, expect, it } from "vitest";
import { keccak256, toBytes, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { receiptVerifiedOnchain } from "../src/proofs.ts";

// Anvil dev keys (public, local only).
const OPERATOR = privateKeyToAccount("0x2a871d0798f97d79848a013d4936a73bf4cc922c825d33c1cf7073dff6d409c6");
const ATTACKER = privateKeyToAccount("0xdbda1821b80551c9d65939329250298aa3472ba22feea921c0cf5d620ea67b97");
const HUB = "0x5FbDB2315678afecb367f032d93F642f64180aa3" as Address;
const BATCH = keccak256(toBytes("batch"));
const LEAF = keccak256(toBytes("leaf"));

/** A chain whose batches(batchId) names `settler` and whose verifyReceipt always says yes. */
function chain(settler: Address, opts: { fail?: boolean } = {}) {
  const calls: string[] = [];
  const readContract = async (args: { functionName: string }) => {
    calls.push(args.functionName);
    if (opts.fail) throw new Error("rpc down");
    return args.functionName === "batches" ? [keccak256(toBytes("root")), HUB, settler, 1n, 1n, 1n] : true;
  };
  return { c: { hub: HUB, operator: OPERATOR, public: { readContract } } as never, calls };
}

describe("receipt proof verification", () => {
  it("is verified when this node settled the batch and signed the leaf", async () => {
    const sig = await OPERATOR.signMessage({ message: { raw: LEAF } });
    expect(await receiptVerifiedOnchain(chain(OPERATOR.address).c, BATCH, LEAF, sig, [])).toBe(true);
  });

  it("is not verified when someone else settled the batch, even though verifyReceipt matches its root", async () => {
    // For example a front-run settleBatch under this node's batch id with a root of made-up receipts.
    const sig = await OPERATOR.signMessage({ message: { raw: LEAF } });
    const { c, calls } = chain(ATTACKER.address);
    expect(await receiptVerifiedOnchain(c, BATCH, LEAF, sig, [])).toBe(false);
    expect(calls).toEqual(["batches"]);
  });

  it("is not verified when the leaf is not signed by this node", async () => {
    const sig = (await ATTACKER.signMessage({ message: { raw: LEAF } })) as Hex;
    expect(await receiptVerifiedOnchain(chain(OPERATOR.address).c, BATCH, LEAF, sig, [])).toBe(false);
  });

  it("is unknown (null) when the chain cannot be read", async () => {
    const sig = await OPERATOR.signMessage({ message: { raw: LEAF } });
    expect(await receiptVerifiedOnchain(chain(OPERATOR.address, { fail: true }).c, BATCH, LEAF, sig, [])).toBeNull();
  });
});
