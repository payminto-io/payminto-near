// Funds the testnet demo wallets from the operator wallet, so a person only has to fill one address from the faucets.
// Usage: pnpm --filter @payminto/demo fund:testnet <133|11155111> [--gateway] [--yes]
// Reads keys from .env.testnet.local (git-ignored). Without --yes it prints the plan and sends nothing.
// HashKey Chain Testnet: gas in HSK, plus Payminto Test USDC minted from its open faucet.
// Ethereum Sepolia: gas in ETH, plus Circle test USDC moved from the operator (fill it at faucet.circle.com).
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createPublicClient, createWalletClient, erc20Abi, formatEther, formatUnits, http, parseEther, parseUnits, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { networks } from "@payminto/protocol";
import { LIVE_GATEWAY_AMOUNTS } from "../src/config.ts";

const TESTNETS = [133, 11155111] as const;
const chainId = Number(process.argv[2]);
const send = process.argv.includes("--yes");
if (!(TESTNETS as readonly number[]).includes(chainId)) {
  console.error(`Usage: pnpm --filter @payminto/demo fund:testnet <${TESTNETS.join("|")}> [--yes]  (testnets only)`);
  process.exit(2);
}

const REPO_ROOT = resolve(import.meta.dirname, "..", "..", "..");
const envFile = resolve(REPO_ROOT, ".env.testnet.local");
const env = Object.fromEntries(
  readFileSync(envFile, "utf8")
    .split("\n")
    .filter((l) => /^[A-Z0-9_]+=/.test(l))
    .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1).trim()]),
);
const need = (k: string) => env[k] || (console.error(`${k} is missing from .env.testnet.local`), process.exit(2));

const net = networks[chainId]!;
const deploymentFile = resolve(REPO_ROOT, "contracts", "deployments", `${chainId}.json`);
// HashKey Chain Testnet's token is the one Deploy.s.sol deployed; Sepolia uses Circle's USDC from chains.ts.
const deployment = (existsSync(deploymentFile) ? JSON.parse(readFileSync(deploymentFile, "utf8")) : {}) as { token?: Address };
if (chainId === 133 && !deployment.token) throw new Error(`${deploymentFile} has no token: deploy first (contracts/script/Deploy.s.sol)`);
const token = (deployment.token ?? net.token.address) as Address;
const operator = privateKeyToAccount(need("OPERATOR_KEY") as Hex);
const pub = createPublicClient({ chain: net.chain, transport: http(net.chain.rpcUrls.default.http[0]) });
const wallet = createWalletClient({ chain: net.chain, transport: http(net.chain.rpcUrls.default.http[0]), account: operator });

// Agents that send their own approve() need gas; the writer only signs a permit, the owner only signs mandates.
const gas = chainId === 133 ? parseEther("0.005") : parseEther("0.002");
const usdc = parseUnits(chainId === 133 ? "5" : "1", 6);
const plan: { who: string; to: Address; gas: bigint; usdc: bigint }[] = [
  { who: "buyer agent (treasury)", to: need("BUYER_AGENT_ADDRESS") as Address, gas, usdc },
  { who: "trading agent", to: need("TRADING_AGENT_ADDRESS") as Address, gas, usdc },
  { who: "seller agent (writer)", to: need("SELLER_AGENT_ADDRESS") as Address, gas: 0n, usdc },
];
// The gateway act (DEMO_GATEWAY=1): payers hold a little over what the act checks for; only the person paying by
// plain transfer sends a transaction. The store, Northwind's payout and the platform fee wallet only receive or sign.
if (process.argv.includes("--gateway")) {
  const payer = LIVE_GATEWAY_AMOUNTS.payerFunds + LIVE_GATEWAY_AMOUNTS.payerFunds / 2n;
  plan.push(
    { who: "gateway: person paying by wallet signature", to: need("HUMAN_PAYER_ADDRESS") as Address, gas: 0n, usdc: payer },
    { who: "gateway: person paying by transfer", to: need("DEPOSIT_PAYER_ADDRESS") as Address, gas: gas / 2n, usdc: payer },
    { who: "gateway: x402 agent", to: need("X402_AGENT_ADDRESS") as Address, gas: 0n, usdc: payer },
    { who: "gateway: MCP mandate agent", to: need("MANDATE_AGENT_ADDRESS") as Address, gas: 0n, usdc: payer },
    { who: "gateway: flagged wallet (refused by screening)", to: need("FLAGGED_ADDRESS") as Address, gas: 0n, usdc: payer },
  );
}

