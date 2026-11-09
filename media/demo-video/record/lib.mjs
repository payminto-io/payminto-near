// Recording harness for the Payminto demo video.
// Headless Chromium at 1920x1080 through playwright-core, a visible animated cursor,
// smooth scrolls, human-speed typing, and zoom and highlight hooks that follow
// STORYBOARD.md's motion rules. Each page is recorded as its own segment; the
// loading head of every segment is trimmed and the segments are joined into one
// 30 fps H.264 clip with ffmpeg.
import { chromium } from "playwright-core";
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
export const W = 1920, H = 1080, FPS = 30;

export function chromePath() {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  // The Chrome that HyperFrames already downloaded for rendering.
  return execFileSync("npx", ["-y", "hyperframes", "browser", "path"], { cwd: HERE, encoding: "utf8" }).trim().split("\n").at(-1);
}

// Injected into every page: the cursor, a highlight layer and banner hiding.
const INIT = `
(() => {
  const css = \`
    #__pm_cursor { position: fixed; left: 0; top: 0; width: 34px; height: 34px; z-index: 2147483647; pointer-events: none; transform: translate(-4px, -2px); transition: transform 60ms linear; }
    #__pm_cursor svg { filter: drop-shadow(0 2px 4px rgba(0,0,0,.45)); }
    #__pm_ring { position: fixed; width: 44px; height: 44px; margin: -22px 0 0 -22px; border-radius: 50%; border: 3px solid #2443b8; z-index: 2147483646; pointer-events: none; opacity: 0; }
    .__pm_hl { position: fixed; border: 4px solid #2443b8; border-radius: 12px; box-shadow: 0 0 0 9999px rgba(12,18,27,.28); z-index: 2147483645; pointer-events: none; opacity: 0; transition: opacity 300ms ease; }
    html.__pm_zoom { transition: transform 400ms cubic-bezier(.65,0,.35,1); }
    /* Next.js dev overlay on the local dashboard. */
    nextjs-portal, [data-nextjs-toast], #__next-build-watcher { display: none !important; }
    /* Explorer ad slots. */
    [id^="adBanner"], .sevioads, [class*="sevio" i] { display: none !important; }
    /* Cookie and consent banners: hidden visually; nothing is accepted or declined. */
    #onetrust-consent-sdk, #CybotCookiebotDialog, .cc-window, .cookie-banner, .cookieConsent, #cookieconsent, [id*="cookie" i][class*="banner" i], [class*="cookie-consent" i], [aria-label*="cookie" i][role="dialog"] { display: none !important; }
  \`;
  const add = () => {
    if (document.getElementById("__pm_cursor")) return;
    const st = document.createElement("style"); st.textContent = css; document.documentElement.appendChild(st);
    const c = document.createElement("div"); c.id = "__pm_cursor";
    c.innerHTML = '<svg width="34" height="34" viewBox="0 0 24 24"><path d="M4 2 L4 20 L9 15 L12.5 22 L15.5 20.6 L12 13.8 L19 13.8 Z" fill="#ffffff" stroke="#0c121b" stroke-width="1.4" stroke-linejoin="round"/></svg>';
    const r = document.createElement("div"); r.id = "__pm_ring";
    document.documentElement.appendChild(c); document.documentElement.appendChild(r);
    const pos = window.__pm_pos || { x: ${W / 2}, y: ${H / 2} };
    c.style.transform = "translate(" + (pos.x - 4) + "px," + (pos.y - 2) + "px)";
    addEventListener("mousemove", (e) => { window.__pm_pos = { x: e.clientX, y: e.clientY }; c.style.transform = "translate(" + (e.clientX - 4) + "px," + (e.clientY - 2) + "px)"; }, true);
    addEventListener("mousedown", (e) => {
      r.style.left = e.clientX + "px"; r.style.top = e.clientY + "px";
      r.animate([{ opacity: .9, transform: "scale(.4)" }, { opacity: 0, transform: "scale(1.4)" }], { duration: 450, easing: "ease-out" });
    }, true);
  };
  if (document.readyState === "loading") addEventListener("DOMContentLoaded", add); else add();
})();
`;

// First visible match of a selector.
const vis = (page, sel) => page.locator(sel).filter({ visible: true }).first();

const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

