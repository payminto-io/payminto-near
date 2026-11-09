import { lookup as dnsLookup, type LookupAddress, type LookupOptions } from "node:dns";
import { BlockList, isIP } from "node:net";
import { ApiError } from "../errors.ts";

/** Private, loopback, link-local, CGNAT, multicast, reserved and documentation ranges (IPv4 and IPv6). */
const blocked = new BlockList();
for (const [net, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const) {
  blocked.addSubnet(net, prefix, "ipv4");
}
for (const [net, prefix] of [
  // IPv4-compatible (deprecated, covers :: and ::1) and NAT64 (well-known and local-use): never a webhook target,
  // whatever IPv4 address they embed.
  ["::", 96],
  ["64:ff9b::", 96],
  ["64:ff9b:1::", 48],
  ["fc00::", 7],
  ["fe80::", 10],
  ["fec0::", 10],
  ["ff00::", 8],
  ["2001:db8::", 32],
] as const) {
  blocked.addSubnet(net, prefix, "ipv6");
}

/** IPv4 embedded in an IPv4-mapped IPv6 address (::ffff:a.b.c.d), so it is checked as IPv4. */
function embeddedIpv4(ip: string): string | null {
  const m = /^(?:::ffff:|64:ff9b::)(?:0:)?(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
  if (m) return m[1]!;
  const hex = /^(?:::ffff:|64:ff9b::)([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(ip);
  if (!hex) return null;
  const a = parseInt(hex[1]!, 16);
  const b = parseInt(hex[2]!, 16);
  return `${a >> 8}.${a & 255}.${b >> 8}.${b & 255}`;
}

export function isPrivateAddress(ip: string): boolean {
  const bare = ip.replace(/^\[|\]$/g, "").split("%")[0]!;
  const family = isIP(bare);
  if (family === 4) return blocked.check(bare, "ipv4");
  if (family === 6) {
    if (blocked.check(bare, "ipv6")) return true;
    const v4 = embeddedIpv4(bare);
    if (v4) return blocked.check(v4, "ipv4");
    return blocked.check(bare, "ipv6");
  }
  return true;
}

export type UrlPolicy = { allowPrivate: boolean };

const reject = (message: string) => new ApiError(400, "WEBHOOK_URL_REJECTED", message);

/**
 * Static checks of a webhook URL (GATEWAY.md section 7): http(s) only, no credentials; with allowPrivate false, https
 * only and the host must resolve to public addresses only. Delivery re-checks at connect time (see guardedLookup), so
 * DNS rebinding after this check cannot reach a private address.
 */
export async function checkWebhookUrl(raw: string, policy: UrlPolicy, resolve = resolveAll): Promise<URL> {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw reject("url is not a valid URL");
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") throw reject("url must be http or https");
  if (u.username || u.password) throw reject("url must not carry credentials");
  if (policy.allowPrivate) return u;
  if (u.protocol !== "https:") throw reject("url must be https");
  const host = u.hostname.replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".localhost")) throw reject("url must not point at localhost");
  const addresses = isIP(host) ? [host] : await resolve(host).catch(() => {
    throw reject(`cannot resolve ${host}`);
  });
  if (addresses.length === 0) throw reject(`cannot resolve ${host}`);
  if (addresses.some(isPrivateAddress)) throw reject("url resolves to a private, loopback or link-local address");
  return u;
}

function resolveAll(host: string): Promise<string[]> {
  return new Promise((ok, fail) => dnsLookup(host, { all: true, verbatim: true }, (err, addrs) => (err ? fail(err) : ok(addrs.map((a) => a.address)))));
}

type LookupCallback = (err: NodeJS.ErrnoException | null, address: string | LookupAddress[], family?: number) => void;

/**
 * `lookup` for http.request: resolves like dns.lookup but refuses private addresses when allowPrivate is false, so the
 * address that is connected to is the address that was checked.
 */
export function guardedLookup(policy: UrlPolicy) {
  return (hostname: string, options: LookupOptions, callback: LookupCallback) => {
    dnsLookup(hostname, { ...options, all: true }, (err, addrs) => {
      if (err) return callback(err, []);
      const list = addrs as LookupAddress[];
      if (!policy.allowPrivate && list.some((a) => isPrivateAddress(a.address))) {
        const e = new Error(`${hostname} resolves to a private address`) as NodeJS.ErrnoException;
        e.code = "EPRIVATE";
        return callback(e, []);
      }
      if (options.all) return callback(null, list);
      const first = list[0];
      if (!first) return callback(new Error(`no address for ${hostname}`) as NodeJS.ErrnoException, []);
      callback(null, first.address, first.family);
    });
  };
}
