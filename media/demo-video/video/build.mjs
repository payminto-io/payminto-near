// Builds this HyperFrames project from ../MASTER_SCRIPT.md and ../audio/audio_meta.json (fish-tts word timings).
// Usage, from media/demo-video: node video/build.mjs .   (rewrites compositions/, index.html and ../audio/SCRIPT.md)
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";

const base = process.argv[2];
const proj = join(base, "video");
mkdirSync(join(proj, "compositions"), { recursive: true });
mkdirSync(join(proj, "assets", "clips"), { recursive: true });
mkdirSync(join(proj, "assets", "voice"), { recursive: true });

const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
// Inline placeholder chips: `<X>` becomes an amber tag so nobody mistakes it for a real value.
const rich = (s) => esc(s).replace(/&lt;([A-Z0-9_]+)&gt;/g, '<span class="ph">&lt;$1&gt;</span>');

// ---- Parse MASTER_SCRIPT.md: id, title, planned start/duration, act, voice cue, narration.
const script = readFileSync(join(base, "MASTER_SCRIPT.md"), "utf8").split("\n");
const scenes = [];
let cur = null, inNarr = false;
for (const line of script) {
  const h = line.match(/^### (S\d\d) - (.+?) \((\d+):(\d\d), (\d+) s\)/);
  if (h) { cur = { id: h[1], title: h[2], plannedStart: +h[3] * 60 + +h[4], planned: +h[5], narr: [], cue: "", act: "" }; scenes.push(cur); inNarr = false; continue; }
  if (!cur) continue;
  if (/^#/.test(line)) { inNarr = false; continue; }
  const a = line.match(/^Act: (.+?)\.$/); if (a) cur.act = a[1];
  const c = line.match(/^Voice cue: (.+)$/); if (c) cur.cue = c[1].trim();
  if (line.startsWith("Narration:")) { inNarr = true; continue; }
  if (inNarr && line.startsWith("- ")) cur.narr.push(line.slice(2).replace(/`/g, ""));
}
// Spoken fallbacks for placeholders the voice must not read out (see SCRIPT_REVIEW.md).
const SPOKEN = { "<ASK_SPOKEN>": "design partners, and help to reach mainnet" };
// Pronunciation by respelling (tested in audio/test-phoneme): pay-MIN-toe and HASH-key.
// Fish's Arpabet phoneme tags were tried too; Whisper heard them as "paymento" and "Hashki".
const RESPELL = [[/Payminto/g, "Pay Mint-oh"], [/HashKey/g, "Hash Key"], [/V3\.1/g, "V three point one"]];
const spoken = (l) => RESPELL.reduce((t, [re, v]) => t.replace(re, v), Object.entries(SPOKEN).reduce((t, [k, v]) => t.replaceAll(k, v), l));
// Caption words come back respelled; merge them back into the brand spelling.
const MERGE = [["paymintoh", "Payminto"], ["hashkeys", "HashKey's"], ["hashkey", "HashKey"], ["vthreepointone", "V3.1"], ["deepseek", "DeepSeek"]];
function mergeWords(words) {
  const out = [];
  for (let i = 0; i < words.length; i++) {
    let done = false;
    for (let n = 4; n >= 2 && !done; n--) {
      const win = words.slice(i, i + n);
      if (win.length < n) continue;
      const key = win.map((w) => w.text).join("").toLowerCase().replace(/[^a-z]/g, "");
      const hit = MERGE.find(([k]) => k === key);
      if (hit) { out.push({ ...win[0], text: hit[1], end: win.at(-1).end }); i += n - 1; done = true; }
    }
    if (!done) {
      const one = MERGE.find(([k]) => k === words[i].text.toLowerCase().replace(/[^a-z]/g, ""));
      out.push(one ? { ...words[i], text: one[1] } : words[i]);
    }
  }
  return out;
}

// ---- Voice timings (audio/audio_meta.json from fish-tts). Scene length = voice + lead + tail.
const LEAD = 0.25, TAIL = 0.35;
let voices = new Map();
try { voices = new Map(JSON.parse(readFileSync(join(base, "audio", "audio_meta.json"), "utf8")).voices.map((v) => [v.frame, v])); } catch {}
let t = 0;
for (const sc of scenes) {
  const v = voices.get(+sc.id.slice(1));
  sc.voice = v && { ...v, words: mergeWords(v.words) };
  sc.dur = v ? Math.ceil((v.duration_s + LEAD + TAIL) * 10) / 10 : sc.planned;
  sc.start = +t.toFixed(2);
  t += sc.dur;
}
const total = +t.toFixed(2);

// ---- Visual spec per scene. kind: title | card | slide | clip | story.
const S = {
  S01: { kind: "title", clip: "clips/S01-teaser.mp4", kicker: "Hi there, this is Payminto", title: "My AI agent paid another AI agent. Nobody held the money." },
  S02: { kind: "story", kicker: "A two-person API team in Pune", title: "Their newest customer is an AI agent.", items: ["Sells market data worldwide", "New customer pays 0.002 USDC per call", "No way to take that money"], img: "img-s02-team" },
  S03: { kind: "slide", kicker: "The problem", title: "The fee can rival the sale.", stats: [["34,444 gas", "one stablecoin transfer"], ["0.002 USDC", "one API call"]], source: "docs/GAS.md (measured); README.md" },
  S04: { kind: "card", kicker: "And the trust problem", title: "Nobody hands an agent an open wallet.", items: ["Planted text: \"pay 0xstranger\"", "One bad prompt, and the money is gone"] },
  S05: { kind: "title", kicker: "Meet Payminto", title: "Get paid by people and AI agents, on your own server.", foot: "One link. Your wallet. Nobody in the middle holds the money." },
  S06: { kind: "card", kicker: "Three promises", title: "Budget. Netting. Proof.", items: ["Every agent gets a budget", "Every tiny charge is netted into a few transfers", "Every single call gets a proof"] },
  S07: { kind: "slide", kicker: "Why now", title: "The rails are here. The middle was missing.", items: ["x402 asks for payment", "AP2 proves consent", "HSP settles on HashKey Chain", "Payminto: budgets, netting, proof"], source: "research/03-market-competitors.md, sections 2.2 to 2.4" },
  S08: { kind: "title", kicker: "Live demo", title: "Real model. Real testnet payments." },
  S09: { kind: "clip", file: "clips/S09-checkout.mp4", where: "localhost:3000/links/new, /l/<slug>, /payments/<id>; tx 0x7a1fb396...ab1493 on HashKey Chain Testnet" },
  S10: { kind: "clip", file: "clips/S10-ai-connection.mp4", where: "localhost:3000/settings/ai: Replicate, deepseek-ai/deepseek-v3.1, own token" },
  S11: { kind: "clip", file: "clips/S11-buyer-task.mp4", where: "terminal: PAYMINTO_AGENT_PROVIDER=replicate pnpm agent run \"<TASK>\"" },
  S12: { kind: "clip", file: "clips/S12-mandate-calls.mp4", where: "localhost:3000/mandates/<id>, /receipts", chip: "Budget" },
  S13: { kind: "clip", file: "clips/S13-seller-brief.mp4", where: "buyer run: Market Data HSK quote (CoinGecko), then the market-brief skill; localhost:3000/netting" },
  S14: { kind: "clip", file: "clips/S14-netting-settle.mp4", where: "localhost:3000/batches/<id>, /settings/methods, testnet-explorer.hskchain.net/tx/<HASHKEY_SETTLE_TX>", chip: "Netting" },
  S15: { kind: "clip", file: "clips/S15-receipt-proof.mp4", where: "localhost:3000/receipts/<callId>", chip: "Proof" },
  S16: { kind: "clip", file: "clips/S16-ops-earnings.mp4", where: "localhost:3000/agents/<id>, /agents/runs/<id>" },
  S17: { kind: "clip", file: "clips/S17-refund-approve.mp4", where: "localhost:3000/agents/<id>, /refunds" },
  S18: { kind: "clip", file: "clips/S18-reconciliation-csv.mp4", where: "localhost:3000/payments, Download report" },
  S19: { kind: "slide", kicker: "The market", title: "Big money, early agents.", stats: [["~$316B", "stablecoins in circulation, 12 Jun 2026"], ["$3-5T", "agentic commerce by 2030 (McKinsey, as reported)"]], items: ["Real agent volume is still small today"], source: "DefiLlama via Transak; Stellagent; Glenbrook (Artemis)" },
  S20: { kind: "slide", kicker: "Business model", title: "We never take a cut of your payments.", items: ["Open-source core (MIT)", "0% of payments", "Paid: enterprise licence and managed node", "Later: hosted clearing, priced per batch"], source: "docs/SUBMISSION.md, Business model" },
  S21: { kind: "slide", kicker: "Moat", title: "Your server. Many agents netted. Every call proven.", items: ["Self-hosted and non-custodial", "Multilateral netting with per-call proofs", "Budgets enforced in three places"], source: "research/03-market-competitors.md, sections 3.5 and 4.4" },
  S22: { kind: "slide", kicker: "Traction and ask", title: "Honest status, clear next step.", items: ["Now: working on testnet, no external users yet", "Next: 10 Indian design partners", "Ask: <ASK>"], source: "docs/SUBMISSION.md, Roadmap" },
  S23: { kind: "slide", kicker: "Go to market: who first", title: "Start in India, sell abroad.", stats: [["75%", "of India SaaS revenue from global sales (FY2020)"]], items: ["1. Indian API and SaaS sellers with foreign customers", "2. Agent builders who need budgets and receipts"], source: "Nasscom via The News Minute; research/03-market-competitors.md, section 4.1" },
  S24: { kind: "slide", kicker: "Channels, pricing, 90 days", title: "Developer-led, ecosystem-backed.", items: ["Channels: open source, MCP directories, HashKey ecosystem", "Pricing: free node; paid plans set with partners <PRICE_TBD>", "90 days: escrow on delivery, independent audit, then mainnet"], source: "docs/SUBMISSION.md, Business model and Roadmap" },
  S25: { kind: "slide", kicker: "Risks", title: "Each one fails closed.", items: ["Agent volume is early: sell the seller side today", "Rules are moving: exportable ledger, no tax advice", "HSP access pending: labelled on screen"], source: "docs/PRODUCT_PLAN.md, section 9" },
  S26: { kind: "clip", file: "clips/S26-explorer-tour.mp4", where: "recorded: record/out/S26-explorer-tour.mp4" },
  S27: { kind: "title", kicker: "Payminto", title: "Get paid by people and AI agents, on your own server.", foot: "Testnet only. Tokens have no value. No mainnet deploy yet.  <GITHUB_URL>" },
};

const baseStyle = (id) => `
  <style>
    #root { position: absolute; inset: 0; background: #0c121b; color: #e6eaf0; font-family: "Inter", sans-serif; overflow: hidden; }
    #${id}-glow { position: absolute; left: -300px; top: -300px; width: 1400px; height: 1400px; border-radius: 50%; background: radial-gradient(circle, rgba(142,162,245,0.20) 0%, rgba(142,162,245,0) 62%); }
    #${id}-wrap { position: absolute; left: 160px; top: 140px; width: 1600px; }
    #${id}-kicker { font-size: 30px; font-weight: 700; letter-spacing: 0.14em; text-transform: uppercase; color: #8ea2f5; }
    #${id}-title { margin-top: 22px; font-size: 80px; line-height: 1.06; font-weight: 900; letter-spacing: -0.03em; max-width: 1500px; }
    .${id}-items { margin-top: 40px; display: flex; flex-direction: column; gap: 16px; }
    .${id}-item { font-size: 38px; line-height: 1.25; color: #c9d1dd; display: flex; gap: 22px; align-items: baseline; }
    .${id}-dot { flex: 0 0 14px; height: 14px; border-radius: 3px; background: #8ea2f5; }
    .${id}-stats { margin-top: 44px; display: flex; gap: 40px; }
    .${id}-stat { flex: 1 1 0; background: #121a26; border: 1px solid #222d3d; border-radius: 18px; padding: 28px 36px; }
    .${id}-stat b { display: block; font-size: 72px; font-weight: 900; letter-spacing: -0.02em; color: #ffffff; }
    .${id}-stat span { display: block; margin-top: 8px; font-size: 28px; color: #95a0b2; }
    #${id}-source { position: absolute; left: 160px; top: 820px; font-size: 28px; color: #8a93a3; }
    #${id}-act { position: absolute; left: 160px; top: 64px; font-size: 28px; font-weight: 700; letter-spacing: 0.12em; text-transform: uppercase; color: #95a0b2; }
    #${id}-snap { position: absolute; inset: 0; background: #2443b8; }
    .ph { color: #f2b45a; background: rgba(242,180,90,0.12); border: 1px dashed #f2b45a; border-radius: 8px; padding: 0 10px; font-family: "JetBrains Mono", monospace; font-size: 0.8em; }
    .ph-big .ph, #${id}-where .ph, #${id}-foot .ph { font-size: 1em; }
  </style>`;

const enter = (sel, at, y = 24) =>
  `    tl.fromTo("${sel}", { opacity: 0, y: ${y} }, { opacity: 1, y: 0, duration: 0.45, ease: "power3.out" }, ${at});\n`;

// Act opener: a cobalt panel snaps off screen in the first 0.35 s, plus a small act label.
function actBits(id, sc) {
  if (!sc.act) return { html: "", anim: "" };
  // The first frame is the thumbnail: no cobalt snap panel over it.
  if (sc.start === 0) return { html: `\n    <div id="${id}-act">${esc(sc.act)}</div>`, anim: enter(`#${id}-act`, 0.3, 8) };
  return {
    html: `\n    <div id="${id}-act">${esc(sc.act)}</div>\n    <div id="${id}-snap"></div>`,
    anim: `    tl.fromTo("#${id}-snap", { x: 0 }, { x: -1920, duration: 0.35, ease: "power4.in" }, 0);\n` + enter(`#${id}-act`, 0.3, 8),
  };
}

// Narration-aware reveal times: item k appears when its share of the voice has been spoken.
function revealTimes(sc, n) {
  const words = sc.voice?.words;
  if (!words?.length || !n) return Array.from({ length: n }, (_, k) => +(0.9 + k * Math.max(0.6, (sc.dur * 0.6) / Math.max(1, n))).toFixed(2));
  return Array.from({ length: n }, (_, k) => {
    const w = words[Math.min(words.length - 1, Math.floor((k / n) * words.length))];
    return +Math.max(0.8, LEAD + w.start).toFixed(2);
  });
}

function sceneHtml(sc) {
  const id = sc.id.toLowerCase();
  const v = S[sc.id];
  const act = actBits(id, sc);
  let body = "", css = "", anim = "";
  anim += `    tl.fromTo("#${id}-glow", { x: 0, y: 0 }, { x: 420, y: 160, duration: ${sc.dur}, ease: "none" }, 0);\n`;

  if (v.kind === "clip") {
    css = `
  <style>
    #${id}-slot { position: absolute; left: 96px; top: 54px; width: 1728px; height: 852px; border: 3px dashed #2a3648; border-radius: 28px; background: rgba(18,26,38,0.85); padding: 70px 100px; }
    #${id}-tag { font-size: 28px; font-weight: 700; letter-spacing: 0.16em; text-transform: uppercase; color: #f2b45a; }
    #${id}-sid { margin-top: 20px; font-size: 112px; font-weight: 900; color: #8ea2f5; letter-spacing: -0.03em; }
    #${id}-stitle { margin-top: 6px; font-size: 58px; font-weight: 700; line-height: 1.1; max-width: 1500px; }
    #${id}-file { margin-top: 36px; font-family: "JetBrains Mono", monospace; font-size: 32px; color: #e6eaf0; }
    #${id}-where { margin-top: 14px; font-family: "JetBrains Mono", monospace; font-size: 28px; color: #95a0b2; max-width: 1500px; line-height: 1.4; }
    #${id}-len { margin-top: 14px; font-size: 28px; color: #8a93a3; }
    #${id}-bar { position: absolute; left: 100px; right: 100px; bottom: 60px; height: 8px; border-radius: 4px; background: #222d3d; overflow: hidden; }
    #${id}-fill { width: 100%; height: 100%; background: #8ea2f5; transform-origin: left center; }
    #${id}-chip { position: absolute; right: 150px; top: 170px; padding: 14px 28px; border-radius: 999px; background: #2443b8; color: #ffffff; font-size: 34px; font-weight: 800; }
  </style>`;
    body = `
    <div id="${id}-glow"></div>
    <div id="${id}-slot">
      <div id="${id}-tag">Screen recording slot</div>
      <div id="${id}-sid">${sc.id}</div>
      <div id="${id}-stitle">${esc(sc.title)}</div>
      <div id="${id}-file">${esc(v.file)}</div>
      <div id="${id}-where">${rich(v.where)}</div>
      <div id="${id}-len">${sc.dur} s in the cut; record ${Math.ceil(sc.dur + 4)} s with handles</div>
      <div id="${id}-bar"><div id="${id}-fill"></div></div>
    </div>${v.chip ? `\n    <div id="${id}-chip">${esc(v.chip)}</div>` : ""}${act.html}`;
    anim += enter(`#${id}-slot`, 0.1, 16);
    anim += `    tl.fromTo("#${id}-fill", { scaleX: 0 }, { scaleX: 1, duration: ${(sc.dur - 0.2).toFixed(2)}, ease: "none" }, 0.1);\n`;
    if (v.chip) anim += `    tl.fromTo("#${id}-chip", { opacity: 0, scale: 0.6 }, { opacity: 1, scale: 1, duration: 0.4, ease: "back.out(2)" }, ${revealTimes(sc, 2)[1]});\n`;
    return wrap(id, baseStyle(id) + css, body, anim + act.anim);
  }

  if (v.kind === "title") {
    css = `
  <style>
    #${id}-wrap { top: 0; height: 1080px; display: flex; flex-direction: column; justify-content: center; }
    #${id}-mark { width: 120px; height: 120px; margin-bottom: 44px; }
    #${id}-title { font-size: 104px; }
    #${id}-foot { margin-top: 44px; font-size: 32px; color: #95a0b2; }
  </style>`;
    body = `
    <div id="${id}-glow"></div>
    <div id="${id}-wrap">
      <img id="${id}-mark" src="assets/payminto-mark.svg" alt="Payminto" />
      <div id="${id}-kicker">${esc(v.kicker)}</div>
      <div id="${id}-title">${esc(v.title)}</div>${v.foot ? `\n      <div id="${id}-foot">${rich(v.foot)}</div>` : ""}
    </div>${act.html}`;
    anim += `    tl.fromTo("#${id}-mark", { opacity: 0, scale: 0.8 }, { opacity: 1, scale: 1, duration: 0.5, ease: "back.out(1.6)" }, 0.15);\n`;
    anim += enter(`#${id}-kicker`, 0.35);
    anim += `    tl.fromTo("#${id}-title", { opacity: 0, y: 40, filter: "blur(10px)" }, { opacity: 1, y: 0, filter: "blur(0px)", duration: 0.6, ease: "power4.out" }, 0.55);\n`;
    if (v.foot) anim += enter(`#${id}-foot`, Math.min(sc.dur - 1, 1.6));
    if (v.clip) {
      // Slot for a soft-focus pass over the real dashboard behind the title.
      body = `\n    <div id="${id}-teaser" data-slot="${v.clip}">${esc(v.clip)} (teaser slot)</div>` + body;
      css += `\n  <style>#${id}-teaser { position: absolute; right: 120px; top: 64px; font-family: "JetBrains Mono", monospace; font-size: 28px; color: #95a0b2; border: 2px dashed #2a3648; border-radius: 12px; padding: 10px 18px; }</style>`;
    }
    return wrap(id, baseStyle(id) + css, body, anim + act.anim);
  }

  // card / slide / story
  const stats = v.stats ? `\n      <div class="${id}-stats">${v.stats.map((s, i) => `<div class="${id}-stat" id="${id}-stat${i}"><b>${esc(s[0])}</b><span>${esc(s[1])}</span></div>`).join("")}</div>` : "";
  const items = v.items ? `\n      <div class="${id}-items">${v.items.map((t, i) => `<div class="${id}-item" id="${id}-item${i}"><span class="${id}-dot"></span><span>${rich(t)}</span></div>`).join("")}</div>` : "";
  if (v.kind === "story") {
    css = `
  <style>
    #${id}-wrap { width: 960px; }
    #${id}-title { font-size: 68px; }
    #${id}-img { position: absolute; left: 1180px; top: 150px; width: 600px; height: 640px; border: 3px dashed #2a3648; border-radius: 28px; background: #121a26; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 18px; }
    #${id}-img b { font-size: 30px; color: #f2b45a; letter-spacing: 0.1em; text-transform: uppercase; }
    #${id}-img span { font-family: "JetBrains Mono", monospace; font-size: 28px; color: #95a0b2; }
    #${id}-agent { width: 120px; height: 120px; border-radius: 30px; background: #2443b8; }
  </style>`;
  }
  body = `
    <div id="${id}-glow"></div>
    <div id="${id}-wrap">
      <div id="${id}-kicker">${esc(v.kicker)}</div>
      <div id="${id}-title">${rich(v.title)}</div>${stats}${items}
    </div>${v.img ? `\n    <div id="${id}-img" data-slot="${v.img}"><div id="${id}-agent"></div><b>Image slot</b><span>${v.img}</span></div>` : ""}
    ${v.source ? `<div id="${id}-source">Source: ${esc(v.source)}</div>` : ""}${act.html}`;
  anim += enter(`#${id}-kicker`, 0.15);
  anim += enter(`#${id}-title`, 0.3, 36);
  const n = (v.stats?.length || 0) + (v.items?.length || 0);
  const times = revealTimes(sc, n + 1).slice(1);
  let k = 0;
  (v.stats || []).forEach((_, i) => { anim += enter(`#${id}-stat${i}`, times[k++]); });
  (v.items || []).forEach((_, i) => { anim += enter(`#${id}-item${i}`, times[k++], 16); });
  if (v.img) anim += `    tl.fromTo("#${id}-agent", { scale: 0.7, rotation: -8 }, { scale: 1, rotation: 0, duration: ${(sc.dur - 0.5).toFixed(2)}, ease: "sine.inOut" }, 0.3);\n`;
  if (v.source) anim += `    tl.fromTo("#${id}-source", { opacity: 0 }, { opacity: 1, duration: 0.4 }, 1.4);\n`;
  return wrap(id, baseStyle(id) + css, body, anim + act.anim);
}

function wrap(id, css, body, anim) {
  return `<template>
${css}
  <div id="root" data-composition-id="${id}" data-width="1920" data-height="1080">${body}
  </div>
  <script>
    const tl = gsap.timeline({ paused: true });
${anim}    window.__timelines["${id}"] = tl;
  </script>
</template>
`;
}

for (const sc of scenes) writeFileSync(join(proj, "compositions", `${sc.id.toLowerCase()}.html`), sceneHtml(sc));

// ---- Testnet badge overlay: S08 to S18 and S26.
const sA = scenes.find((s) => s.id === "S08"), sB = scenes.find((s) => s.id === "S18"), sX = scenes.find((s) => s.id === "S26");
const badgeStart = sA.start, badgeDur = +(sX.start + sX.dur - sA.start).toFixed(2);
const b1 = { s: 0, d: +(sB.start + sB.dur - sA.start).toFixed(2) }, b2 = { s: +(sX.start - sA.start).toFixed(2), d: sX.dur };
writeFileSync(join(proj, "compositions", "badge.html"), `<template>
  <style>
    #root { position: absolute; inset: 0; pointer-events: none; }
    .badge { position: absolute; right: 120px; top: 70px; padding: 12px 22px; border-radius: 999px; background: rgba(12,18,27,0.9); border: 2px solid #f2b45a; color: #f2b45a; font-family: "Inter", sans-serif; font-size: 28px; font-weight: 700; letter-spacing: 0.04em; }
  </style>
  <div id="root" data-composition-id="badge" data-width="1920" data-height="1080">
    <div id="badge-a" class="clip badge" data-start="${b1.s}" data-duration="${b1.d}" data-track-index="0"><span id="badge-a-t">Testnet - tokens have no value</span></div>
    <div id="badge-b" class="clip badge" data-start="${b2.s}" data-duration="${b2.d}" data-track-index="1"><span id="badge-b-t">Testnet - tokens have no value</span></div>
  </div>
  <script>
    const tl = gsap.timeline({ paused: true });
    tl.fromTo("#badge-a-t", { opacity: 0 }, { opacity: 1, duration: 0.4 }, ${b1.s + 0.4});
    tl.fromTo("#badge-b-t", { opacity: 0 }, { opacity: 1, duration: 0.4 }, ${b2.s + 0.4});
    window.__timelines["badge"] = tl;
  </script>
</template>
`);

// ---- Captions from the real word timings (falls back to an even spread without voice).
const groups = [];
for (const sc of scenes) {
  const off = sc.start + LEAD;
  let words = sc.voice?.words?.map((w) => ({ text: w.text, start: off + w.start, end: off + w.end }));
  if (!words?.length) {
    const ws = sc.narr.map(spoken).join(" ").split(/\s+/).filter(Boolean), per = (sc.dur - 0.6) / ws.length;
    words = ws.map((w, i) => ({ text: w, start: off + i * per, end: off + (i + 1) * per }));
  }
  let g = [];
  const flush = () => {
    if (!g.length) return;
    const s = Math.max(sc.start + 0.1, g[0].start - 0.05), e = Math.min(sc.start + sc.dur, g.at(-1).end + 0.12);
    groups.push({ text: g.map((w) => w.text).join(" "), s: +s.toFixed(2), d: +(e - s).toFixed(2) }); g = [];
  };
  words.forEach((w, i) => {
    if (g.length && (w.start - g.at(-1).end >= 0.15 || g.length >= 4 || /[.,:;?!]$/.test(g.at(-1).text))) flush();
    g.push(w);
  });
  flush();
}
// Never let two groups overlap.
for (let i = 1; i < groups.length; i++) {
  const p = groups[i - 1];
  if (p.s + p.d > groups[i].s) p.d = +(groups[i].s - p.s).toFixed(2);
}
const capHtml = groups.map((g, i) => `    <div id="cap-${String(i + 1).padStart(3, "0")}" class="clip cap" data-start="${g.s}" data-duration="${g.d}" data-track-index="0"><span id="cap-${String(i + 1).padStart(3, "0")}-t">${esc(g.text)}</span></div>`).join("\n");
const capAnim = groups.map((g, i) => `    tl.fromTo("#cap-${String(i + 1).padStart(3, "0")}-t", { opacity: 0, y: 10 }, { opacity: 1, y: 0, duration: 0.1, ease: "power2.out" }, ${g.s});`).join("\n");
writeFileSync(join(proj, "compositions", "captions.html"), `<template>
  <style>
    #root { position: absolute; inset: 0; pointer-events: none; }
    .cap { position: absolute; left: 0; right: 0; top: 900px; text-align: center; overflow: visible; }
    .cap span { display: inline-block; padding: 8px 26px; border-radius: 14px; background: rgba(12,18,27,0.78); color: #ffffff; font-family: "Inter", sans-serif; font-size: 54px; font-weight: 700; letter-spacing: -0.01em; }
  </style>
  <div id="root" data-composition-id="captions" data-width="1920" data-height="1080">
${capHtml}
  </div>
  <script>
    const tl = gsap.timeline({ paused: true });
${capAnim}
    window.__timelines["captions"] = tl;
  </script>
</template>
`);

// ---- Root index.html.
const hosts = scenes.map((sc) => {
  const id = sc.id.toLowerCase();
  const v = S[sc.id];
  let h = `      <div id="${id}" data-composition-id="${id}" data-composition-src="compositions/${id}.html" data-start="${sc.start}" data-duration="${sc.dur}" data-track-index="1" data-track-kind="graphics" data-width="1920" data-height="1080"></div>`;
  const clip = v.kind === "clip" ? v.file : v.clip;
  const tag = (c) => `<video id="v-${id}" class="clip" src="assets/${c}" muted playsinline data-start="${sc.start}" data-duration="${sc.dur}" data-media-start="2" data-track-index="2" style="position: absolute; left: 0; top: 0; width: 1920px; height: 1080px; object-fit: contain; z-index: 5"></video>`;
  // A clip that exists in assets/clips is mounted; a missing one stays a commented slot.
  if (clip && existsSync(join(proj, "assets", clip))) h += `\n      ${tag(clip)}`;
  else if (clip) h += `\n      <!-- ${sc.id} clip: copy media/demo-video/${clip} to assets/${clip}, then uncomment. -->\n      <!-- <video id="v-${id}" class="clip" src="assets/${clip}" muted playsinline data-start="${sc.start}" data-duration="${sc.dur}" data-media-start="2" data-track-index="2" style="position: absolute; left: 0; top: 0; width: 1920px; height: 1080px; object-fit: contain; z-index: 5"></video> -->`;
  return h;
}).join("\n");
const audio = scenes.filter((s) => s.voice).map((sc) => {
  const nn = sc.id.slice(1);
  return `      <audio id="vo-${nn}" class="clip" src="assets/voice/${nn}.wav" data-start="${+(sc.start + LEAD).toFixed(2)}" data-duration="${sc.voice.duration_s}" data-volume="1" data-track-index="5"></audio>`;
}).join("\n");

writeFileSync(join(proj, "index.html"), `<!doctype html>
<html lang="en" data-resolution="landscape">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=1920, height=1080" />
    <title>Payminto demo</title>
    <script src="https://cdn.jsdelivr.net/npm/gsap@3.15.0/dist/gsap.min.js"></script>
    <style>
      * { margin: 0; padding: 0; box-sizing: border-box; }
      html, body { margin: 0; width: 1920px; height: 1080px; overflow: hidden; background: #0c121b; }
    </style>
  </head>
  <body>
    <!-- Generated from ../MASTER_SCRIPT.md and ../audio/audio_meta.json. Scene ids match MASTER_SCRIPT.md, STORYBOARD.md and SHOTLIST.md. Total ${total} s. -->
    <div id="root" data-composition-id="main" data-start="0" data-duration="${total}" data-width="1920" data-height="1080">
${hosts}
      <div id="badge" data-composition-id="badge" data-composition-src="compositions/badge.html" data-start="${badgeStart}" data-duration="${badgeDur}" data-track-index="3" data-track-kind="graphics" data-width="1920" data-height="1080" style="z-index: 8"></div>
      <div id="captions" data-composition-id="captions" data-composition-src="compositions/captions.html" data-start="0" data-duration="${total}" data-track-index="4" data-track-kind="captions" data-width="1920" data-height="1080" style="z-index: 9"></div>
${audio}
      <!-- Music bed slot: add <audio id="music" class="clip" src="assets/audio/music.mp3" data-start="0" data-volume="0.18" data-track-index="6"></audio> under the voice. -->
    </div>
    <script>
      const tl = gsap.timeline({ paused: true });
      window.__timelines["main"] = tl;
    </script>
  </body>
</html>
`);

// ---- Fish Audio narration script, in the format fish-tts.mjs parses.
let fish = `# Payminto demo: voiceover lines for Fish Audio

Generated from ../MASTER_SCRIPT.md for \`~/.claude/skills/fish-audio-narration/scripts/fish-tts.mjs\`.
Each "## Line N ... (Frame N)" section is one audio file, \`assets/voice/NN.wav\`; Frame N is scene SNN.
The indented lines are spoken; bracketed cues are Fish Audio S2 emotion and tone markers and are not spoken.
Placeholders are replaced by spoken fallbacks listed in SCRIPT_REVIEW.md.

`;
for (const sc of scenes) {
  const n = +sc.id.slice(1);
  fish += `## Line ${n} - ${sc.id} ${sc.title} (Frame ${n})\n\n`;
  sc.narr.forEach((l, j) => { fish += `    ${j === 0 && sc.cue ? sc.cue + " " : ""}${spoken(l)}\n`; });
  fish += `\n`;
}
mkdirSync(join(base, "audio"), { recursive: true });
writeFileSync(join(base, "audio", "SCRIPT.md"), fish);
try { readFileSync(join(base, "audio", "audio_meta.json")); } catch { writeFileSync(join(base, "audio", "audio_meta.json"), JSON.stringify({ voices: [] }, null, 2) + "\n"); }

console.log(`scenes=${scenes.length} total=${total}s captions=${groups.length} voiced=${scenes.filter((s) => s.voice).length}`);
for (const sc of scenes) console.log(sc.id, "start", sc.start, "dur", sc.dur, "planned", sc.planned, sc.voice ? "voice " + sc.voice.duration_s : "");
