// Builds the short product cut (this folder) from ../SHORT_SCRIPT.md, ../audio-short/audio_meta.json
// (new voice lines) and ../audio/audio_meta.json (voice lines reused word for word from the long cut).
// Usage, from media/demo-video: node video-short/build.mjs .
// Steps: parse the script, write ../audio-short/SCRIPT.md for the new lines, time every scene to its
// voice, fit each screen recording to its scene with ffmpeg (cut or hold, speed-up labelled above 1.3x),
// then write the scene compositions, the overlays, the captions and index.html.
import { readFileSync, writeFileSync, mkdirSync, existsSync, copyFileSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";

const base = process.argv[2] || ".";
const proj = join(base, "video-short");
for (const d of ["compositions", "assets/clips", "assets/voice", "assets/img"]) mkdirSync(join(proj, d), { recursive: true });
mkdirSync(join(base, "audio-short"), { recursive: true });

const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const LEAD = 0.25, TAIL = 0.35, SPEED_LABEL_ABOVE = 1.3;

// ---- Parse SHORT_SCRIPT.md.
const scenes = [];
let cur = null, inNarr = false;
for (const line of readFileSync(join(base, "SHORT_SCRIPT.md"), "utf8").split("\n")) {
  const h = line.match(/^### (T\d\d) - (.+?) \((\d+):(\d\d), (\d+) s\)/);
  if (h) { cur = { id: h[1], title: h[2], planned: +h[5], narr: [], cue: "", section: "", reuse: 0 }; scenes.push(cur); inNarr = false; continue; }
  if (!cur) continue;
  if (/^#/.test(line)) { inNarr = false; continue; }
  let m;
  if ((m = line.match(/^Section: (.+?)\.$/))) cur.section = m[1];
  if ((m = line.match(/^Voice cue: (.+)$/))) cur.cue = m[1].trim();
  if ((m = line.match(/^Voice: reused from the long cut, S(\d\d)\.$/))) cur.reuse = +m[1];
  if (line.startsWith("Narration:")) { inNarr = true; continue; }
  if (inNarr && line.startsWith("- ")) cur.narr.push(line.slice(2).replace(/`/g, ""));
}

// ---- Pronunciation (same as the long cut) and caption merge back to brand spellings.
const RESPELL = [[/Payminto/g, "Pay Mint-oh"], [/HashKey/g, "Hash Key"], [/V3\.1/g, "V three point one"]];
const spoken = (l) => RESPELL.reduce((t, [re, v]) => t.replace(re, v), l);
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
    if (!done) { const one = MERGE.find(([k]) => k === words[i].text.toLowerCase().replace(/[^a-z]/g, "")); out.push(one ? { ...words[i], text: one[1] } : words[i]); }
  }
  return out;
}

// ---- Fish script for the new lines only.
let fish = "# Payminto short cut: new voice lines for Fish Audio\n\nGenerated from ../SHORT_SCRIPT.md by ../video-short/build.mjs; lines reused from the long cut are not listed.\nFrame N is scene TNN. Bracketed cues are Fish Audio S2 markers and are not spoken.\n\n";
for (const sc of scenes.filter((s) => !s.reuse)) {
  const n = +sc.id.slice(1);
  fish += `## Line ${n} - ${sc.id} ${sc.title} (Frame ${n})\n\n`;
  sc.narr.forEach((l, j) => { fish += `    ${j === 0 && sc.cue ? sc.cue + " " : ""}${spoken(l)}\n`; });
  fish += "\n";
}
writeFileSync(join(base, "audio-short", "SCRIPT.md"), fish);
if (!existsSync(join(base, "audio-short", "audio_meta.json"))) writeFileSync(join(base, "audio-short", "audio_meta.json"), JSON.stringify({ voices: [] }, null, 2) + "\n");

// ---- Voices and timing. EXTRA adds a silent visual tail to a scene (seconds).
const EXTRA = { T08: 4 };
const load = (p) => { try { return new Map(JSON.parse(readFileSync(p, "utf8")).voices.map((v) => [v.frame, v])); } catch { return new Map(); } };
const newV = load(join(base, "audio-short", "audio_meta.json")), longV = load(join(base, "audio", "audio_meta.json"));
let t = 0;
for (const sc of scenes) {
  const n = +sc.id.slice(1);
  const v = sc.reuse ? longV.get(sc.reuse) : newV.get(n);
  if (v) {
    const src = sc.reuse ? join(base, "audio", "assets", "voice", String(sc.reuse).padStart(2, "0") + ".wav") : join(base, "audio-short", "assets", "voice", String(n).padStart(2, "0") + ".wav");
    sc.wav = `assets/voice/${sc.id}.wav`;
    copyFileSync(src, join(proj, sc.wav));
    sc.voice = { ...v, words: mergeWords(v.words) };
  }
  sc.dur = (v ? Math.ceil((v.duration_s + LEAD + TAIL) * 10) / 10 : sc.planned) + (EXTRA[sc.id] || 0);
  sc.start = +t.toFixed(2);
  t += sc.dur;
}
const total = +t.toFixed(2);

// ---- Visual spec.
const FIT = join(base, "record", "out", "fit"), RAW = join(base, "record", "out");
const S = {
  T01: { kind: "title", kicker: "Hi there, this is Payminto", title: "AI agents pay each other. People pay you. On your own server.", foot: "Settled on HashKey Chain" },
  T02: { kind: "image", img: "hashkey-use-case.png", kicker: "What it is", title: "Self-hosted. Non-custodial. One link for people and AI agents." },
  T03: { kind: "clip", src: join(FIT, "S09-checkout.mp4"), label: "Paid in test USDC, fee split on chain" },
  T04: { kind: "clip", src: join(FIT, "S10-ai-connection.mp4"), label: "Your own model key: DeepSeek V3.1 via Replicate" },
  T05: { kind: "clip", src: join(FIT, "S12-mandate-calls.mp4"), label: "Budget: caps, allowed services, refusals by rule" },
  // T06 from the raw terminal recording: the command typing is sped up (labelled), the agent output plays at real speed.
  T06: { kind: "clip", src: join(RAW, "S11-buyer-task.mp4"), segs: [{ from: 2, to: 15.2, len: 2.4 }, { from: 15.2, to: 20.7 }] },
  T07: { kind: "clip", src: join(FIT, "S13-seller-brief.mp4"), label: "Agent pays agent" },
  T08: { kind: "clip", src: join(FIT, "S14-netting-settle.mp4"), label: "60 charges, a few transfers, one transaction",
    // Up to 4 s of the explorer tour: the Sepolia settlement page with its Circle USDC transfers.
    then: { src: join(RAW, "S26-explorer-tour.mp4"), from: 13.1, len: 4, label: "Same contracts on Ethereum Sepolia, Circle testnet USDC", overlayLabel: false } }, // the recording carries its own page label
  T09: { kind: "clip", src: join(FIT, "S15-receipt-proof.mp4"), label: "One call, proven on chain" },
  T10: { kind: "clip", src: join(FIT, "S16-ops-earnings.mp4"), label: "Ops agent answers from real payments" },
  T11: { kind: "clip", src: join(FIT, "S17-refund-approve.mp4"), label: "Agent requests, a human approves" },
  T12: { kind: "clip", src: join(FIT, "S18-reconciliation-csv.mp4"), label: "One reconciliation report" },
  T13: { kind: "term", kicker: "Self-host with any AI agent", prompt: "Follow https://github.com/sagarjethi/payminto-clearing/blob/main/docs/SELF_HOST.md to run my own Payminto. Start with Path A." },
  T14: { kind: "clip", src: join(RAW, "T14-self-host.mp4"), head: 2, label: "Clone, paste one line, run your own" },
  T15: { kind: "title", kicker: "Payminto", title: "Get paid by people and AI agents, on your own server.", foot: "github.com/sagarjethi/payminto-clearing  ·  Live on HashKey Chain Testnet  ·  Testnet only, tokens have no value, no mainnet deploy yet" },
};

// ---- Fit each recording to its scene: cut the handle, then speed up (labelled above 1.3x) or hold the last frame.
const probe = (f) => +execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", f], { encoding: "utf8" }).trim();
const fitLog = [];
for (const sc of scenes) {
  const v = S[sc.id];
  if (v.kind !== "clip") continue;
  if (!existsSync(v.src)) { v.missing = true; continue; }
  if (v.segs) {
    // Piecewise fit: each segment to its own length (1x when none is given), joined, then held or cut to the scene.
    v.file = `assets/clips/${sc.id}.mp4`;
    const out = join(proj, v.file), T = sc.dur;
    const stamp = `${v.src}|${statSync(v.src).mtimeMs}|${T}|${JSON.stringify(v.segs)}`;
    let at = 0;
    v.spans = v.segs.map((g) => { const d = g.to - g.from, len = g.len || d, r = d / len; const span = { start: at, len, rate: +r.toFixed(2) }; at += len; return span; });
    if (!existsSync(out) || !existsSync(out + ".stamp") || readFileSync(out + ".stamp", "utf8") !== stamp) {
      const parts = v.segs.map((g, i) => `[0:v]trim=${g.from}:${g.to},setpts=(PTS-STARTPTS)/${v.spans[i].rate},fps=30,scale=1920:1080:flags=lanczos[s${i}]`).join(";");
      const hold = Math.max(0, T - at);
      const fc = `${parts};${v.segs.map((_, i) => `[s${i}]`).join("")}concat=n=${v.segs.length}:v=1:a=0[c];[c]tpad=stop_mode=clone:stop_duration=${hold.toFixed(3)},format=yuv420p[v]`;
      execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-i", v.src, "-filter_complex", fc, "-map", "[v]", "-t", T.toFixed(3), "-c:v", "libx264", "-preset", "medium", "-crf", "17", "-movflags", "+faststart", out]);
      writeFileSync(out + ".stamp", stamp);
    }
    fitLog.push(`${sc.id} pieces ${v.spans.map((p) => `${p.len}s at ${p.rate}x`).join(" + ")}, hold ${Math.max(0, T - at).toFixed(2)}s`);
    continue;
  }
  const head = v.head || 0, d = probe(v.src) - head - (v.head ? 2 : 0), T = +(sc.dur - (v.then?.len || 0)).toFixed(2);
  const rate = d > T ? d / T : 1, hold = d < T ? T - d : 0;
  v.rate = +rate.toFixed(3); v.sped = rate > SPEED_LABEL_ABOVE;
  v.file = `assets/clips/${sc.id}.mp4`;
  const out = join(proj, v.file);
  const stamp = `${v.src}|${statSync(v.src).mtimeMs}|${T}|${JSON.stringify(v.then || null)}`;
  const stampFile = out + ".stamp";
  if (!existsSync(out) || !existsSync(stampFile) || readFileSync(stampFile, "utf8") !== stamp) {
    const vf = [`setpts=(PTS-STARTPTS)/${rate}`, "fps=30", "scale=1920:1080:flags=lanczos", hold > 0 ? `tpad=stop_mode=clone:stop_duration=${hold.toFixed(3)}` : null, "format=yuv420p"].filter(Boolean).join(",");
    const main = v.then ? out.replace(/\.mp4$/, ".main.mp4") : out;
    execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-ss", String(head), "-i", v.src, "-t", String(d), "-vf", vf, "-an", "-t", T.toFixed(3), "-c:v", "libx264", "-preset", "medium", "-crf", "17", "-movflags", "+faststart", main]);
    if (v.then) {
      const tail = out.replace(/\.mp4$/, ".then.mp4");
      execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-ss", String(v.then.from), "-i", v.then.src, "-t", String(v.then.len), "-vf", "fps=30,scale=1920:1080:flags=lanczos,format=yuv420p", "-an", "-c:v", "libx264", "-preset", "medium", "-crf", "17", tail]);
      execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-i", main, "-i", tail, "-filter_complex", "[0:v][1:v]concat=n=2:v=1:a=0[v]", "-map", "[v]", "-c:v", "libx264", "-preset", "medium", "-crf", "17", "-movflags", "+faststart", out]);
    }
    writeFileSync(stampFile, stamp);
  }
  fitLog.push(`${sc.id} ${d.toFixed(2)}s -> ${T}s, rate ${v.rate}x${v.sped ? " (Sped up label)" : ""}${hold > 0 ? `, hold ${hold.toFixed(2)}s` : ""}`);
}
copyFileSync(join(base, "..", "..", "docs", "img", "hashkey-use-case.png"), join(proj, "assets", "img", "hashkey-use-case.png"));
copyFileSync(join(base, "video", "assets", "payminto-mark.svg"), join(proj, "assets", "payminto-mark.svg"));

// ---- Scene compositions.
const enter = (sel, at, y = 24) => `    tl.fromTo("${sel}", { opacity: 0, y: ${y} }, { opacity: 1, y: 0, duration: 0.45, ease: "power3.out" }, ${at});\n`;
const style = (id, extra = "") => `
  <style>
    #root { position: absolute; inset: 0; background: #0c121b; color: #e6eaf0; font-family: "Inter", sans-serif; overflow: hidden; }
    #${id}-glow { position: absolute; left: -300px; top: -300px; width: 1400px; height: 1400px; border-radius: 50%; background: radial-gradient(circle, rgba(142,162,245,0.20) 0%, rgba(142,162,245,0) 62%); }
    #${id}-kicker { font-size: 30px; font-weight: 700; letter-spacing: 0.14em; text-transform: uppercase; color: #8ea2f5; }
    #${id}-title { margin-top: 22px; font-size: 84px; line-height: 1.06; font-weight: 900; letter-spacing: -0.03em; max-width: 1560px; }
    #${id}-snap { position: absolute; inset: 0; background: #2443b8; }${extra}
  </style>`;
const wrap = (id, css, body, anim) => `<template>
${css}
  <div id="root" data-composition-id="${id}" data-width="1920" data-height="1080">${body}
  </div>
  <script>
    const tl = gsap.timeline({ paused: true });
${anim}    window.__timelines["${id}"] = tl;
  </script>
</template>
`;
const glow = (id, dur) => `    tl.fromTo("#${id}-glow", { x: 0, y: 0 }, { x: 420, y: 160, duration: ${dur}, ease: "none" }, 0);\n`;
const snap = (id, sc) => sc.start === 0 ? { html: "", anim: "" } : { html: `\n    <div id="${id}-snap"></div>`, anim: `    tl.fromTo("#${id}-snap", { x: 0 }, { x: -1920, duration: 0.35, ease: "power4.in" }, 0);\n` };

function sceneHtml(sc) {
  const id = sc.id.toLowerCase(), v = S[sc.id], sn = snap(id, sc);
  if (v.kind === "title") {
    const css = style(id, `
    #${id}-wrap { position: absolute; left: 160px; top: 0; height: 1080px; width: 1600px; display: flex; flex-direction: column; justify-content: center; }
    #${id}-mark { width: 120px; height: 120px; margin-bottom: 40px; }
    #${id}-foot { margin-top: 40px; font-size: 32px; font-weight: 600; color: #f2b45a; max-width: 1560px; line-height: 1.4; }`);
    const body = `
    <div id="${id}-glow"></div>
    <div id="${id}-wrap">
      <img id="${id}-mark" src="assets/payminto-mark.svg" alt="Payminto" />
      <div id="${id}-kicker">${esc(v.kicker)}</div>
      <div id="${id}-title">${esc(v.title)}</div>
      <div id="${id}-foot">${esc(v.foot)}</div>
    </div>${sn.html}`;
    let anim = glow(id, sc.dur) + sn.anim;
    // The first frame is the thumbnail: the opening card is on screen at 0 s and only the footer enters.
    if (sc.start > 0) {
      anim += `    tl.fromTo("#${id}-mark", { opacity: 0, scale: 0.8 }, { opacity: 1, scale: 1, duration: 0.5, ease: "back.out(1.6)" }, 0.15);\n`;
      anim += enter(`#${id}-kicker`, 0.35);
      anim += `    tl.fromTo("#${id}-title", { opacity: 0, y: 40, filter: "blur(10px)" }, { opacity: 1, y: 0, filter: "blur(0px)", duration: 0.6, ease: "power4.out" }, 0.55);\n`;
    } else anim += `    tl.fromTo("#${id}-title", { scale: 1 }, { scale: 1.02, duration: ${sc.dur}, ease: "none", transformOrigin: "left center" }, 0);\n`;
    anim += enter(`#${id}-foot`, Math.min(sc.dur - 1.5, 2.2));
    return wrap(id, css, body, anim);
  }
  if (v.kind === "image") {
    const css = style(id, `
    #${id}-head { position: absolute; left: 160px; top: 70px; width: 1600px; }
    #${id}-title { font-size: 56px; }
    #${id}-frame { position: absolute; left: 160px; top: 290px; width: 1600px; height: 560px; border-radius: 28px; background: #ffffff; overflow: hidden; box-shadow: 0 30px 80px rgba(0,0,0,0.45); }
    #${id}-img { width: 100%; height: 100%; object-fit: contain; }`);
    const body = `
    <div id="${id}-glow"></div>
    <div id="${id}-head"><div id="${id}-kicker">${esc(v.kicker)}</div><div id="${id}-title">${esc(v.title)}</div></div>
    <div id="${id}-frame" data-layout-allow-overflow><img id="${id}-img" src="assets/img/${v.img}" alt="Payminto use case on HashKey Chain" /></div>${sn.html}`;
    let anim = glow(id, sc.dur) + sn.anim + enter(`#${id}-kicker`, 0.2) + enter(`#${id}-title`, 0.35, 30);
    anim += `    tl.fromTo("#${id}-frame", { opacity: 0, y: 80, scale: 0.96 }, { opacity: 1, y: 0, scale: 1, duration: 0.8, ease: "power3.out" }, 0.6);\n`;
    anim += `    tl.fromTo("#${id}-img", { scale: 1 }, { scale: 1.04, duration: ${(sc.dur - 1.5).toFixed(2)}, ease: "sine.inOut" }, 1.4);\n`;
    return wrap(id, css, body, anim);
  }
  if (v.kind === "term") {
    const css = style(id, `
    #${id}-head { position: absolute; left: 160px; top: 110px; }
    #${id}-term { position: absolute; left: 160px; top: 290px; width: 1600px; border-radius: 22px; background: #070b12; border: 2px solid #222d3d; box-shadow: 0 30px 80px rgba(0,0,0,0.5); overflow: hidden; }
    #${id}-bar { height: 56px; background: #121a26; display: flex; align-items: center; gap: 12px; padding: 0 24px; }
    .${id}-dot { width: 16px; height: 16px; border-radius: 50%; background: #2a3648; }
    #${id}-bar span { margin-left: 16px; font-family: "JetBrains Mono", monospace; font-size: 28px; color: #95a0b2; }
    #${id}-body { padding: 44px 48px 52px; font-family: "JetBrains Mono", monospace; font-size: 38px; line-height: 1.5; color: #e6eaf0; }
    #${id}-ps { color: #8ea2f5; }
    #${id}-note { position: absolute; left: 160px; top: 800px; font-size: 30px; color: #95a0b2; }`);
    // Typed reveal: the prompt is split into words that appear in order over the first part of the scene.
    const words = v.prompt.split(" ");
    const spans = words.map((w, i) => `<span id="${id}-w${i}">${esc(w)} </span>`).join("");
    const body = `
    <div id="${id}-glow"></div>
    <div id="${id}-head"><div id="${id}-kicker">${esc(v.kicker)}</div><div id="${id}-title">Paste one line into your coding agent.</div></div>
    <div id="${id}-term"><div id="${id}-bar"><i class="${id}-dot"></i><i class="${id}-dot"></i><i class="${id}-dot"></i><span>your AI coding agent, in a clone of the repository</span></div><div id="${id}-body"><span id="${id}-ps">&gt; </span>${spans}</div></div>
    <div id="${id}-note">Claude Code or any coding agent that can read a link and run commands.</div>${sn.html}`;
    let anim = glow(id, sc.dur) + sn.anim + enter(`#${id}-kicker`, 0.2) + enter(`#${id}-title`, 0.35, 30) + enter(`#${id}-term`, 0.6, 30);
    const t0 = 1.0, span = Math.max(2, sc.dur * 0.55);
    words.forEach((_, i) => { anim += `    tl.fromTo("#${id}-w${i}", { opacity: 0 }, { opacity: 1, duration: 0.05 }, ${(t0 + (span * i) / words.length).toFixed(2)});\n`; });
    anim += enter(`#${id}-note`, 1.2, 10);
    return wrap(id, css, body, anim);
  }
  // clip: a dark placeholder under the recording, visible only if the recording is missing.
  const css = style(id, `
    #${id}-ph { position: absolute; left: 96px; top: 54px; width: 1728px; height: 852px; border: 3px dashed #2a3648; border-radius: 28px; padding: 70px 100px; font-size: 48px; font-weight: 800; }`);
  // With a recording mounted above it, the scene is only a background (no text for the audit to flag).
  if (v.file) return wrap(id, css, `\n    <div id="${id}-glow"></div>`, glow(id, sc.dur));
  const body = `\n    <div id="${id}-glow"></div>\n    <div id="${id}-ph">${sc.id}: ${esc(sc.title)}</div>`;
  return wrap(id, css, body, glow(id, sc.dur) + enter(`#${id}-ph`, 0.1, 10));
}
for (const sc of scenes) writeFileSync(join(proj, "compositions", `${sc.id.toLowerCase()}.html`), sceneHtml(sc));

// ---- Overlay above the recordings: section snaps and chips, scene labels, the testnet badge, speed labels.
const ov = [], ovAnim = [];
// The badge sits top right, except over the reconciliation table (T12), whose header row is at the top: there it moves low right.
const first = scenes.find((s) => s.id === "T03"), t11 = scenes.find((s) => s.id === "T11"), t12 = scenes.find((s) => s.id === "T12");
const badgeStart = first.start, badgeDur = +(t11.start + t11.dur - first.start).toFixed(2);
ov.push(`    <div id="ov-badge" class="clip ov-badge" data-start="${badgeStart}" data-duration="${badgeDur}" data-track-index="0"><span id="ov-badge-t">Testnet - tokens have no value</span></div>`);
ov.push(`    <div id="ov-badge2" class="clip ov-badge ov-badge-low" data-start="${t12.start}" data-duration="${t12.dur}" data-track-index="5"><span id="ov-badge2-t">Testnet - tokens have no value</span></div>`);
ovAnim.push(`    tl.fromTo("#ov-badge2-t", { opacity: 0.6 }, { opacity: 1, duration: 0.3 }, ${t12.start});`);
ovAnim.push(`    tl.fromTo("#ov-badge-t", { opacity: 0 }, { opacity: 1, duration: 0.4 }, ${badgeStart + 0.4});`);
for (const sc of scenes) {
  const v = S[sc.id], id = sc.id.toLowerCase();
  if (v.kind !== "clip") continue;
  if (sc.section && sc.start > 0) {
    ov.push(`    <div id="ov-${id}-snap" class="clip ov-snap" data-start="${sc.start}" data-duration="0.4" data-track-index="1"><div id="ov-${id}-snapi" class="ov-snapi"></div></div>`);
    ovAnim.push(`    tl.fromTo("#ov-${id}-snapi", { x: 0 }, { x: -1920, duration: 0.35, ease: "power4.in" }, ${sc.start});`);
    ov.push(`    <div id="ov-${id}-sec" class="clip ov-sec" data-start="${(sc.start + 0.3).toFixed(2)}" data-duration="2.6" data-track-index="2"><span id="ov-${id}-sect">${esc(sc.section)}</span></div>`);
    ovAnim.push(`    tl.fromTo("#ov-${id}-sect", { opacity: 0, x: -20 }, { opacity: 1, x: 0, duration: 0.35, ease: "power3.out" }, ${(sc.start + 0.3).toFixed(2)});`);
  }
  if (v.then && v.then.overlayLabel) {
    const s1 = +(sc.start + sc.dur - v.then.len).toFixed(2);
    ov.push(`    <div id="ov-${id}-then" class="clip ov-lab" data-start="${s1}" data-duration="${(v.then.len - 0.1).toFixed(2)}" data-track-index="3"><span id="ov-${id}-thent">${esc(v.then.label)}</span></div>`);
    ovAnim.push(`    tl.fromTo("#ov-${id}-thent", { opacity: 0, y: 10 }, { opacity: 1, y: 0, duration: 0.35, ease: "power3.out" }, ${s1});`);
  }
  if (v.label) {
    const s0 = +(sc.start + (sc.section ? 2.9 : 0.4)).toFixed(2), d0 = Math.max(1.5, +(sc.dur - (v.then?.len || 0) - (s0 - sc.start) - 0.3).toFixed(2));
    ov.push(`    <div id="ov-${id}-lab" class="clip ov-lab" data-start="${s0}" data-duration="${d0}" data-track-index="3"><span id="ov-${id}-labt">${esc(v.label)}</span></div>`);
    ovAnim.push(`    tl.fromTo("#ov-${id}-labt", { opacity: 0, y: 10 }, { opacity: 1, y: 0, duration: 0.35, ease: "power3.out" }, ${s0});`);
  }
  for (const [i, p] of (v.spans || []).entries()) {
    if (p.rate <= SPEED_LABEL_ABOVE) continue;
    ov.push(`    <div id="ov-${id}-spd${i}" class="clip ov-spd" data-start="${+(sc.start + p.start).toFixed(2)}" data-duration="${p.len}" data-track-index="4"><span id="ov-${id}-spd${i}t">Sped up ${p.rate.toFixed(1)}x</span></div>`);
    ovAnim.push(`    tl.fromTo("#ov-${id}-spd${i}t", { opacity: 0 }, { opacity: 1, duration: 0.2 }, ${+(sc.start + p.start).toFixed(2)});`);
  }
  if (v.sped) {
    ov.push(`    <div id="ov-${id}-spd" class="clip ov-spd" data-start="${sc.start}" data-duration="${sc.dur}" data-track-index="4"><span id="ov-${id}-spdt">Sped up ${v.rate.toFixed(1)}x</span></div>`);
    ovAnim.push(`    tl.fromTo("#ov-${id}-spdt", { opacity: 0 }, { opacity: 1, duration: 0.3 }, ${sc.start + 0.2});`);
  }
}
writeFileSync(join(proj, "compositions", "overlay.html"), `<template>
  <style>
    #root { position: absolute; inset: 0; pointer-events: none; font-family: "Inter", sans-serif; }
    .ov-badge { position: absolute; right: 120px; top: 70px; padding: 12px 22px; border-radius: 999px; background: rgba(12,18,27,0.9); border: 2px solid #f2b45a; color: #f2b45a; font-size: 28px; font-weight: 700; }
    .ov-badge-low { top: 860px; }
    .ov-snap { position: absolute; inset: 0; overflow: hidden; }
    .ov-snapi { position: absolute; inset: 0; background: #2443b8; }
    .ov-sec { position: absolute; left: 120px; top: 70px; padding: 12px 24px; border-radius: 14px; background: #2443b8; color: #ffffff; font-size: 30px; font-weight: 800; letter-spacing: 0.06em; text-transform: uppercase; }
    .ov-lab { position: absolute; left: 120px; top: 800px; padding: 12px 22px; border-radius: 14px; background: rgba(12,18,27,0.9); color: #ffffff; font-size: 30px; font-weight: 700; border: 2px solid #2443b8; }
    .ov-spd { position: absolute; right: 120px; top: 150px; padding: 10px 18px; border-radius: 999px; background: rgba(12,18,27,0.9); color: #e6eaf0; font-size: 28px; font-weight: 700; }
  </style>
  <div id="root" data-composition-id="overlay" data-width="1920" data-height="1080">
${ov.join("\n")}
  </div>
  <script>
    const tl = gsap.timeline({ paused: true });
${ovAnim.join("\n")}
    window.__timelines["overlay"] = tl;
  </script>
</template>
`);

// ---- Captions from word timings.
const groups = [];
for (const sc of scenes) {
  const off = sc.start + LEAD;
  let words = sc.voice?.words?.map((w) => ({ text: w.text, start: off + w.start, end: off + w.end }));
  if (!words?.length) {
    const ws = sc.narr.join(" ").split(/\s+/).filter(Boolean), per = (sc.dur - 0.6) / ws.length;
    words = ws.map((w, i) => ({ text: w, start: off + i * per, end: off + (i + 1) * per }));
  }
  let g = [];
  const flush = () => {
    if (!g.length) return;
    const s = Math.max(sc.start + 0.1, g[0].start - 0.05), e = Math.min(sc.start + sc.dur, g.at(-1).end + 0.12);
    groups.push({ text: g.map((w) => w.text).join(" "), s: +s.toFixed(2), d: +(e - s).toFixed(2) }); g = [];
  };
  words.forEach((w) => { if (g.length && (w.start - g.at(-1).end >= 0.15 || g.length >= 4 || /[.,:;?!]$/.test(g.at(-1).text))) flush(); g.push(w); });
  flush();
}
for (let i = 1; i < groups.length; i++) { const p = groups[i - 1]; if (p.s + p.d > groups[i].s) p.d = +(groups[i].s - p.s).toFixed(2); }
const cid = (i) => `cap-${String(i + 1).padStart(3, "0")}`;
writeFileSync(join(proj, "compositions", "captions.html"), `<template>
  <style>
    #root { position: absolute; inset: 0; pointer-events: none; }
    .cap { position: absolute; left: 0; right: 0; top: 900px; text-align: center; overflow: visible; }
    .cap span { display: inline-block; padding: 8px 26px; border-radius: 14px; background: rgba(12,18,27,0.82); color: #ffffff; font-family: "Inter", sans-serif; font-size: 54px; font-weight: 700; letter-spacing: -0.01em; }
  </style>
  <div id="root" data-composition-id="captions" data-width="1920" data-height="1080">
${groups.map((g, i) => `    <div id="${cid(i)}" class="clip cap" data-start="${g.s}" data-duration="${g.d}" data-track-index="0"><span id="${cid(i)}-t">${esc(g.text)}</span></div>`).join("\n")}
  </div>
  <script>
    const tl = gsap.timeline({ paused: true });
${groups.map((g, i) => `    tl.fromTo("#${cid(i)}-t", { opacity: 0, y: 10 }, { opacity: 1, y: 0, duration: 0.1, ease: "power2.out" }, ${g.s});`).join("\n")}
    window.__timelines["captions"] = tl;
  </script>
</template>
`);

// ---- Root.
const hosts = scenes.map((sc) => {
  const id = sc.id.toLowerCase(), v = S[sc.id];
  let h = `      <div id="${id}" data-composition-id="${id}" data-composition-src="compositions/${id}.html" data-start="${sc.start}" data-duration="${sc.dur}" data-track-index="1" data-track-kind="graphics" data-width="1920" data-height="1080"></div>`;
  if (v.kind === "clip" && v.file) h += `\n      <video id="v-${id}" class="clip" src="${v.file}" muted playsinline data-start="${sc.start}" data-duration="${sc.dur}" data-track-index="2" style="position: absolute; left: 0; top: 0; width: 1920px; height: 1080px; object-fit: contain; z-index: 5"></video>`;
  return h;
}).join("\n");
const audio = scenes.filter((s) => s.voice).map((sc) => `      <audio id="vo-${sc.id.toLowerCase()}" class="clip" src="${sc.wav}" data-start="${+(sc.start + LEAD).toFixed(2)}" data-duration="${sc.voice.duration_s}" data-volume="1" data-track-index="5"></audio>`).join("\n");
writeFileSync(join(proj, "index.html"), `<!doctype html>
<html lang="en" data-resolution="landscape">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=1920, height=1080" />
    <title>Payminto short demo</title>
    <script src="https://cdn.jsdelivr.net/npm/gsap@3.15.0/dist/gsap.min.js"></script>
    <style>
      * { margin: 0; padding: 0; box-sizing: border-box; }
      html, body { margin: 0; width: 1920px; height: 1080px; overflow: hidden; background: #0c121b; }
    </style>
  </head>
  <body>
    <!-- Generated by build.mjs from ../SHORT_SCRIPT.md. Total ${total} s. -->
    <div id="root" data-composition-id="main" data-start="0" data-duration="${total}" data-width="1920" data-height="1080">
${hosts}
      <div id="overlay" data-composition-id="overlay" data-composition-src="compositions/overlay.html" data-start="0" data-duration="${total}" data-track-index="3" data-track-kind="graphics" data-width="1920" data-height="1080" style="z-index: 8"></div>
      <div id="captions" data-composition-id="captions" data-composition-src="compositions/captions.html" data-start="0" data-duration="${total}" data-track-index="4" data-track-kind="captions" data-width="1920" data-height="1080" style="z-index: 9"></div>
${audio}
    </div>
    <script>
      const tl = gsap.timeline({ paused: true });
      window.__timelines["main"] = tl;
    </script>
  </body>
</html>
`);

console.log(`scenes=${scenes.length} total=${total}s captions=${groups.length} voiced=${scenes.filter((s) => s.voice).length}/${scenes.length}`);
for (const sc of scenes) console.log(sc.id, "start", sc.start, "dur", sc.dur, sc.reuse ? `(voice reused S${sc.reuse})` : sc.voice ? "(new voice)" : "(no voice yet)", S[sc.id].missing ? "CLIP MISSING" : "");
for (const l of fitLog) console.log("  fit", l);
