/**
 * The live page: plain HTML, CSS and one script from `public/`, no build step. The run's events are recorded here and
 * streamed over server-sent events; a page that connects late gets every event so far, then follows live.
 */
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { listen, type Listening } from "@payminto/demo";
import { SWARM_DIR } from "./config.ts";
import { verifyRound } from "./rules.ts";
import type { SwarmEvent } from "./run.ts";

export class PortInUseError extends Error {
  constructor(port: number) {
    super(`port ${port} on 127.0.0.1 is already in use, perhaps by another \`pnpm swarm --serve\`.\nWhat to do: stop that process, or pass --port 0 to let the system choose a free port, or --port <n> for one you know is free.`);
    this.name = "PortInUseError";
  }
}

/** A live check of one round's receipt against the hub of the running process. */
export type LiveReceiptCheck = (roundNumber: number) => Promise<{ ok: boolean; lines: Array<{ ok: boolean | null; what: string; detail: string }> } | null>;

export type PageServer = {
  url: string;
  port: number;
  push(e: SwarmEvent): void;
  /** Resolves when the first page (or any client of /events) connects. */
  viewer: Promise<void>;
  setLiveReceiptCheck(check: LiveReceiptCheck): void;
  close(): Promise<void>;
};

const PUBLIC = resolve(SWARM_DIR, "public");
const STATIC: Record<string, { file: string; type: string }> = {
  "/": { file: "index.html", type: "text/html; charset=utf-8" },
  "/swarm.css": { file: "swarm.css", type: "text/css; charset=utf-8" },
  "/swarm.js": { file: "swarm.js", type: "text/javascript; charset=utf-8" },
};
/** Only the files a run writes can be fetched from the output directory. */
const RUN_FILE = /^round-[0-9]{1,3}(\.receipt(\.tampered)?)?\.json$/;

export async function startPage(o: { port: number; outDir: string; chainLabel: string }): Promise<PageServer> {
  const events: SwarmEvent[] = [];
  const wakers = new Set<() => void>();
  let closed = false;
  let live: LiveReceiptCheck | null = null;
  let arrived!: () => void;
  const viewer = new Promise<void>((r) => (arrived = r));

  const app = new Hono();
  for (const [path, s] of Object.entries(STATIC)) {
    // Read on every request: the files are small, and an edit shows on reload with no restart.
    app.get(path, (c) => c.body(readFileSync(join(PUBLIC, s.file)), 200, { "content-type": s.type, "cache-control": "no-store" }));
  }
  app.get("/healthz", (c) => c.json({ ok: true, events: events.length }));
  app.get("/api/events", (c) => c.json(events));
  app.get("/files/:name", (c) => {
    const name = c.req.param("name");
    if (!RUN_FILE.test(name)) return c.json({ error: { code: "NOT_FOUND", message: "only round-<n>.json, round-<n>.receipt.json and round-<n>.receipt.tampered.json are served" } }, 404);
    try {
      return c.body(readFileSync(join(o.outDir, name)), 200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
    } catch {
      return c.json({ error: { code: "NOT_WRITTEN", message: `${name} is not written yet; it appears when its round is delivered and settled` } }, 404);
    }
  });
  app.get("/api/rounds/:n/verify", (c) => {
    const name = `round-${c.req.param("n")}.json`;
    if (!RUN_FILE.test(name)) return c.json({ error: { code: "NOT_FOUND", message: "no such round" } }, 404);
    try {
      const v = verifyRound(JSON.parse(readFileSync(join(o.outDir, name), "utf8")));
      return c.json({ ok: v.ok, checks: v.checks });
    } catch {
      return c.json({ error: { code: "NOT_WRITTEN", message: `${name} is not written yet` } }, 404);
    }
  });
  app.get("/api/receipts/:n", async (c) => {
    const n = Number(c.req.param("n"));
    const name = `round-${n}.receipt.json`;
    if (!Number.isInteger(n) || !RUN_FILE.test(name)) return c.json({ error: { code: "NOT_FOUND", message: "no such round" } }, 404);
    let file: unknown;
    try {
      file = JSON.parse(readFileSync(join(o.outDir, name), "utf8"));
    } catch {
      return c.json({ error: { code: "NOT_WRITTEN", message: "this round's receipt proof is written after settlement" } }, 404);
    }
    const check = live ? await live(n).catch(() => null) : null;
    return c.json({ file, chain: o.chainLabel, live: check });
  });
  app.get("/events", (c) =>
    streamSSE(c, async (stream) => {
      // A browser that reconnects says which event it saw last, and gets only what came after.
      const last = Number(c.req.header("last-event-id"));
      let next = Number.isInteger(last) && last >= 0 ? last + 1 : 0;
      let open = true;
      let wake: () => void = () => {};
      const waker = () => wake();
      wakers.add(waker);
      stream.onAbort(() => {
        open = false;
        wake();
      });
      arrived();
      try {
        while (open && !closed) {
          while (next < events.length && open) {
            await stream.writeSSE({ id: String(next), data: JSON.stringify(events[next]) });
            next++;
          }
          let timer: NodeJS.Timeout | undefined;
          const woken = await new Promise<boolean>((r) => {
            wake = () => r(true);
            timer = setTimeout(() => r(false), 15_000);
          });
          clearTimeout(timer);
          // A comment line keeps proxies and the browser from closing an idle stream.
          if (!woken && open && !closed) await stream.writeSSE({ event: "ping", data: "" });
        }
      } finally {
        wakers.delete(waker);
      }
    }),
  );

  let listening: Listening;
  try {
    listening = await listen(app, o.port);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EADDRINUSE") throw new PortInUseError(o.port);
    throw err;
  }
  return {
    url: listening.url,
    port: listening.port,
    viewer,
    push(e) {
      events.push(e);
      for (const w of wakers) w();
    },
    setLiveReceiptCheck(check) {
      live = check;
    },
    async close() {
      closed = true;
      for (const w of wakers) w();
      await listening.close();
    },
  };
}
