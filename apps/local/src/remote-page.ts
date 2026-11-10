/** The agent remote's one page. Plain HTML, CSS and script: no build step, light and dark, usable at 375px. */
export const REMOTE_PAGE = /* html */ `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Agent remote - Payminto local</title>
<style>
  :root { color-scheme: light dark; --bg:#f7f7f5; --card:#fff; --ink:#16181d; --muted:#5d6370; --line:#e3e4e8; --accent:#1d4ed8; --accent-ink:#fff; --ok:#0f7a4d; --ok-soft:#e6f4ec; --no:#b3261e; --no-soft:#fbeae8; --warn:#8a5a00; --warn-soft:#fdf3d8; }
  @media (prefers-color-scheme: dark) { :root { --bg:#101216; --card:#181b21; --ink:#eceef2; --muted:#9aa1ad; --line:#2a2e37; --accent:#7aa2ff; --accent-ink:#0b1020; --ok:#4cc38a; --ok-soft:#12261c; --no:#ff8a80; --no-soft:#2c1614; --warn:#f2c46b; --warn-soft:#2a2210; } }
  * { box-sizing: border-box; }
  body { margin:0; background:var(--bg); color:var(--ink); font:15px/1.5 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif; }
  main { max-width: 880px; margin: 0 auto; padding: 24px 16px 64px; }
  h1 { font-size: 22px; line-height: 28px; margin: 0; letter-spacing: -0.01em; }
  h2 { font-size: 15px; margin: 0 0 4px; }
  p { margin: 0; }
  .muted { color: var(--muted); }
  .small { font-size: 13px; line-height: 18px; }
  .mono { font-family: ui-monospace,SFMono-Regular,Menlo,monospace; font-size: 12.5px; overflow-wrap: anywhere; }
  .top { display:flex; flex-wrap:wrap; align-items:center; gap:8px 12px; margin-bottom: 6px; }
  .badge { display:inline-flex; align-items:center; border-radius:999px; padding:2px 10px; font-size:12px; font-weight:600; background:var(--warn-soft); color:var(--warn); }
  section { background:var(--card); border:1px solid var(--line); border-radius:14px; padding:16px; margin-top:16px; }
  .stack { display:flex; flex-direction:column; gap:10px; margin-top:12px; }
  label.pick { display:grid; grid-template-columns:auto 1fr; gap:4px 12px; align-items:start; border:1px solid var(--line); border-radius:12px; padding:12px; cursor:pointer; }
  label.pick:has(input:checked) { border-color: var(--accent); box-shadow: 0 0 0 1px var(--accent); }
  label.pick input { margin-top:4px; accent-color: var(--accent); }
  .row { display:grid; grid-template-columns: 1fr auto; gap: 6px 16px; align-items:center; border-top:1px solid var(--line); padding:12px 0; }
  .row:first-child { border-top:0; padding-top:0; }
  .row:last-child { padding-bottom:0; }
  button { font: inherit; font-weight:600; min-height:44px; padding:0 16px; border-radius:10px; border:1px solid var(--accent); background:var(--accent); color:var(--accent-ink); cursor:pointer; }
  button.ghost { background:transparent; color:var(--accent); min-height:32px; padding:0 10px; font-size:13px; }
  button:disabled { opacity:.55; cursor:progress; }
  button:focus-visible, a:focus-visible, input:focus-visible { outline:2px solid var(--accent); outline-offset:2px; }
  a { color: var(--accent); text-underline-offset: 3px; }
  .check { display:flex; gap:10px; align-items:flex-start; margin-top:14px; }
  .check input { margin-top:4px; width:16px; height:16px; accent-color: var(--accent); }
  .result { border:1px solid var(--line); border-radius:12px; padding:12px; }
  .result.ok { border-color: color-mix(in srgb, var(--ok) 40%, transparent); background: var(--ok-soft); }
  .result.no { border-color: color-mix(in srgb, var(--no) 40%, transparent); background: var(--no-soft); }
  .result.wait { border-color: color-mix(in srgb, var(--warn) 40%, transparent); background: var(--warn-soft); }
  .result strong.ok { color: var(--ok); } .result strong.no { color: var(--no); } .result strong.wait { color: var(--warn); }
  .keyrow { display:flex; flex-wrap:wrap; gap:8px; align-items:center; border-top:1px solid var(--line); padding:10px 0; }
  .keyrow:first-of-type { border-top:0; }
  .empty { border:1px dashed var(--line); border-radius:12px; padding:16px; text-align:center; }
  @media (max-width: 520px) { .row { grid-template-columns: 1fr; } .row button { width:100%; } }
</style>
</head>
<body>
<main>
  <div class="top"><h1>Agent remote</h1><span class="badge">Local development tool</span></div>
  <p class="muted">This page plays an agent's runtime. It holds the agent keys of the Budgets on this local stack and makes paid calls with the real Payminto SDK: the service answers 402, the agent signs a voucher, the node decides. Nothing here reaches a public network.</p>

  <section aria-labelledby="h-budget">
    <h2 id="h-budget">1. Pay from this Budget</h2>
    <p class="muted small">Only Budgets whose agent key this page holds are listed. A Budget you open in the dashboard with a spare key from below appears here once the node has registered it.</p>
    <div id="budgets" class="stack" role="radiogroup" aria-labelledby="h-budget"><p class="muted small">Loading Budgets...</p></div>
    <label class="check"><input type="checkbox" id="guard"><span><strong>Check the Budget's rules in the agent before signing</strong><br><span class="muted small">On, the SDK refuses a call that breaks a rule and signs nothing, as a healthy agent does. Off, the agent signs anyway, as a compromised agent would, so the node is the one that refuses, and the refusal shows up in the dashboard under Blocked.</span></span></label>
  </section>

  <section aria-labelledby="h-services">
    <h2 id="h-services">2. Call a paid service</h2>
    <p class="muted small">Each call is one HTTP request that costs the listed price. One of these waits for the owner's approval, and two are meant to be refused.</p>
    <div id="services" class="stack"><p class="muted small">Loading services...</p></div>
  </section>

  <section aria-labelledby="h-results" aria-live="polite">
    <h2 id="h-results">3. What happened</h2>
    <div id="results" class="stack"><div class="empty muted small">No calls yet. Pick a Budget and call a service.</div></div>
  </section>

  <section aria-labelledby="h-keys">
    <h2 id="h-keys">Open your own Budget</h2>
    <p class="muted small">A Budget names an agent's public key. In the dashboard, open Budgets, then New budget, and paste one of these as the agent public key. This page keeps the secret half, so it can then pay from that Budget.</p>
    <div id="keys" style="margin-top:8px"></div>
  </section>
</main>
<script>
const $ = (id) => document.getElementById(id);
const usdc = (atomic) => { const s = String(atomic).padStart(7, "0"); const whole = s.slice(0, -6); const frac = s.slice(-6).replace(/0+$/, "").padEnd(2, "0"); return whole + "." + frac + " USDC"; };
const STATUS = { open: "Active", active: "Active", revoked: "Revoked", expired: "Expired" };
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
let state = null, chosen = null, first = true;

async function load() {
  try {
    const res = await fetch("/remote/state");
    if (!res.ok) throw new Error("status " + res.status);
    state = await res.json();
  } catch (e) {
    $("budgets").innerHTML = '<p class="small" style="color:var(--no)">The local stack is not answering (' + esc(e.message) + '). Is pnpm local still running?</p>';
    return;
  }
  if (!chosen || !state.budgets.some((b) => b.id === chosen)) chosen = state.budgets[0] ? state.budgets[0].id : null;
  $("budgets").innerHTML = state.budgets.length ? state.budgets.map((b) =>
    '<label class="pick"><input type="radio" name="budget" value="' + b.id + '"' + (b.id === chosen ? " checked" : "") + '>' +
    '<span><strong>' + esc(b.label) + '</strong> <span class="muted small">' + esc(STATUS[b.status] || b.status) + '</span><br>' +
    '<span class="muted small">Owner ' + esc(b.owner) + ' - limit per call ' + usdc(b.perCallCap) + ' - escrow ' + (b.escrow === null ? "not read by the node yet" : usdc(b.escrow)) + '</span><br>' +
    '<span class="muted small">May pay: ' + (b.payees.length ? b.payees.map(esc).join(", ") : "any payee") + '</span></span></label>').join("")
    : '<div class="empty muted small">No Budget uses a key held here yet.</div>';
  if (first) {
    $("services").innerHTML = state.services.map((s) =>
      '<div class="row"><div><strong>' + esc(s.name) + '</strong> <span class="muted">' + usdc(s.priceAtomic) + ' per call</span><br><span class="muted small">' + esc(s.note) + '</span></div>' +
      '<button type="button" data-service="' + esc(s.id) + '">Call ' + esc(s.name) + '</button></div>').join("");
    first = false;
  }
  $("keys").innerHTML = state.spareKeys.length ? state.spareKeys.map((k) =>
    '<div class="keyrow"><span class="small" style="min-width:5.5rem">' + esc(k.name) + '</span><span class="mono" style="flex:1 1 16rem">' + esc(k.publicKey) + '</span><button type="button" class="ghost" data-copy="' + esc(k.publicKey) + '">Copy key</button></div>').join("")
    : '<p class="muted small">Both spare keys are in use.</p>';
}

document.addEventListener("change", (e) => { if (e.target.name === "budget") chosen = e.target.value; });
document.addEventListener("click", async (e) => {
  const copy = e.target.closest("[data-copy]");
  if (copy) {
    try { await navigator.clipboard.writeText(copy.dataset.copy); copy.textContent = "Copied"; } catch { copy.textContent = "Select and copy"; }
    setTimeout(() => (copy.textContent = "Copy key"), 1500);
    return;
  }
  const btn = e.target.closest("[data-service]");
  if (!btn) return;
  if (!chosen) { show('<div class="result no"><strong class="no">Pick a Budget first.</strong></div>'); return; }
  const service = state.services.find((s) => s.id === btn.dataset.service);
  const budget = state.budgets.find((b) => b.id === chosen);
  const label = btn.textContent;
  btn.disabled = true; btn.textContent = "Calling...";
  try {
    const res = await fetch("/remote/call", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ budgetId: chosen, serviceId: service.id, guard: $("guard").checked }) });
    const r = await res.json();
    const when = new Date().toLocaleTimeString();
    const head = '<span class="muted small">' + when + ' - ' + esc(budget.label) + ' called ' + esc(service.name) + '</span><br>';
    if (r.ok) show('<div class="result ok">' + head + '<strong class="ok">Paid ' + usdc(r.priceAtomic) + ' to ' + esc(service.payee) + '</strong><br><span class="small">The node accepted the voucher and signed a receipt. Call id <span class="mono">' + esc(r.callId) + '</span></span><br><a class="small" target="_blank" rel="noreferrer" href="' + state.dashboard + '/receipts/' + r.callId + '">Open this call in the dashboard</a></div>');
    else if (r.refused && r.rule === "PAYEE_NEEDS_APPROVAL") show('<div class="result wait">' + head + '<strong class="wait">Waiting for the owner to approve ' + esc(service.payee) + '</strong><br><span class="small">Rule <span class="mono">PAYEE_NEEDS_APPROVAL</span>: ' + esc(r.message) + '</span><br><span class="small">Nothing was paid. The owner approves a payee on the page of the Budget in the dashboard; call again after that.</span><br><a class="small" target="_blank" rel="noreferrer" href="' + state.dashboard + '/budgets/' + esc(chosen) + '">Approve it on the Budget page in the dashboard</a></div>');
    else if (r.refused) show('<div class="result no">' + head + '<strong class="no">Refused by the ' + (r.by === "agent" ? "agent's own SDK guard: nothing was signed" : "node") + '</strong><br><span class="small">Rule <span class="mono">' + esc(r.rule) + '</span>: ' + esc(r.message) + '</span><br>' + (r.by === "agent" ? '<span class="muted small">The node never saw this call, so the dashboard has no record of it. Turn the agent check off to let the node refuse it.</span>' : '<a class="small" target="_blank" rel="noreferrer" href="' + state.dashboard + '/blocked">Read the reason in the dashboard under Blocked</a>') + '</div>');
    else show('<div class="result no">' + head + '<strong class="no">The call did not complete</strong><br><span class="small">' + esc(r.message || (r.error && r.error.message) || "unknown error") + '</span></div>');
  } catch (err) {
    show('<div class="result no"><strong class="no">The local stack did not answer</strong><br><span class="small">' + esc(err.message) + '</span></div>');
  } finally {
    btn.disabled = false; btn.textContent = label;
    load();
  }
});
function show(html) {
  const box = $("results");
  if (box.querySelector(".empty")) box.innerHTML = "";
  box.insertAdjacentHTML("afterbegin", html);
}
load();
setInterval(load, 5000);
</script>
</body>
</html>`;
