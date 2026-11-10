"use client";

import { useEffect, useSyncExternalStore } from "react";
import { connectWallet, disconnectWallet, restoreWallet, subscribeWallet, walletState, type WalletState } from "./wallet";

const SERVER_STATE: WalletState = { status: "idle", account: null };

/** The connected NEAR account and the actions that change it. Restores an earlier connection once, without a prompt. */
export function useWallet() {
  const state = useSyncExternalStore(subscribeWallet, walletState, () => SERVER_STATE);
  useEffect(() => {
    if (walletState().status === "idle") void restoreWallet();
  }, []);
  return { ...state, connect: connectWallet, disconnect: disconnectWallet };
}
