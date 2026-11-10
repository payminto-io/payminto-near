import { publicKeyToString } from "@payminto/chain";
import { describe, expect, it } from "vitest";
import {
  agentAccountId,
  agentKeyPermission,
  auditAgentKey,
  createAgentAccountTx,
  registerAgentAtTokenTx,
  revokeAgentKeyTx,
  rotateAgentKeyTx,
} from "../src/subaccounts/index.ts";
import { fixture } from "./helpers.ts";

const liveKey = fixture<{ key: { access_key: { permission: unknown } } }>("rpc/testnet-function-call-key.live.json");

const OWNER = "acme.testnet";
const HUB = "hub.payminto.testnet";
const TOKEN = "3e2210e1184b45b64c8a434c0a7e7b23cc04ea7eb7a6c3c32520d03d4afcb8af";
const OWNER_PK = publicKeyToString(new Uint8Array(32).fill(1));
const AGENT_PK = publicKeyToString(new Uint8Array(32).fill(2));
const AGENT_PK_2 = publicKeyToString(new Uint8Array(32).fill(3));

describe("agent account names", () => {
  it("is one label under the owner", () => {
    expect(agentAccountId("agent-1", OWNER)).toBe("agent-1.acme.testnet");
    expect(agentAccountId("research", "acme.near")).toBe("research.acme.near");
  });

  it("refuses nested labels, bad characters, implicit owners and over-long ids", () => {
    expect(() => agentAccountId("a.b", OWNER)).toThrow(/one account-id segment/);
    expect(() => agentAccountId("Agent", OWNER)).toThrow();
    expect(() => agentAccountId("a--b", OWNER)).toThrow();
    expect(() => agentAccountId("x", "ab".repeat(32))).toThrow(/implicit/);
    expect(() => agentAccountId("a".repeat(60), OWNER)).toThrow(/64 characters/);
  });
});

describe("agent keys follow what the agent calls on chain", () => {
  it("a buyer calls nothing on chain, so it gets no key", () => {
    expect(agentKeyPermission(HUB, "buyer")).toBeNull();
    const { accountId, tx } = createAgentAccountTx({ owner: OWNER, label: "buyer-1", hub: HUB, role: "buyer", ownerPublicKey: OWNER_PK });
    expect(accountId).toBe("buyer-1.acme.testnet");
    expect(tx).toEqual({
      receiverId: "buyer-1.acme.testnet",
      actions: [
        { type: "CreateAccount" },
        { type: "Transfer", params: { deposit: "50000000000000000000000" } },
        { type: "AddKey", params: { publicKey: OWNER_PK, accessKey: { nonce: 0, permission: "FullAccess" } } },
      ],
    });
    expect(() => createAgentAccountTx({ owner: OWNER, label: "b", hub: HUB, role: "buyer", ownerPublicKey: OWNER_PK, agentPublicKey: AGENT_PK })).toThrow(/no access key/);
  });

  it("a seller gets one function-call key: the hub, settle_own and payout, a finite allowance", () => {
    const { tx } = createAgentAccountTx({ owner: OWNER, label: "seller-1", hub: HUB, role: "seller", ownerPublicKey: OWNER_PK, agentPublicKey: AGENT_PK });
    expect(tx.actions[3]).toEqual({
      type: "AddKey",
      params: {
        publicKey: AGENT_PK,
        accessKey: { nonce: 0, permission: { receiverId: HUB, allowance: "250000000000000000000000", methodNames: ["settle_own", "payout"] } },
      },
    });
    expect(tx.actions.filter((a) => a.type === "AddKey" && a.params.accessKey.permission === "FullAccess")).toHaveLength(1);
  });

  it("never lets an agent key reach fund_from_credit, revoke_budget or other owner methods", () => {
    const p = agentKeyPermission(HUB, "seller") as { methodNames: string[] };
    for (const m of ["fund_from_credit", "revoke_budget", "reclaim", "open_budget", "settle_batch", "set_settler"]) expect(p.methodNames).not.toContain(m);
  });

  it("refuses a seller without a key, a shared owner and agent key, and a zero allowance", () => {
    expect(() => createAgentAccountTx({ owner: OWNER, label: "s", hub: HUB, role: "seller", ownerPublicKey: OWNER_PK })).toThrow(/needs agentPublicKey/);
    expect(() => createAgentAccountTx({ owner: OWNER, label: "s", hub: HUB, role: "seller", ownerPublicKey: OWNER_PK, agentPublicKey: OWNER_PK })).toThrow(/differ/);
    expect(() => agentKeyPermission(HUB, "seller", "0")).toThrow(/positive/);
  });

  it("registers the agent at the token, rotates and revokes its key", () => {
    expect(registerAgentAtTokenTx(TOKEN, "seller-1.acme.testnet", "1250000000000000000000")).toEqual({
      receiverId: TOKEN,
      actions: [{ type: "FunctionCall", params: { methodName: "storage_deposit", args: { account_id: "seller-1.acme.testnet", registration_only: true }, gas: "30000000000000", deposit: "1250000000000000000000" } }],
    });
    const rot = rotateAgentKeyTx("seller-1.acme.testnet", HUB, AGENT_PK, AGENT_PK_2);
    expect(rot.actions.map((a) => a.type)).toEqual(["AddKey", "DeleteKey"]);
    expect(revokeAgentKeyTx("seller-1.acme.testnet", AGENT_PK)).toEqual({ receiverId: "seller-1.acme.testnet", actions: [{ type: "DeleteKey", params: { publicKey: AGENT_PK } }] });
  });
});

describe("auditing a key read from chain", () => {
  it("accepts exactly the seller permission in the RPC view shape", () => {
    expect(auditAgentKey({ FunctionCall: { allowance: "250000000000000000000000", receiver_id: HUB, method_names: ["settle_own", "payout"] } }, HUB, "seller")).toEqual([]);
  });

  it("flags the live testnet key: another receiver, every method, as the view returns it", () => {
    const problems = auditAgentKey(liveKey.key.access_key.permission, HUB, "seller");
    expect(problems.join("; ")).toMatch(/expected hub\.payminto\.testnet/);
    expect(problems.join("; ")).toMatch(/every method/);
  });

  it("flags full access, extra methods and unlimited allowance", () => {
    expect(auditAgentKey("FullAccess", HUB, "seller")).toEqual(["the agent key is a full-access key"]);
    expect(auditAgentKey({ FunctionCall: { allowance: null, receiver_id: HUB, method_names: ["payout", "fund_from_credit"] } }, HUB, "seller")).toEqual([
      "key may call fund_from_credit, which a seller agent does not need",
      "key has unlimited gas allowance",
    ]);
    expect(auditAgentKey({ FunctionCall: { allowance: "1", receiver_id: HUB, method_names: ["payout"] } }, HUB, "buyer")).toEqual(["key may call payout, which a buyer agent does not need"]);
  });
});
