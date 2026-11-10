import { RelayerClient, setRelayer } from "../relayer";
import { setWalletDriver } from "../wallet";
import { applyMockCheckoutTx } from "./gateway";
import { DEMO_RELAYER_URL, mockRelayerFetch } from "./relayer";
import { applyMockDaoTx, applyMockWalletTx, demoKeys, demoSource, mockRelayerDeps } from "./server";
import { MockWalletDriver } from "./wallet";

let wallet: MockWalletDriver | null = null;

/**
 * Mock mode only: routes every wallet action to the demo wallet and every relay to the demo relayer, once per tab.
 * Checkout payments first, then DAO proposals and votes, then owner actions on the hub.
 */
export function installMockWallet(): void {
  if (wallet) return;
  wallet = new MockWalletDriver([applyMockCheckoutTx, applyMockDaoTx, applyMockWalletTx], { keys: demoKeys, rpcFetch: () => demoSource().fetch! });
  setWalletDriver(wallet);
  setRelayer(new RelayerClient(DEMO_RELAYER_URL, { demo: true, fetch: mockRelayerFetch(mockRelayerDeps) }));
}

/** The demo wallet, so a demo-only control can switch which account it acts as. Null outside mock mode. */
export function demoWallet(): MockWalletDriver | null {
  return wallet;
}
