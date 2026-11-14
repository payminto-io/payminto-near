/**
 * Demo mode's browser wallet on EVM chains (EIP-1193), so the "Receive as" flow can be walked without an extension: it
 * shares one demo address and signs with a deterministic stand-in. Nothing here holds a key or reaches a chain.
 */
import { sha256Text } from "@payminto/protocol";
import type { Eip1193Provider } from "../evm-wallet";

/** An EIP-1193 provider error: a message and its numeric code. */
class ProviderError extends Error {
  constructor(
    message: string,
    readonly code: number,
  ) {
    super(message);
  }
}

export const DEMO_EVM_ADDRESS = `0x${sha256Text("payminto-demo-evm-wallet").slice(0, 40)}`;

export function demoEvmProvider(): Eip1193Provider {
  return {
    async request({ method, params }) {
      if (method === "eth_requestAccounts" || method === "eth_accounts") return [DEMO_EVM_ADDRESS];
      if (method === "personal_sign") {
        const [message, address] = (params ?? []) as [string, string];
        if (String(address).toLowerCase() !== DEMO_EVM_ADDRESS) throw new ProviderError("The demo wallet holds only its own address.", 4100);
        // 65 bytes of stand-in signature: r and s from the message, v = 27.
        return `0x${sha256Text(`r:${message}`)}${sha256Text(`s:${message}`)}1b`;
      }
      throw new ProviderError(`The demo wallet does not answer ${method}.`, 4200);
    },
  };
}
