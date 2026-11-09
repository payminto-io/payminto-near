/**
 * A local stand-in for a model provider's HTTP API: node:http on 127.0.0.1 with a random port. Each test queues the
 * answers it wants (JSON, an SSE stream, or an error with headers) and reads back the requests the adapter sent.
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

export type SeenRequest = { method: string; path: string; headers: IncomingMessage["headers"]; body: any };

export type MockAnswer =
  | { status?: number; headers?: Record<string, string>; json: unknown }
  | { status?: number; headers?: Record<string, string>; text: string }
  | { sse: Array<{ event?: string; data: unknown }> }
  /** Accepts the request and never answers (timeouts and aborts). */
  | { hang: true };

export type MockProvider = {
  url: string;
  requests: SeenRequest[];
  /** Answers in order; a function answers by request (for routing by path). */
  answer(...a: Array<MockAnswer | ((r: SeenRequest) => MockAnswer)>): void;
  close(): Promise<void>;
};

export async function mockProvider(): Promise<MockProvider> {
  const queue: Array<MockAnswer | ((r: SeenRequest) => MockAnswer)> = [];
  const requests: SeenRequest[] = [];
  const open = new Set<ServerResponse>();
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const raw = Buffer.concat(chunks).toString("utf8");
    let body: unknown = raw;
    try {
      body = raw ? JSON.parse(raw) : null;
    } catch {
      // keep the raw text
    }
    const seen: SeenRequest = { method: req.method ?? "GET", path: req.url ?? "/", headers: req.headers, body };
    requests.push(seen);
    const next = queue.shift();
    const a = typeof next === "function" ? next(seen) : next;
    if (!a) {
      res.writeHead(500, { "content-type": "application/json" }).end(JSON.stringify({ error: { message: `mock provider: nothing queued for ${seen.method} ${seen.path}` } }));
      return;
    }
    if ("hang" in a) {
      open.add(res);
      res.on("close", () => open.delete(res));
      return;
    }
    if ("sse" in a) {
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      for (const e of a.sse) res.write(`${e.event ? `event: ${e.event}\n` : ""}data: ${JSON.stringify(e.data)}\n\n`);
      res.end();
      return;
    }
    const status = a.status ?? 200;
    if ("json" in a) res.writeHead(status, { "content-type": "application/json", ...a.headers }).end(JSON.stringify(a.json));
    else res.writeHead(status, { "content-type": "text/plain", ...a.headers }).end(a.text);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    answer: (...a) => queue.push(...a),
    async close() {
      for (const r of open) r.destroy();
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
    },
  };
}

/** The SSE events of one streamed Claude message, built from simple blocks. */
export function claudeStream(o: {
  model?: string;
  blocks: Array<{ type: "text"; text: string } | { type: "tool_use"; id: string; name: string; json: string } | { type: "thinking"; thinking: string; signature: string }>;
  stop: string;
  stopDetails?: unknown;
  usage?: { input: number; output: number; cacheRead?: number; cacheWrite?: number };
}): Array<{ event: string; data: unknown }> {
  const u = o.usage ?? { input: 10, output: 5 };
  const out: Array<{ event: string; data: unknown }> = [
    {
      event: "message_start",
      data: {
        type: "message_start",
        message: {
          id: "msg_mock",
          type: "message",
          role: "assistant",
          model: o.model ?? "claude-opus-5-5",
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: u.input, output_tokens: 1, cache_read_input_tokens: u.cacheRead ?? 0, cache_creation_input_tokens: u.cacheWrite ?? 0 },
        },
      },
    },
  ];
  o.blocks.forEach((b, index) => {
    if (b.type === "text") {
      out.push({ event: "content_block_start", data: { type: "content_block_start", index, content_block: { type: "text", text: "" } } });
      out.push({ event: "content_block_delta", data: { type: "content_block_delta", index, delta: { type: "text_delta", text: b.text } } });
    } else if (b.type === "thinking") {
      out.push({ event: "content_block_start", data: { type: "content_block_start", index, content_block: { type: "thinking", thinking: "", signature: "" } } });
      out.push({ event: "content_block_delta", data: { type: "content_block_delta", index, delta: { type: "thinking_delta", thinking: b.thinking } } });
      out.push({ event: "content_block_delta", data: { type: "content_block_delta", index, delta: { type: "signature_delta", signature: b.signature } } });
    } else {
      out.push({ event: "content_block_start", data: { type: "content_block_start", index, content_block: { type: "tool_use", id: b.id, name: b.name, input: {} } } });
      out.push({ event: "content_block_delta", data: { type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: b.json } } });
    }
    out.push({ event: "content_block_stop", data: { type: "content_block_stop", index } });
  });
  out.push({ event: "message_delta", data: { type: "message_delta", delta: { stop_reason: o.stop, stop_sequence: null, stop_details: o.stopDetails ?? null }, usage: { output_tokens: u.output } } });
  out.push({ event: "message_stop", data: { type: "message_stop" } });
  return out;
}
