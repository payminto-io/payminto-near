"use client";

import { useState, type ReactNode } from "react";
import { toast } from "sonner";
import { CheckCircle2, CircleHelp, ExternalLink, Loader2, Wallet } from "lucide-react";
import { hashkeyContracts, hashkeyLinks, hashkeyNetworkFacts, networks, type HashKeyContracts } from "@payminto/protocol";
import { chainIdOf, useInfo } from "@/lib/queries";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Address, CopyButton, PageHeader, Panel } from "@/components/app/primitives";
import { Chip } from "@/components/app/status";
import { CodeBlock, Segmented } from "@/components/gateway/kit";

type Net = 177 | 133;

const DEV_ONEPAGER = "https://hashfans.io/dev-onepager";

/** Links PRODUCT.md section 8 marks "check": shown, but flagged until someone confirms them against the HashKey docs. */
const UNCHECKED = new Set(["https://docs.hsk.xyz", "https://bridge.hsk.xyz"]);

const PROVIDERS: Record<Net, string> = { 177: "GetBlock, Chainstack, dRPC, thirdweb", 133: "dRPC, thirdweb" };

type NetworkView = {
  id: Net;
  name: string;
  rpc: string;
  fallbacks: string[];
  explorer: string;
  verifyApi: string;
  faucet: string | null;
  bridge: string | null;
  docs: string | null;
  token: { symbol: string; address: string };
  usdt: string | null;
};

function baseView(id: Net): NetworkView {
  const n = networks[id]!;
  const links = hashkeyLinks[id]!;
  return {
    id,
    name: n.chain.name,
    rpc: n.chain.rpcUrls.default.http[0]!,
    fallbacks: [...hashkeyNetworkFacts[id].fallbackRpcUrls],
    explorer: n.explorer,
    verifyApi: `${n.explorer}/api/`,
    faucet: links.faucet,
    bridge: links.bridge,
    docs: links.docs,
    token: { symbol: n.token.symbol, address: n.token.address },
    usdt: hashkeyContracts[id].usdt ?? null,
  };
}

const str = (v: unknown) => (typeof v === "string" && v ? v : null);

/** What /v1/info says about the network this server runs on wins over the built-in list (one source of links). */
function withInfo(v: NetworkView, network: Record<string, unknown> | undefined): NetworkView {
  if (!network) return v;
  const fallbacks = Array.isArray(network.fallback_rpc_urls) ? network.fallback_rpc_urls.filter((x): x is string => typeof x === "string") : null;
  return {
    ...v,
    rpc: str(network.rpc_url) ?? v.rpc,
    fallbacks: fallbacks?.length ? fallbacks : v.fallbacks,
    faucet: network.faucet === null ? null : str(network.faucet) ?? v.faucet,
    bridge: network.bridge === null ? null : str(network.bridge) ?? v.bridge,
    docs: str(network.docs) ?? v.docs,
  };
}

function Unchecked() {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span tabIndex={0} className="inline-flex items-center gap-1 rounded bg-warning-soft px-1.5 text-[0.6875rem] font-medium text-warning">
          <CircleHelp className="size-3" aria-hidden /> Not yet checked
        </span>
      </TooltipTrigger>
      <TooltipContent className="max-w-64">This link comes from public listings and has not been confirmed against the HashKey docs yet. Check it before you rely on it.</TooltipContent>
    </Tooltip>
  );
}