// Helpers handed to every shot script.
function helpers(page) {
  let cur = { x: W / 2, y: H / 2 };
  const h = {
    page,
    wait: (ms) => page.waitForTimeout(ms),
    // Move the cursor along an eased path, about 60 steps a second.
    async moveTo(target, ms = 700) {
      let x, y;
      if (typeof target === "string") {
        const box = await vis(page, target).boundingBox();
        if (!box) throw new Error("moveTo: not visible: " + target);
        x = box.x + box.width / 2; y = box.y + box.height / 2;
      } else ({ x, y } = target);
      const steps = Math.max(8, Math.round(ms / 16)), from = { ...cur };
      for (let i = 1; i <= steps; i++) {
        const k = ease(i / steps);
        await page.mouse.move(from.x + (x - from.x) * k, from.y + (y - from.y) * k);
        await page.waitForTimeout(ms / steps);
      }
      cur = { x, y };
    },
    async click(target, ms = 700) { await h.moveTo(target, ms); await page.waitForTimeout(120); await page.mouse.down(); await page.waitForTimeout(70); await page.mouse.up(); },
    // Human-speed typing: 90 to 150 ms a key, deterministic jitter.
    async type(target, text) {
      if (target) await h.click(target);
      for (let i = 0; i < text.length; i++) await page.keyboard.type(text[i], { delay: 90 + ((i * 37) % 60) });
    },
    // Smooth scroll by px over ms (eased, frame by frame).
    async scrollBy(px, ms = 900) {
      await page.evaluate(async ({ px, ms }) => {
        const start = scrollY, t0 = performance.now();
        const e = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
        await new Promise((res) => { const f = (now) => { const t = Math.min(1, (now - t0) / ms); scrollTo(0, start + px * e(t)); t < 1 ? requestAnimationFrame(f) : res(); }; requestAnimationFrame(f); });
      }, { px, ms });
    },
    async scrollTo(selector, ms = 900, offset = 200) {
      const y = await vis(page, selector).evaluate((el, off) => el.getBoundingClientRect().top - off, offset);
      await h.scrollBy(y, ms);
    },
    // Punch-in zoom on an element (STORYBOARD: 1.6x, 0.4 s in, hold, 0.4 s out).
    async zoom(selector, scale = 1.6, holdMs = 1200) {
      const box = await vis(page, selector).boundingBox();
      if (!box) return;
      const ox = box.x + box.width / 2, oy = box.y + box.height / 2 + (await page.evaluate(() => scrollY));
      await page.evaluate(({ ox, oy, scale }) => { const d = document.documentElement; d.classList.add("__pm_zoom"); d.style.transformOrigin = ox + "px " + oy + "px"; d.style.transform = "scale(" + scale + ")"; }, { ox, oy, scale });
      await page.waitForTimeout(400 + holdMs);
      await page.evaluate(() => { document.documentElement.style.transform = "scale(1)"; });
      await page.waitForTimeout(400);
    },
    // Highlight box (STORYBOARD: 4 px cobalt, 0.3 s in) around an element for ms.
    async highlight(selector, ms = 1200, pad = 8) {
      const box = await vis(page, selector).boundingBox();
      if (!box) return;
      await page.evaluate(({ b, pad }) => {
        const d = document.createElement("div"); d.className = "__pm_hl";
        Object.assign(d.style, { left: b.x - pad + "px", top: b.y - pad + "px", width: b.width + 2 * pad + "px", height: b.height + 2 * pad + "px" });
        document.documentElement.appendChild(d); requestAnimationFrame(() => (d.style.opacity = "1")); window.__pm_last_hl = d;
      }, { b: box, pad });
      await page.waitForTimeout(ms);
      await page.evaluate(() => { const d = window.__pm_last_hl; if (d) { d.style.opacity = "0"; setTimeout(() => d.remove(), 320); } });
      await page.waitForTimeout(320);
    },
  };
  return h;
}

// Wait until a page is really ready: the text is there and no skeleton or spinner is visible.
export async function settle(page, { text, timeout = 30000 } = {}) {
  if (text) await page.getByText(text, { exact: false }).first().waitFor({ timeout });
  await page.waitForFunction(() => {
    const sel = '[data-slot="skeleton"], .animate-pulse, .animate-spin, [class*="skeleton" i], [class*="spinner" i], [class*="loading" i], [aria-busy="true"]';
    return [...document.querySelectorAll(sel)].filter((el) => !el.hasAttribute("data-loaded") && getComputedStyle(el).animationName !== "none").every((el) => { const r = el.getBoundingClientRect(); const cs = getComputedStyle(el); return r.width === 0 || r.height === 0 || r.bottom < 0 || r.top > innerHeight || cs.visibility === "hidden" || cs.display === "none" || cs.opacity === "0"; });
  }, null, { timeout: Math.min(timeout, 15000) }).catch(() => console.warn("  settle: a loading element is still visible in view on", page.url()));
  await page.waitForTimeout(400);
}

