// S11: the buyer agent in a terminal. A real terminal is best recorded with a screen recorder.
// This script instead replays a saved run log (record/logs/S11-buyer.txt, the CLI output of the
// real run) in a terminal-styled page with human-speed typing for the command, so the shot is
// reproducible. Save the log with: pnpm agent run "<TASK>" 2>&1 | tee media/demo-video/record/logs/S11-buyer.txt
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
export const needs = ["TASK"];
const LOG = join(dirname(fileURLToPath(import.meta.url)), "..", "logs", "S11-buyer.txt");
export const segments = (cfg) => {
  const log = readFileSync(LOG, "utf8").split("\n").slice(0, 40);
  const html = `<html><body style="margin:0;background:#0c121b;color:#e6eaf0;font:26px/1.5 'JetBrains Mono',Menlo,monospace;padding:150px 120px 80px"><div id="t"><span style="color:#8ea2f5">$ </span><textarea id="cmd" rows="2" spellcheck="false" style="all:unset;display:inline-block;vertical-align:top;width:1560px;white-space:pre-wrap;word-break:normal;overflow-wrap:break-word;resize:none;overflow:hidden;height:3em;line-height:1.5"></textarea></div><pre id="out" style="white-space:pre-wrap;margin-top:24px"></pre></body></html>`;
  return [{
    name: "buyer", url: "data:text/html," + encodeURIComponent(html),
    act: async (h) => {
      await h.type("#cmd", `PAYMINTO_AGENT_PROVIDER=replicate pnpm agent run "${cfg.ids.TASK}"`);
      await h.wait(400);
      for (const line of log) { await h.page.evaluate((l) => { document.getElementById("out").textContent += l + "\n"; }, line); await h.wait(220); }
      await h.highlight("#out", 1200);
    },
  }];
};
