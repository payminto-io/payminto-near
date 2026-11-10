/**
 * The agent remote: one small page, served next to the paid services, that makes paid calls as an agent.
 *
 * A browser cannot sign a voucher, and a person following the walkthrough should not need a second terminal. The
 * remote stands in for the agent's runtime: it holds the agent keys (the desk) and calls the paid services with the
 * real SDK. It is a local development tool, bound to 127.0.0.1, and it can only spend from Budgets on this sandbox.
 */
import { Hono } from "hono";
import { isAccountId, isId32, type Id32, type PublicKey } from "@payminto/protocol";
import type { LocalAccounts } from "./accounts.ts";
import type { AgentDesk } from "./agents.ts";
import { REMOTE_PAGE } from "./remote-page.ts";
import type { RegisteredService } from "./services.ts";
import type { NodeSession } from "./session.ts";

type BudgetRow = { id: Id32; label: string; status: string; owner: string; agent: string; cap: string; escrow: string | null; policy: { perCallCap: string }; payees: string[]; spend?: { total?: string } };

export type RemoteOptions = {
  /** The paid services' own routes, mounted on the same server. */
  services: Hono;
  desk: AgentDesk;
  /** The platform owner's session, used only to list Budgets. */
  owner: NodeSession;
  urls: { dashboard: string; services: string };
  list: () => RegisteredService[];
  /** Budget ids to list first, in this order: the seeded ones, so the walkthrough's Budget is the one selected. */
  first: () => Id32[];
  accounts: LocalAccounts;
  port: number;
};

const LOOPBACK_HOST = /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/;

/** The Budgets registered at the node whose agent key the desk holds, including ones a person opened in the dashboard. */
export async function deskBudgets(o: { desk: AgentDesk; owner: NodeSession }): Promise<BudgetRow[]> {
  const all = await o.owner.get<BudgetRow[]>("/v1/budgets");
  return all.filter((b) => o.desk.holds(b.agent));
}

export function remoteApp(o: RemoteOptions): Hono {
  const app = new Hono();
  const own = [`http://127.0.0.1:${o.port}`, `http://localhost:${o.port}`];

  app.use("*", async (c, next) => {
    if (!LOOPBACK_HOST.test(c.req.header("host") ?? "")) return c.json({ error: { code: "NOT_LOOPBACK", message: "this server answers only on 127.0.0.1" } }, 403);
    return next();
  });

  app.get("/", (c) => c.html(REMOTE_PAGE));

  app.get("/remote/state", async (c) => {
    const order = o.first();
    const rank = (id: Id32) => (order.includes(id) ? order.indexOf(id) : order.length);
    const budgets = (await deskBudgets(o)).map((b, i) => ({ b, i })).sort((x, y) => rank(x.b.id) - rank(y.b.id) || x.i - y.i).map((x) => x.b);
    const used = new Set(budgets.map((b) => b.agent));
    return c.json({
      dashboard: o.urls.dashboard,
      budgets: budgets.map((b) => ({ id: b.id, label: b.label, status: b.status, owner: b.owner, agentKey: b.agent, cap: b.cap, escrow: b.escrow, perCallCap: b.policy.perCallCap, payees: b.payees })),
      spareKeys: o.desk.keys().filter((k) => !used.has(k.keypair.publicKey)).map((k) => ({ name: k.name, publicKey: k.keypair.publicKey })),
      services: o.list().map((s) => ({ id: s.id, key: s.key, name: s.name, url: s.url, priceAtomic: s.priceAtomic.toString(), payee: s.payee, note: s.note })),
      settler: o.accounts.settler,
    });
  });

  app.post("/remote/call", async (c) => {
    // Only this page may trigger a call: a form on another site cannot send JSON with this page's origin.
    const origin = c.req.header("origin");
    if (origin !== undefined && !own.includes(origin)) return c.json({ error: { code: "ORIGIN_NOT_ALLOWED", message: "calls are made from the agent remote page" } }, 403);
    if (!(c.req.header("content-type") ?? "").startsWith("application/json")) return c.json({ error: { code: "BAD_REQUEST", message: "send JSON" } }, 400);
    const b = (await c.req.json().catch(() => null)) as { budgetId?: unknown; serviceId?: unknown; guard?: unknown } | null;
    const service = o.list().find((s) => s.id === b?.serviceId);
    if (!b || !isId32(b.budgetId) || !service) return c.json({ error: { code: "BAD_REQUEST", message: "budgetId and serviceId are required" } }, 400);
    const budget = (await deskBudgets(o)).find((x) => x.id === b.budgetId);
    if (!budget) return c.json({ error: { code: "UNKNOWN_BUDGET", message: "the agent remote holds no key for that Budget" } }, 404);
    try {
      return c.json(await o.desk.call({ budgetId: budget.id, agentPk: budget.agent as PublicKey, url: service.url, guard: b.guard === true }));
    } catch (err) {
      return c.json({ ok: false, url: service.url, refused: false, status: 0, message: err instanceof Error ? err.message : String(err) });
    }
  });

  app.route("/", o.services);
  return app;
}
