import type { Context, MiddlewareHandler } from "hono";

export type BodyLimitOptions = {
  /** Largest request body that reaches a route, in bytes. */
  maxSize: number;
  /** The answer to a larger body. */
  onTooLarge: (c: Context) => Response;
  /** How much of an oversized body is read and thrown away before the answer goes out. Default 8 MiB. */
  drainMaxBytes?: number;
  /** How long that may take. Default 2000 ms. */
  drainMs?: number;
};

type Reader = { read(): Promise<{ done: boolean; value?: Uint8Array }> };

/**
 * Reads what is left of a body and keeps none of it, up to a byte count and a time limit. A client that sends more, or
 * sends slowly, is answered anyway: the limits only decide how long this node listens to bytes it will not use.
 */
async function discard(reader: Reader, maxBytes: number, ms: number): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<"late">((resolve) => {
    timer = setTimeout(() => resolve("late"), ms);
  });
  try {
    for (let seen = 0; seen <= maxBytes; ) {
      const next = await Promise.race([reader.read(), late]);
      if (next === "late" || next.done) return;
      seen += next.value?.length ?? 0;
    }
  } catch {
    // The client went away: there is nobody left to answer.
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The request body limit. A body over `maxSize` never reaches a route, whether its size is declared (Content-Length)
 * or it arrives in chunks.
 *
 * The rest of an oversized body is read before the answer goes out. A server that answers early and closes the
 * connection on bytes it has not read makes the kernel reset the connection, and the client then loses the 413 it was
 * sent and sees a broken connection instead.
 */
export function limitBody(o: BodyLimitOptions): MiddlewareHandler {
  const drainMaxBytes = o.drainMaxBytes ?? 8 * 1024 * 1024;
  const drainMs = o.drainMs ?? 2_000;
  return async function limitBody(c, next) {
    const body = c.req.raw.body;
    if (!body) return next();
    const reader = body.getReader();
    const tooLarge = async () => {
      await discard(reader, drainMaxBytes, drainMs);
      return o.onTooLarge(c);
    };
    const declared = c.req.raw.headers.has("transfer-encoding") ? null : c.req.raw.headers.get("content-length");
    if (declared !== null && Number.parseInt(declared, 10) > o.maxSize) return tooLarge();
    const chunks: Uint8Array[] = [];
    for (let size = 0; ; ) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > o.maxSize) return tooLarge();
      chunks.push(value);
    }
    // The body was read to count it, so the route gets it back as a new stream over the same bytes.
    c.req.raw = new Request(c.req.raw, {
      body: new ReadableStream<Uint8Array>({
        start(controller) {
          for (const chunk of chunks) controller.enqueue(chunk);
          controller.close();
        },
      }),
      duplex: "half",
    } as RequestInit);
    return next();
  };
}
