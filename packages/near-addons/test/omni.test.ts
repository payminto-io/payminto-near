import { describe, expect, it } from "vitest";
import { initTransferTx, OMNI, OmniApi, omniAddress, planOutbound, tokenRoute } from "../src/bridge/omni.ts";
import { NEAR_MAINNET_USDC } from "../src/intents/types.ts";
import { ViewRpc } from "../src/rpc.ts";
import { fakeFetch, fixture, rpcView, type Route } from "./helpers.ts";

type View = { result: unknown };
const views = fixture<{ views: Record<string, View> }>("omni/bridge-views.live.json").views;
const feeUsdc = fixture<{ body: unknown }>("omni/fee-native-usdc-to-base.live.json").body;
const feeWnear = fixture<{ body: { native_token_fee: string; transferred_token_fee: string } }>("omni/fee-wnear-to-base.live.json").body;
const status = fixture<{ body: unknown }>("omni/status-near-57628.live.json").body;
const transfer = fixture<{ body: { transfers: Array<{ status: string; destination_chain: string }> } }>("omni/transfer-near-57628.live.json").body;

const RPC = "https://rpc.mainnet.near.org";
const API = OMNI.mainnet.api;
const BRIDGE = OMNI.mainnet.bridge;
const RECIPIENT = "0x2527d02599ba641c19fea793cd0f167589a0f10d";
const v = (name: string) => rpcView(views[name]!.result);

const setup = (routes: Route[]) => {
  const { fetch, calls } = fakeFetch(routes);
  return { rpc: new ViewRpc(RPC, fetch), api: new OmniApi(API, fetch), calls };
};

describe("Omni Bridge routes (recorded live views)", () => {
  it("native USDC on NEAR has no route to Base, so the plan refuses before asking for a fee", async () => {
    const { rpc, api, calls } = setup([{ method: "POST", url: RPC, rpc: "get_token_address", status: 200, body: v("mainnet native USDC -> Base") }]);
    const plan = await planOutbound(rpc, api, { bridge: BRIDGE, token: NEAR_MAINNET_USDC, signer: "alice.near", chain: "Base", recipient: RECIPIENT, amount: 1_000_000n });
    expect(plan.txs).toEqual([]);
    expect(plan.refusals[0]).toMatch(/no Omni Bridge route to Base; the bridge would accept it but could not sign it/);
    expect(calls.filter((c) => c.url.startsWith(API))).toHaveLength(0);
  });

  it("the fee API still quotes that unroutable transfer, which is why the route is checked on chain", () => {
    expect(feeUsdc).toMatchObject({ native_token_fee: "2777777777888347621714", transferred_token_fee: null });
  });

  it("reads routes that do exist", async () => {
    const { rpc } = setup([{ method: "POST", url: RPC, rpc: "get_token_address", status: 200, body: v("mainnet USDC.e -> Eth") }]);
    expect(await tokenRoute(rpc, BRIDGE, "a0b86991c6218b36c1d19d4a2e9eb0ce3606eb48.factory.bridge.near", "Eth")).toBe("eth:0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48");
    expect(views["testnet Circle USDC -> Eth"]!.result).toBeNull();
  });
});