function UrlCell({ url }: { url: string | null }) {
  if (!url) return <span className="text-subtle">-</span>;
  return (
    <span className="flex min-w-0 flex-wrap items-center gap-1.5">
      <a href={url} target="_blank" rel="noreferrer" className="hash min-w-0 truncate text-primary hover:underline">
        {url.replace(/^https?:\/\//, "")}
      </a>
      <CopyButton value={url} label="link" />
      {UNCHECKED.has(url.replace(/\/+$/, "")) && <Unchecked />}
    </span>
  );
}

function Row({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <tr className="align-top transition-colors duration-150 ease-out hover:bg-muted/40">
      <th scope="row" className="w-44 py-2.5 pr-4 pl-4 text-left font-normal text-muted-foreground sm:pl-5">
        {label}
        {hint && <span className="block text-xs text-subtle">{hint}</span>}
      </th>
      <td className="min-w-0 py-2.5 pr-4 sm:pr-5">{children}</td>
    </tr>
  );
}

/** EIP-3085: asks the browser wallet to add (or switch to) HashKey Chain. */
async function addToWallet(v: NetworkView): Promise<"added" | "no_wallet" | "declined"> {
  const eth = (window as unknown as { ethereum?: { request: (a: { method: string; params?: unknown[] }) => Promise<unknown> } }).ethereum;
  if (!eth) return "no_wallet";
  const n = networks[v.id]!;
  try {
    await eth.request({
      method: "wallet_addEthereumChain",
      params: [
        {
          chainId: `0x${v.id.toString(16)}`,
          chainName: v.name,
          nativeCurrency: n.chain.nativeCurrency,
          rpcUrls: [v.rpc, ...v.fallbacks],
          blockExplorerUrls: [v.explorer],
        },
      ],
    });
    return "added";
  } catch {
    return "declined";
  }
}

function AddButton({ v }: { v: NetworkView }) {
  const [busy, setBusy] = useState(false);
  return (
    <Button
      variant="outline"
      disabled={busy}
      onClick={async () => {
        setBusy(true);
        const r = await addToWallet(v);
        setBusy(false);
        if (r === "added") toast.success(`${v.name} is in your wallet.`);
        else if (r === "no_wallet") toast.error("No browser wallet found. Install one such as MetaMask or Rabby, then try again.");
        else toast.error("The wallet did not add the network.");
      }}
    >
      {busy ? <Loader2 className="animate-spin" /> : <Wallet />} Add {v.id === 177 ? "mainnet" : "testnet"} to wallet
    </Button>
  );
}

function contractRows(c: HashKeyContracts): [string, string, string][] {
  return [
    ["Multicall3", "Batched reads", c.multicall3],
    ["Permit2", "Signature approvals for tokens without permit", c.permit2],
    ["Safe 1.4.1 factory", "Smart accounts that can own a budget", c.safe.proxyFactory],
    ["Safe 1.4.1 singleton (L2)", "Safe implementation", c.safe.singletonL2],
    ["EAS", "Public records (attestations), OP Stack predeploy", c.eas],
    ["EAS schema registry", "OP Stack predeploy", c.schemaRegistry],
    ["EntryPoint v0.6", "Account abstraction", c.entryPointV06],
    ["EntryPoint v0.7", "Account abstraction", c.entryPointV07],
    ["CREATE2 deployer", "Same address on every chain", c.create2Deployer],
  ];
}

function viemSnippet(v: NetworkView): string {
  return `import { defineChain } from "viem";

export const hashkey${v.id === 177 ? "" : "Testnet"} = defineChain({
  id: ${v.id},
  name: "${v.name}",
  nativeCurrency: { name: "HashKey Platform Token", symbol: "HSK", decimals: 18 },
  rpcUrls: { default: { http: ["${v.rpc}"] } },
  blockExplorers: { default: { name: "Blockscout", url: "${v.explorer}" } },${v.id === 133 ? "\n  testnet: true," : ""}
});`;
}

function foundrySnippet(v: NetworkView): string {
  return `# Deploy and verify on ${v.name}
forge create src/MyContract.sol:MyContract \\
  --rpc-url ${v.rpc} \\
  --private-key $PRIVATE_KEY \\
  --verify --verifier blockscout \\
  --verifier-url ${v.verifyApi}

# Verify an existing deployment
forge verify-contract <address> src/MyContract.sol:MyContract \\
  --chain-id ${v.id} --verifier blockscout --verifier-url ${v.verifyApi}`;
}

export default function HashKeyPage() {
  const info = useInfo();
  const serverChain = chainIdOf(info.data);
  const onHashKey = serverChain === 177 || serverChain === 133;
  const [net, setNet] = useState<Net | null>(null);
  const shown: Net = net ?? (onHashKey ? (serverChain as Net) : 133);
  const network = info.data?.network as Record<string, unknown> | undefined;
  const views: Record<Net, NetworkView> = {
    177: serverChain === 177 ? withInfo(baseView(177), network) : baseView(177),
    133: serverChain === 133 ? withInfo(baseView(133), network) : baseView(133),
  };
  const v = views[shown];
  const facts = hashkeyNetworkFacts[shown];
  const c = hashkeyContracts[shown];
  const [snippet, setSnippet] = useState<"viem" | "foundry">("viem");
  const code = snippet === "viem" ? viemSnippet(v) : foundrySnippet(v);
  const finalSeconds = facts.safeLagBlocks * facts.blockTimeSeconds;

  return (
    <>
      <PageHeader
        title="HashKey Chain"
        description="The network Payminto settles on: where to connect, where to look things up, and the contracts already deployed there."
        actions={
          <Segmented
            label="Network"
            value={String(shown) as "177" | "133"}
            onChange={(k) => setNet(Number(k) as Net)}
            options={[
              { key: "177", label: "Mainnet" },
              { key: "133", label: "Testnet" },
            ]}
          />
        }
      />

      <section className={cn("mb-5 flex flex-wrap items-center gap-3 rounded-xl border p-4 sm:p-5", shown === serverChain ? "border-primary/40 bg-info-soft" : "bg-card")}>
        <div className="min-w-0 flex-1">
          <p className="flex flex-wrap items-center gap-2 font-medium">
            {v.name}
            <span className="hash text-sm font-normal text-muted-foreground">chain id {v.id}</span>
            {shown === 133 ? <Chip tone="warning">Testnet: no real money</Chip> : <Chip tone="positive">Mainnet</Chip>}
            {shown === serverChain && <Chip tone="info">This server runs here</Chip>}
          </p>
          <p className="mt-1 text-sm text-muted-foreground">
            {!onHashKey && info.data
              ? `This server runs on a local test chain (id ${serverChain}). The facts below are for HashKey Chain itself.`
              : `HSK pays network fees, blocks come every ${facts.blockTimeSeconds} seconds, and Payminto treats a payment as Final after the safe head, about ${finalSeconds < 60 ? `${finalSeconds} seconds` : `${Math.round(finalSeconds / 60)} minutes`}.`}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <AddButton v={views[177]} />
          <AddButton v={views[133]} />
        </div>
      </section>

      <div className="grid items-start gap-5 xl:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)]">
        <div className="flex min-w-0 flex-col gap-5">
          <Panel title="Connect and look up" bodyClassName="p-0 sm:p-0">
            <table className="w-full table-fixed text-sm">
              <tbody className="divide-y">
                <Row label="RPC" hint={shown === serverChain ? "From this server" : undefined}>
                  <UrlCell url={v.rpc} />
                </Row>
                <Row label="Fallback RPCs">
                  <span className="flex flex-col gap-1">
                    {v.fallbacks.map((u) => (
                      <UrlCell key={u} url={u} />
                    ))}
                  </span>
                </Row>
                <Row label="Hosted RPC providers">{PROVIDERS[shown]}</Row>
                <Row label="Explorer">
                  <UrlCell url={v.explorer} />
                </Row>
                <Row label="Contract verification" hint="Blockscout API; Sourcify also works">
                  <UrlCell url={v.verifyApi} />
                </Row>
                <Row label="Faucet">{v.faucet ? <UrlCell url={v.faucet} /> : <span className="text-muted-foreground">Mainnet has no faucet</span>}</Row>
                <Row label="Bridge">{v.bridge ? <UrlCell url={v.bridge} /> : <span className="text-muted-foreground">None listed for {shown === 133 ? "testnet" : "mainnet"}</span>}</Row>
                <Row label="Official docs">
                  <UrlCell url={v.docs} />
                </Row>
                <Row label="Developer one-pager">
                  <span className="flex items-center gap-1.5">
                    <a href={DEV_ONEPAGER} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-primary hover:underline">
                      hashfans.io/dev-onepager <ExternalLink className="size-3" aria-hidden />
                    </a>
                  </span>
                </Row>
              </tbody>
            </table>
          </Panel>

          <Panel title="Tokens" bodyClassName="p-0 sm:p-0">
            <table className="w-full table-fixed text-sm">
              <tbody className="divide-y">
                <Row label="Native token" hint="Pays network fees">
                  HSK, 18 decimals
                </Row>
                <Row label={v.token.symbol} hint={shown === 177 ? "Bridged USDC, used for payments" : "Test USDC, used for payments"}>
                  <Address address={v.token.address} showName={false} explorer={false} />
                </Row>
                {v.usdt && (
                  <Row label="USDT">
                    <Address address={v.usdt} showName={false} explorer={false} />
                  </Row>
                )}
              </tbody>
            </table>
          </Panel>

          <Panel title="Shared contracts" description={`Already deployed on ${v.name}; checked live against the chain.`} bodyClassName="p-0 sm:p-0">
            <table className="w-full table-fixed text-sm">
              <tbody className="divide-y">
                {contractRows(c).map(([name, hint, address]) => (
                  <Row key={name} label={name} hint={hint}>
                    <span className="flex items-center gap-1.5">
                      <Address address={address} showName={false} explorer={false} />
                      <a href={`${v.explorer}/address/${address}`} target="_blank" rel="noreferrer" aria-label={`Open ${name} in the explorer`} className="inline-flex size-6 items-center justify-center rounded text-subtle transition-colors hover:bg-muted hover:text-foreground">
                        <ExternalLink className="size-3.5" />
                      </a>
                    </span>
                  </Row>
                ))}
              </tbody>
            </table>
          </Panel>
        </div>

        <div className="flex min-w-0 flex-col gap-5">
          {info.data && (
            <Panel title="This server" description="The addresses this Payminto server uses.">
              <dl className="grid gap-3 text-sm">
                <div>
                  <dt className="text-muted-foreground">Network</dt>
                  <dd>
                    {info.data.network.name} <span className="hash text-muted-foreground">({serverChain})</span>
                  </dd>
                </div>
                <div>
                  <dt className="text-muted-foreground">Settlement contract</dt>
                  <dd>
                    <Address address={info.data.hub} showName={false} />
                  </dd>
                </div>
                <div>
                  <dt className="text-muted-foreground">Payment token ({info.data.token.symbol})</dt>
                  <dd>
                    <Address address={info.data.token.address} showName={false} />
                  </dd>
                </div>
                <div>
                  <dt className="text-muted-foreground">Server wallet</dt>
                  <dd>
                    <Address address={info.data.operator} showName={false} />
                    <span className="block text-xs text-muted-foreground">Submits settlements and pays the network fee. It never holds anyone&apos;s money.</span>
                  </dd>
                </div>
              </dl>
            </Panel>
          )}

          <Panel title="Get test HSK and USDC" description="For trying Payminto on testnet with no real money.">
            <ol className="stagger flex flex-col gap-3 text-sm">
              {[
                <>Add HashKey Chain Testnet to your wallet with the button above.</>,
                <>
                  Open the{" "}
                  <a href={hashkeyLinks[133]!.faucet ?? "#"} target="_blank" rel="noreferrer" className="text-primary hover:underline">
                    testnet faucet
                  </a>{" "}
                  and request HSK for network fees.
                </>,
                <>
                  Get test USDC (<span className="hash text-xs">{networks[133]!.token.address.slice(0, 10)}...</span>) from the faucet or from whoever runs your test setup.
                </>,
                <>Pay one of your own payment links from that wallet, then check the payment on the explorer.</>,
              ].map((step, i) => (
                <li key={i} className="flex gap-3">
                  <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-accent text-xs font-semibold text-accent-foreground">{i + 1}</span>
                  <span className="pt-0.5">{step}</span>
                </li>
              ))}
            </ol>
            <p className="mt-4 flex items-center gap-1.5 text-xs text-muted-foreground">
              <CheckCircle2 className="size-3.5 text-positive" aria-hidden /> Testnet money has no value; nothing here touches mainnet.
            </p>
          </Panel>

          <Panel
            title="Code"
            description={`Snippets for ${v.name}`}
            actions={
              <Segmented
                label="Snippet"
                value={snippet}
                onChange={setSnippet}
                options={[
                  { key: "viem", label: "viem" },
                  { key: "foundry", label: "Foundry" },
                ]}
              />
            }
          >
            <CodeBlock code={code} label={snippet === "viem" ? "viem chain definition" : "Foundry commands"} copy={<CopyButton value={code} label="snippet" />} />
          </Panel>
        </div>
      </div>
    </>
  );
}
