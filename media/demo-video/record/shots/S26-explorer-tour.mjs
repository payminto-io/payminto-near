// S26: the on-chain tour. Needs no running stack, only the public explorers.
// Timed to the S26 voice line (audio/audio_meta.json frame 26); the clip has a
// 2 s handle at each end, and the cut starts at media time 2.0.
// Blockscout shows our contracts as unverified, so contract pages are short and stay on the Details view.
// Sepolia uses eth-sepolia.blockscout.com: sepolia.etherscan.io serves a bot check to headless
// browsers, which this harness does not try to get past.
export const needs = [];
export const needsLogin = false;
const short = (h) => h.slice(0, 10) + "..." + h.slice(-6);

export function segments(cfg) {
  const e = cfg.explorer, hk = e.hashkey, sp = e.sepolia, c = e.contracts, tx = e.hashkeyTx, stx = e.sepoliaTx;
  const hide = ["Launch your own", "Sponsored"];
  const page = (url, ms, label, ready, extra = {}) => ({
    name: label.text, url, label, ms, scale: 1.25, hideText: hide, ready: { text: ready }, ...extra,
    act: extra.act || (async (h) => { await h.moveTo({ x: 1420, y: 720 + (ms % 7) * 12 }, Math.min(500, ms * 0.5)); await h.wait(Math.max(0, ms - Math.min(500, ms * 0.5))); }),
  });
  return [
    page(`${hk}/address/${c.ClearingHub}`, 5450, { text: "ClearingHub, HashKey Chain Testnet", sub: short(c.ClearingHub) }, "Contract details", {
      act: async (h) => { await h.wait(1800); await h.moveTo("h1", 700); await h.highlight("h1", 1400); await h.wait(1500); },
    }),
    page(`${hk}/address/${c.DepositFactory}`, 1200, { text: "DepositFactory", sub: short(c.DepositFactory) }, "Contract details"),
    page(`${hk}/address/${c.PaymentRouter}`, 2450, { text: "PaymentRouter", sub: short(c.PaymentRouter) }, "Contract details"),
    page(`${hk}/tx/${tx.mandateOpen}`, 800, { text: "Mandate opened", sub: short(tx.mandateOpen) }, "Transaction details"),
    page(`${hk}/tx/${tx.walletPayment}`, 700, { text: "Wallet payment", sub: short(tx.walletPayment) }, "Transaction details"),
    page(`${hk}/tx/${tx.x402}`, 700, { text: "x402 agent payment", sub: short(tx.x402) }, "Transaction details"),
    page(`${hk}/tx/${tx.gaslessRefund}`, 600, { text: "Gasless refund", sub: short(tx.gaslessRefund) }, "Transaction details"),
    page(`${hk}/tx/${tx.clearingSettle}`, 600, { text: "Clearing settlement", sub: short(tx.clearingSettle) }, "Transaction details"),
    page(`${hk}/tx/${tx.aiSkillSettlement}`, 600, { text: "AI skill settlement", sub: short(tx.aiSkillSettlement) }, "Transaction details"),
    page(`${sp}/tx/${stx.settle}`, 3000, { text: "Settlement, Ethereum Sepolia, Circle USDC", sub: short(stx.settle) }, "Tokens transferred", {
      act: async (h) => { await h.wait(400); await h.scrollBy(380, 900); await h.moveTo("text=Tokens transferred", 500); await h.highlight("text=Tokens transferred", 1100, 10); },
    }),
    page(`${sp}/tx/${stx.aiSkillSettlement}`, 4200, { text: "AI skill settlement, Ethereum Sepolia", sub: short(stx.aiSkillSettlement) }, "Tokens transferred", {
      act: async (h) => { await h.wait(500); await h.scrollBy(380, 900); await h.moveTo("text=Tokens transferred", 600); await h.wait(2200); },
    }),
  ];
}
