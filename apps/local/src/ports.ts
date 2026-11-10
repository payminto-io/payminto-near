import { createServer } from "node:net";
import { freePort } from "@payminto/demo";
import { DEFAULT_PORTS, type Ports } from "./config.ts";

export class PortBusyError extends Error {
  constructor(what: string, port: number, flag: string) {
    super(`Port ${port} is already in use, and the ${what} needs it. Stop whatever is listening there (lsof -nP -iTCP:${port} -sTCP:LISTEN shows it), or pick another port with ${flag} <port>.`);
    this.name = "PortBusyError";
  }
}

/** True when nothing listens on the port on 127.0.0.1 or on every address (a dev server usually binds the latter). */
export async function isFree(port: number): Promise<boolean> {
  const tryBind = (host?: string) =>
    new Promise<boolean>((resolve) => {
      const srv = createServer();
      srv.once("error", () => resolve(false));
      srv.listen({ port, host, exclusive: true }, () => srv.close(() => resolve(true)));
    });
  return (await tryBind("127.0.0.1")) && (await tryBind());
}

const WHAT: Record<keyof Ports, [string, string]> = {
  dashboard: ["dashboard", "--dashboard-port"],
  node: ["clearing node", "--node-port"],
  signer: ["local signer", "--signer-port"],
  services: ["paid services and the agent remote", "--services-port"],
  relayer: ["gas relayer", "--relayer-port"],
};

/**
 * The four ports of a run. `fixed` (a person's run) uses the documented defaults so the printed URLs stay the same,
 * and fails with a plain message when one is taken. Otherwise (the scripted check) free ports are picked.
 */
export async function choosePorts(wanted: Partial<Ports>, fixed: boolean): Promise<Ports> {
  const out = {} as Ports;
  for (const key of Object.keys(DEFAULT_PORTS) as Array<keyof Ports>) {
    const explicit = wanted[key];
    if (explicit !== undefined || fixed) {
      const port = explicit ?? DEFAULT_PORTS[key];
      if (!(await isFree(port))) throw new PortBusyError(WHAT[key][0], port, WHAT[key][1]);
      out[key] = port;
    } else {
      let port = await freePort();
      while (Object.values(out).includes(port)) port = await freePort();
      out[key] = port;
    }
  }
  return out;
}