describe("planning a transfer out of NEAR", () => {
  const routes = (balance: unknown): Route[] => [
    { method: "POST", url: RPC, rpc: "get_token_address", status: 200, body: v("mainnet wrap.near -> Base") },
    { method: "POST", url: RPC, rpc: "storage_balance_of", status: 200, body: rpcView(balance) },
    { method: "POST", url: RPC, rpc: "required_balance_for_account", status: 200, body: v("required_balance_for_account") },
    { method: "POST", url: RPC, rpc: "required_balance_for_init_transfer", status: 200, body: v("required_balance_for_init_transfer") },
    { method: "GET", url: `${API}/api/v3/transfer-fee`, status: 200, body: feeWnear },
  ];

  it("builds storage_deposit then ft_transfer_call with the InitTransferMsg, paying the fee in NEAR", async () => {
    const { rpc, api, calls } = setup(routes(null));
    const plan = await planOutbound(rpc, api, { bridge: BRIDGE, token: "wrap.near", signer: "alice.near", chain: "Base", recipient: RECIPIENT, amount: 10n ** 24n });
    expect(plan.refusals).toEqual([]);
    expect(plan.route).toBe("base:0x02eea354d135d1a912967c2d2a6147deb01ef92e");
    const nativeFee = BigInt(feeWnear.native_token_fee);
    expect(plan.storageDeposit).toBe(1_410_000_000_000_000_000_000n + 4_690_000_000_000_000_000_000n + nativeFee);
    expect(plan.txs).toEqual([
      { receiverId: BRIDGE, actions: [{ type: "FunctionCall", params: { methodName: "storage_deposit", args: { account_id: "alice.near" }, gas: "10000000000000", deposit: plan.storageDeposit.toString() } }] },
      {
        receiverId: "wrap.near",
        actions: [
          {
            type: "FunctionCall",
            params: {
              methodName: "ft_transfer_call",
              args: { receiver_id: BRIDGE, amount: "1000000000000000000000000", memo: null, msg: `{"recipient":"base:${RECIPIENT}","fee":"0","native_token_fee":"${nativeFee}","msg":null}` },
              gas: "300000000000000",
              deposit: "1",
            },
          },
        ],
      },
    ]);
    const feeCall = calls.find((c) => c.url.startsWith(API))!;
    expect(new URL(feeCall.url).searchParams.get("token")).toBe("near:wrap.near");
    expect(new URL(feeCall.url).searchParams.get("recipient")).toBe(`base:${RECIPIENT}`);
  });

  it("pays the fee from the token and needs less storage when the signer already has some", async () => {
    const { rpc, api } = setup(routes({ total: "6100000000000000000000", available: "4690000000000000000000" }));
    const plan = await planOutbound(rpc, api, { bridge: BRIDGE, token: "wrap.near", signer: "alice.near", chain: "Base", recipient: RECIPIENT, amount: 10n ** 24n, payFeeIn: "token" });
    expect(plan.fee).toBe(BigInt(feeWnear.transferred_token_fee));
    expect(plan.nativeFee).toBe(0n);
    expect(plan.storageDeposit).toBe(0n);
    expect(plan.txs.map((t) => t.actions[0]!.params.methodName)).toEqual(["ft_transfer_call"]);
  });
});

describe("builders and the read-only API", () => {
  it("formats OmniAddress and refuses bad input", () => {
    expect(omniAddress("Base", RECIPIENT)).toBe(`base:${RECIPIENT}`);
    expect(omniAddress("HlEvm", RECIPIENT)).toBe(`hlevm:${RECIPIENT}`);
    expect(() => omniAddress("Eth", "0x123")).toThrow();
    expect(() => initTransferTx({ token: "wrap.near", bridge: BRIDGE, amount: 5n, recipient: `base:${RECIPIENT}`, fee: 5n, nativeFee: 0n })).toThrow(/below amount/);
    expect(() => initTransferTx({ token: "wrap.near", bridge: BRIDGE, amount: 5n, recipient: "near:alice.near", fee: 0n, nativeFee: 0n })).toThrow(/another chain/);
  });

  it("reads a transfer and its status, by origin nonce", async () => {
    const { api, calls } = setup([
      { method: "GET", url: `${API}/api/v4/transfers/transfer/status?`, status: 200, body: status },
      { method: "GET", url: `${API}/api/v4/transfers/transfer?`, status: 200, body: transfer },
    ]);
    expect(await api.transferStatus({ originChain: "Near", originNonce: 57628 })).toEqual(["Settled"]);
    const t = (await api.transfer({ originChain: "Near", originNonce: 57628 })) as Array<{ status: string }>;
    expect(t[0]!.status).toBe("Settled");
    expect(calls.map((c) => c.method)).toEqual(["GET", "GET"]);
    expect(calls[0]!.url).toBe(`${API}/api/v4/transfers/transfer/status?origin_chain=Near&origin_nonce=57628`);
  });
});
