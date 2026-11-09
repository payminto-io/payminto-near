import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { ToolSpec } from "@payminto/models";

/** An MCP server the agent connects to: a local command over stdio, or a Streamable HTTP URL. */
export type McpServerSpec =
  | { name: string; command: string; args?: string[]; env?: Record<string, string>; cwd?: string }
  | { name: string; url: string; headers?: Record<string, string> };

export type ToolOutcome = {
  isError: boolean;
  /** The text the model sees. */
  text: string;
  /** The tool's structuredContent, if any (the Payminto servers put `{ result }` here). */
  structured: unknown;
};

/** The agent loop's view of its tools: a frozen list and a way to call one by name. */
export interface ToolHost {
  readonly tools: ToolSpec[];
  /** Which server serves a tool (for the run log). */
  serverOf(tool: string): string | undefined;
  call(name: string, input: Record<string, unknown>): Promise<ToolOutcome>;
  close(): Promise<void>;
}

const VERSION = "0.1.0";
/** Tool output beyond this is cut before it reaches the model (and says so). */
const MAX_TOOL_TEXT = 60_000;

type CallResult = Awaited<ReturnType<Client["callTool"]>>;

function outcomeOf(r: CallResult): ToolOutcome {
  const content = Array.isArray(r.content) ? (r.content as Array<{ type: string; text?: string }>) : [];
  let text = content.map((c) => (c.type === "text" ? (c.text ?? "") : `[${c.type} content omitted]`)).join("\n");
  if (!text && r.structuredContent !== undefined) text = JSON.stringify(r.structuredContent);
  if (text.length > MAX_TOOL_TEXT) text = `${text.slice(0, MAX_TOOL_TEXT)}\n[truncated: ${text.length - MAX_TOOL_TEXT} more characters]`;
  return { isError: r.isError === true, text, structured: r.structuredContent };
}

function transportFor(spec: McpServerSpec, stderr: "inherit" | "ignore" | "pipe"): Transport {
  if ("url" in spec) return new StreamableHTTPClientTransport(new URL(spec.url), { requestInit: { headers: spec.headers } });
  // The child inherits only the SDK's safe default variables (PATH, HOME, ...) plus what the spec names, so secrets
  // such as model API keys never reach a tool server.
  return new StdioClientTransport({ command: spec.command, args: spec.args, env: spec.env, cwd: spec.cwd, stderr });
}

/**
 * Builds a ToolHost over already connected MCP clients. Tool names must be unique across servers: the model calls a
 * tool by its plain name, and two servers offering the same name would make that ambiguous.
 */
export async function toolHostFromClients(clients: Array<{ name: string; client: Client }>, o: { onClose?: () => Promise<void> } = {}): Promise<ToolHost> {
  const owner = new Map<string, { server: string; client: Client }>();
  const tools: ToolSpec[] = [];
  for (const { name, client } of clients) {
    const listed = await client.listTools();
    for (const t of listed.tools) {
      const prev = owner.get(t.name);
      if (prev) throw new Error(`MCP tool ${t.name} is offered by both ${prev.server} and ${name}; connect them to separate agents`);
      owner.set(t.name, { server: name, client });
      tools.push({ name: t.name, description: t.description ?? t.title ?? t.name, inputSchema: t.inputSchema as Record<string, unknown> });
    }
  }
  // Deterministic order keeps the prompt-cache prefix stable across runs.
  tools.sort((a, b) => a.name.localeCompare(b.name));
  let closed = false;
  return {
    tools,
    serverOf: (tool) => owner.get(tool)?.server,
    async call(name, input) {
      const o = owner.get(name);
      if (!o) return { isError: true, text: `Unknown tool ${name}. Available: ${tools.map((t) => t.name).join(", ")}.`, structured: undefined };
      try {
        return outcomeOf(await o.client.callTool({ name, arguments: input }));
      } catch (err) {
        return { isError: true, text: `Tool ${name} failed: ${err instanceof Error ? err.message : String(err)}`, structured: undefined };
      }
    },
    async close() {
      if (closed) return;
      closed = true;
      await Promise.allSettled(clients.map((c) => c.client.close()));
      await o.onClose?.();
    },
  };
}

/** Connects to every server (in order), lists their tools and returns one ToolHost. Closes what it opened on failure. */
export async function connectMcp(specs: McpServerSpec[], o: { clientName?: string; stderr?: "inherit" | "ignore" | "pipe" } = {}): Promise<ToolHost> {
  const clients: Array<{ name: string; client: Client }> = [];
  try {
    for (const spec of specs) {
      const client = new Client({ name: o.clientName ?? "payminto-agent", version: VERSION });
      try {
        await client.connect(transportFor(spec, o.stderr ?? "inherit"));
      } catch (err) {
        const where = "url" in spec ? spec.url : `${spec.command} ${(spec.args ?? []).join(" ")}`;
        throw new Error(`cannot start MCP server ${spec.name} (${where}): ${err instanceof Error ? err.message : String(err)}`);
      }
      clients.push({ name: spec.name, client });
    }
    return await toolHostFromClients(clients);
  } catch (err) {
    await Promise.allSettled(clients.map((c) => c.client.close()));
    throw err;
  }
}