// Record one shot made of segments. `segments` is [{ name, url, ready: {text}, act: async (h) => {} }].
export async function recordShot(shotId, segments, { outDir = join(HERE, "out"), keepSegments = false, storageState } = {}) {
  const work = join(outDir, ".work", shotId);
  rmSync(work, { recursive: true, force: true }); mkdirSync(work, { recursive: true });
  const browser = await chromium.launch({ executablePath: chromePath(), headless: true, args: ["--hide-scrollbars", "--force-color-profile=srgb"] });
  const parts = [];
  try {
    for (const [i, seg] of segments.entries()) {
      // seg.scale > 1 enlarges the page with CSS zoom on <body>; the cursor, labels and highlights sit outside <body> and stay 1:1.
      const ctx = await browser.newContext({ viewport: { width: W, height: H }, deviceScaleFactor: 1, colorScheme: seg.colorScheme || "light", recordVideo: { dir: work, size: { width: W, height: H } }, ...(storageState && existsSync(storageState) ? { storageState } : {}) });
      await ctx.addInitScript(INIT);
      // seg.view picks the business (or "platform") the dashboard shows, as its switcher would: payminto.view.
      if (seg.view) await ctx.addInitScript(`try { localStorage.setItem("payminto.view", ${JSON.stringify(seg.view)}); } catch {}`);
      if (seg.scale && seg.scale !== 1) await ctx.addInitScript(`addEventListener("DOMContentLoaded", () => { document.body.style.zoom = "${seg.scale}"; });`);
      const page = await ctx.newPage();
      const t0 = Date.now();
      // Public explorers are sometimes slow: on a failed load, start the segment again in a fresh context.
      try { await page.goto(seg.url, { waitUntil: "domcontentloaded", timeout: 60000 }); }
      catch (e) { await ctx.close().catch(() => {}); seg.__tries = (seg.__tries || 0) + 1; if (seg.__tries >= 4) throw e; console.warn(`  retry ${seg.__tries}: ${seg.url}`); await new Promise((r) => setTimeout(r, 3000)); segments.splice(i + 1, 0, seg); continue; }
      await settle(page, seg.ready || {});
      if (seg.css) await page.addStyleTag({ content: seg.css });
      // Remove promotional strips (not consent dialogs) whose text matches seg.hideText.
      for (const t of seg.hideText || []) await page.evaluate((t) => { for (const el of document.querySelectorAll("div, section, aside")) { const txt = el.innerText?.trim() || ""; if (txt.startsWith(t) && txt.length < 160) { el.style.display = "none"; } } }, t);
      if (seg.label) await page.evaluate(({ text, sub }) => {
        const d = document.createElement("div");
        d.innerHTML = '<b style="display:block;font:800 30px Inter,system-ui,sans-serif;color:#fff">' + text + '</b>' + (sub ? '<span style="display:block;margin-top:4px;font:500 22px ui-monospace,Menlo,monospace;color:#c9d3fb">' + sub + '</span>' : "");
        Object.assign(d.style, { position: "fixed", right: "40px", top: "160px", padding: "16px 24px", borderRadius: "16px", background: "rgba(36,67,184,.94)", zIndex: 2147483644, boxShadow: "0 10px 30px rgba(0,0,0,.25)" });
        document.documentElement.appendChild(d);
      }, seg.label);
      await page.waitForTimeout(250);
      const head = (Date.now() - t0) / 1000;
      const h = helpers(page);
      const a0 = Date.now();
      if (seg.act) await seg.act(h);
      // A segment with ms gets exactly that length: pad with a hold, or cut the tail.
      let body = (Date.now() - a0) / 1000;
      if (seg.ms) { if (body * 1000 < seg.ms) await page.waitForTimeout(seg.ms - body * 1000); body = seg.ms / 1000; }
      const video = page.video();
      await ctx.close();
      const src = await video.path();
      parts.push({ src, head, body, name: seg.name || `seg${i}` });
      console.log(`  ${shotId} ${seg.name || i}: loaded in ${head.toFixed(1)} s, kept ${body.toFixed(1)} s`);
    }
  } finally { await browser.close(); }

  // Trim each segment's loading head, normalise to 30 fps, join.
  const list = [];
  for (const [i, p] of parts.entries()) {
    const out = join(work, `part-${String(i).padStart(2, "0")}.mp4`);
    execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-ss", p.head.toFixed(3), "-i", p.src, "-t", p.body.toFixed(3), "-vf", `fps=${FPS},scale=${W}:${H}:flags=lanczos,format=yuv420p`, "-an", "-c:v", "libx264", "-preset", "medium", "-crf", "16", out]);
    list.push(`file '${out}'`);
  }
  writeFileSync(join(work, "list.txt"), list.join("\n") + "\n");
  const final = join(outDir, `${shotId}.mp4`);
  execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", join(work, "list.txt"), "-c", "copy", "-movflags", "+faststart", final]);
  if (!keepSegments) rmSync(work, { recursive: true, force: true });
  const dur = execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", final], { encoding: "utf8" }).trim();
  console.log(`✓ ${final} (${(+dur).toFixed(2)} s)`);
  return final;
}

// Sign in to the local dashboard once with a demo test account and save the session for the shots.
// Credentials come from the demo run's dashboard-logins.json (local test accounts); they are never printed.
export async function signIn({ baseUrl, email, password, statePath }) {
  const browser = await chromium.launch({ executablePath: chromePath(), headless: true });
  try {
    const ctx = await browser.newContext({ viewport: { width: W, height: H } });
    const page = await ctx.newPage();
    await page.goto(`${baseUrl}/login`, { waitUntil: "domcontentloaded", timeout: 60000 });
    await page.locator('input[type="email"]').first().fill(email);
    await page.locator('input[type="password"]').first().fill(password);
    await page.getByRole("button", { name: /^Sign in$/ }).click();
    await page.waitForURL((u) => !u.pathname.startsWith("/login"), { timeout: 30000 });
    await ctx.storageState({ path: statePath });
    console.log(`  signed in as ${email}; session saved for this run`);
  } finally { await browser.close(); }
}
