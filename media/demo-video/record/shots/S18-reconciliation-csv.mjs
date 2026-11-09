// S18: download the reconciliation report and show its columns.
// The CSV is rendered into a simple table page so its columns can be swept and highlighted.
export const needs = [];
export const segments = (cfg) => [{
  name: "report", url: `${cfg.BASE_URL}/payments`, ready: { text: "Download report" },
  act: async (h) => {
    const dl = h.page.waitForEvent("download", { timeout: 30000 });
    await h.click("text=Download report", 700);
    // The button opens a date-range dialog; its submit button downloads the CSV.
    await h.wait(700);
    await h.click('[role="dialog"] button[type="submit"]', 800);
    const file = await (await dl).path();
    const csv = (await import("node:fs")).readFileSync(file, "utf8").split("\n").slice(0, 12).map((r) => r.split(",").map((c) => c.replace(/^"|"$/g, "")));
    const html = "<table style='font:20px Inter,sans-serif;border-collapse:collapse;margin:60px'>" + csv.map((r, i) => "<tr>" + r.map((c) => `<${i ? "td" : "th"} style='border:1px solid #e1e4ea;padding:8px 12px;white-space:nowrap'>${c}</${i ? "td" : "th"}>`).join("") + "</tr>").join("") + "</table>";
    await h.page.setContent(html); await h.wait(600);
    for (const col of ["fee", "net", "tx", "proof"]) { const sel = `th:has-text("${col}")`; if (await h.page.locator(sel).count()) { await h.page.locator(sel).first().scrollIntoViewIfNeeded(); await h.highlight(sel, 700); } }
  },
}];