const [opGas, opUsdc] = await Promise.all([
  pub.getBalance({ address: operator.address }),
  pub.readContract({ address: token, abi: erc20Abi, functionName: "balanceOf", args: [operator.address] }),
]);
const sym = chainId === 133 ? "tUSDC" : "USDC";
const native = net.chain.nativeCurrency.symbol;

// What each wallet is short of its share, so a rerun sends only what is missing.
const shortfalls = await Promise.all(
  plan.map(async (p) => {
    const [hasGas, hasUsdc] = await Promise.all([
      pub.getBalance({ address: p.to }),
      pub.readContract({ address: token, abi: erc20Abi, functionName: "balanceOf", args: [p.to] }),
    ]);
    return { ...p, gas: p.gas > hasGas ? p.gas - hasGas : 0n, usdc: p.usdc > hasUsdc ? p.usdc - hasUsdc : 0n };
  }),
);
// Every transaction's own fee counts too: a USDC transfer measured about 152k gas on Sepolia and an ETH transfer to a
// fresh account about 205k, so budget 250k gas per transaction at the current max fee.
const GAS_PER_TX = 250_000n;
const { maxFeePerGas } = await pub.estimateFeesPerGas();
const txCount = BigInt(shortfalls.reduce((n, p) => n + (p.gas > 0n ? 1 : 0) + (p.usdc > 0n ? 1 : 0), 0));
const fees = txCount * GAS_PER_TX * maxFeePerGas;

console.log(`${net.chain.name} (${chainId}), token ${token}`);
console.log(`operator ${operator.address}: ${formatEther(opGas)} ${native}, ${formatUnits(opUsdc, 6)} ${sym}`);
for (const p of shortfalls) {
  const what = p.gas === 0n && p.usdc === 0n ? "already funded" : `${formatEther(p.gas)} ${native}, ${formatUnits(p.usdc, 6)} ${sym}${chainId === 133 ? " (minted)" : ""}`;
  console.log(`  -> ${p.who} ${p.to}: ${what}`);
}
console.log(`  ${txCount} transactions, fees up to ${formatEther(fees)} ${native}`);

const gasTotal = shortfalls.reduce((s, p) => s + p.gas, 0n) + fees;
const usdcTotal = shortfalls.reduce((s, p) => s + p.usdc, 0n);
const short: string[] = [];
if (opGas < gasTotal) short.push(`needs ${formatEther(gasTotal)} ${native} for the gas transfers and every transaction's fee${chainId === 133 ? ": claim at https://faucet.hsk.xyz" : ""}`);
if (chainId === 11155111 && opUsdc < usdcTotal) short.push(`holds ${formatUnits(opUsdc, 6)} USDC and needs ${formatUnits(usdcTotal, 6)}: claim at https://faucet.circle.com (Ethereum Sepolia)`);
if (short.length) {
  console.error(`Not funded yet. The operator ${operator.address} ${short.join("; and ")}.`);
  process.exit(1);
}
if (txCount === 0n) {
  console.log("Nothing to send: every wallet holds its share.");
  process.exit(0);
}
if (!send) {
  console.log("Dry run. Add --yes to send.");
  process.exit(0);
}

const testnetFaucetAbi = [{ type: "function", name: "mint", stateMutability: "nonpayable", inputs: [{ name: "to", type: "address" }, { name: "amount", type: "uint256" }], outputs: [] }] as const;
// One transaction at a time, each confirmed before the next: public RPCs are load-balanced and can hand out a stale
// nonce otherwise.
let nonce = await pub.getTransactionCount({ address: operator.address, blockTag: "pending" });
const confirm = async (who: string, hash: Hex) => {
  const r = await pub.waitForTransactionReceipt({ hash });
  if (r.status !== "success") throw new Error(`${hash} reverted`);
  console.log(`  ${who}: ${net.explorer}/tx/${hash}`);
};
for (const p of shortfalls) {
  if (p.gas > 0n) await confirm(p.who, await wallet.sendTransaction({ to: p.to, value: p.gas, nonce: nonce++ }));
  if (p.usdc > 0n) {
    const hash =
      chainId === 133
        ? await wallet.writeContract({ address: token, abi: testnetFaucetAbi, functionName: "mint", args: [p.to, p.usdc], nonce: nonce++ })
        : await wallet.writeContract({ address: token, abi: erc20Abi, functionName: "transfer", args: [p.to, p.usdc], nonce: nonce++ });
    await confirm(p.who, hash);
  }
}
console.log("Funded.");
