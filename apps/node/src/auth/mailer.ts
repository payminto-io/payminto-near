import { connect as netConnect, type Socket } from "node:net";
import { connect as tlsConnect, type TLSSocket } from "node:tls";
import { randomBytes } from "node:crypto";
import type { Database } from "../db/database.ts";
import type { Logger } from "../logger.ts";
import { nowIso } from "../store.ts";

export type SmtpConfig = {
  host: string;
  port: number;
  /** smtps (implicit TLS, port 465); otherwise STARTTLS is used when the server offers it. */
  secure: boolean;
  user: string | null;
  pass: string | null;
  from: string;
  /** Test servers only: accept a self-signed certificate. */
  insecureTls?: boolean;
};

export type EmailKind =
  | "verify_email"
  | "reset_password"
  | "invite"
  | "password_changed"
  | "signup_received"
  | "signup_approved"
  | "signup_declined"
  | "account_exists"
  | "test";

export type Email = { to: string; subject: string; text: string; link?: string | null; kind: EmailKind };

/** Parses SMTP_URL (`smtp://user:pass@host:587`, `smtps://...:465`) or the SMTP_HOST family; null when unset. */
export function smtpConfigFromEnv(env: Record<string, string | undefined>): SmtpConfig | null {
  const from = env.SMTP_FROM?.trim();
  if (env.SMTP_URL) {
    const u = new URL(env.SMTP_URL);
    if (u.protocol !== "smtp:" && u.protocol !== "smtps:") throw new Error("SMTP_URL must start with smtp:// or smtps://");
    const secure = u.protocol === "smtps:";
    return {
      host: u.hostname,
      port: u.port ? Number(u.port) : secure ? 465 : 587,
      secure,
      user: u.username ? decodeURIComponent(u.username) : null,
      pass: u.password ? decodeURIComponent(u.password) : null,
      from: from || (u.username ? decodeURIComponent(u.username) : `payminto@${u.hostname}`),
    };
  }
  if (env.SMTP_HOST) {
    const port = env.SMTP_PORT ? Number(env.SMTP_PORT) : 587;
    return { host: env.SMTP_HOST, port, secure: port === 465, user: env.SMTP_USER || null, pass: env.SMTP_PASS || null, from: from || `payminto@${env.SMTP_HOST}` };
  }
  return null;
}

/**
 * Sends account emails (PRODUCT.md 4.9). With SMTP configured it sends through it; either way every email is kept in
 * `outbox_emails`. Without SMTP the email is also logged (`[email] to=... link=...`) and shown to the platform owner in
 * Platform > Email outbox, which is the same trust model as the owner reading the database, made visible.
 */
export class Mailer {
  readonly #db: Database;
  readonly #log: Logger;
  readonly smtp: SmtpConfig | null;

  constructor(o: { db: Database; log: Logger; smtp: SmtpConfig | null }) {
    this.#db = o.db;
    this.#log = o.log;
    this.smtp = o.smtp;
  }

  get configured(): boolean {
    return this.smtp !== null;
  }

  /** Stores the email in the current transaction and delivers it after commit. */
  queue(e: Email): number {
    const { lastInsertRowid: id } = this.#db.run(
      "INSERT INTO outbox_emails (to_addr, subject, body_text, link, kind, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      e.to,
      e.subject,
      e.text,
      e.link ?? null,
      e.kind,
      nowIso(),
    );
    this.#db.afterCommit(() => void this.#deliver(id, e));
    return id;
  }

  /** Sends now and reports how (for the "Send test email" button). */
  async sendNow(e: Email): Promise<{ delivered: "smtp" | "outbox"; error: string | null }> {
    const { lastInsertRowid: id } = this.#db.run(
      "INSERT INTO outbox_emails (to_addr, subject, body_text, link, kind, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      e.to,
      e.subject,
      e.text,
      e.link ?? null,
      e.kind,
      nowIso(),
    );
    const error = await this.#deliver(id, e);
    return { delivered: this.smtp ? "smtp" : "outbox", error };
  }

  async #deliver(id: number, e: Email): Promise<string | null> {
    if (!this.smtp) {
      this.#log.info(`[email] to=${e.to} kind=${e.kind}${e.link ? ` link=${e.link}` : ""}`, { subject: e.subject });
      return null;
    }
    try {
      await sendSmtp(this.smtp, e);
      this.#db.run("UPDATE outbox_emails SET sent_at = ? WHERE id = ?", nowIso(), id);
      return null;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.#db.run("UPDATE outbox_emails SET error = ? WHERE id = ?", msg.slice(0, 500), id);
      this.#log.warn("email delivery failed", { to: e.to, kind: e.kind, err: msg });
      return msg;
    }
  }

  outbox(limit: number, cursor?: number) {
    const rows = this.#db.all<{ id: number; to_addr: string; subject: string; link: string | null; kind: string; created_at: string; sent_at: string | null; error: string | null }>(
      `SELECT id, to_addr, subject, link, kind, created_at, sent_at, error FROM outbox_emails ${cursor !== undefined ? "WHERE id < ?" : ""} ORDER BY id DESC LIMIT ?`,
      ...(cursor !== undefined ? [cursor, limit + 1] : [limit + 1]),
    );
    const page = rows.slice(0, limit);
    return {
      items: page.map((r) => ({ id: r.id, to: r.to_addr, subject: r.subject, kind: r.kind, link: r.link, created_at: r.created_at, sent_at: r.sent_at, error: r.error })),
      next_cursor: rows.length > limit && page.length ? String(page[page.length - 1]!.id) : null,
    };
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Minimal SMTP client (RFC 5321): EHLO, STARTTLS, AUTH PLAIN or LOGIN, MAIL FROM, RCPT TO, DATA, QUIT.

const TIMEOUT_MS = 15_000;

function headerSafe(s: string): string {
  return s.replace(/[\r\n]+/g, " ").trim();
}

function encodeSubject(s: string): string {
  const clean = headerSafe(s);
  return /^[\x20-\x7e]*$/.test(clean) ? clean : `=?UTF-8?B?${Buffer.from(clean, "utf8").toString("base64")}?=`;
}

function addressOf(s: string): string {
  const m = /<([^>]+)>/.exec(s);
  return headerSafe(m ? m[1]! : s);
}

export function buildMessage(cfg: SmtpConfig, e: Email, date = new Date()): string {
  const body = e.text.replace(/\r?\n/g, "\r\n").replace(/^\./gm, "..");
  return [
    `From: ${headerSafe(cfg.from)}`,
    `To: ${headerSafe(e.to)}`,
    `Subject: ${encodeSubject(e.subject)}`,
    `Date: ${date.toUTCString()}`,
    `Message-ID: <${randomBytes(12).toString("hex")}@${cfg.host}>`,
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=utf-8",
    "Content-Transfer-Encoding: 8bit",
    "",
    body,
  ].join("\r\n");
}

class SmtpConn {
  #sock: Socket | TLSSocket;
  #buf = "";
  #waiters: Array<(line: { code: number; text: string } | Error) => void> = [];
  #lines: string[] = [];

  constructor(sock: Socket | TLSSocket) {
    this.#sock = sock;
    this.#attach(sock);
  }

  #attach(sock: Socket | TLSSocket) {
    sock.setEncoding("utf8");
    sock.setTimeout(TIMEOUT_MS, () => this.#fail(new Error("SMTP timeout")));
    sock.on("data", (chunk: string) => this.#onData(chunk));
    sock.on("error", (err) => this.#fail(err));
  }

  #fail(err: Error) {
    const ws = this.#waiters;
    this.#waiters = [];
    for (const w of ws) w(err);
    this.#sock.destroy();
  }

  #onData(chunk: string) {
    this.#buf += chunk;
    let i: number;
    while ((i = this.#buf.indexOf("\r\n")) >= 0) {
      const line = this.#buf.slice(0, i);
      this.#buf = this.#buf.slice(i + 2);
      this.#lines.push(line);
      // The last line of a reply has a space (or nothing) after the code.
      if (/^\d{3}( |$)/.test(line)) {
        const text = this.#lines.join("\n");
        this.#lines = [];
        this.#waiters.shift()?.({ code: Number(line.slice(0, 3)), text });
      }
    }
  }

  reply(): Promise<{ code: number; text: string }> {
    return new Promise((resolve, reject) => this.#waiters.push((r) => (r instanceof Error ? reject(r) : resolve(r))));
  }

  async cmd(line: string | null, expect: number[], redact = false): Promise<{ code: number; text: string }> {
    const p = this.reply();
    if (line !== null) this.#sock.write(line + "\r\n");
    const r = await p;
    if (!expect.includes(r.code)) throw new Error(`SMTP ${redact ? "AUTH" : (line ?? "greeting").split(" ")[0]} failed: ${r.text.slice(0, 200)}`);
    return r;
  }

  async upgrade(host: string, insecure: boolean): Promise<void> {
    const plain = this.#sock as Socket;
    plain.removeAllListeners("data");
    plain.setTimeout(0);
    const tls = await new Promise<TLSSocket>((resolve, reject) => {
      const s = tlsConnect({ socket: plain, servername: host, rejectUnauthorized: !insecure }, () => resolve(s));
      s.once("error", reject);
    });
    this.#sock = tls;
    this.#attach(tls);
  }

  write(data: string) {
    this.#sock.write(data);
  }

  close() {
    this.#sock.end();
  }
}

export async function sendSmtp(cfg: SmtpConfig, e: Email): Promise<void> {
  const sock = await new Promise<Socket | TLSSocket>((resolve, reject) => {
    const s = cfg.secure
      ? tlsConnect({ host: cfg.host, port: cfg.port, servername: cfg.host, rejectUnauthorized: !cfg.insecureTls }, () => resolve(s))
      : netConnect({ host: cfg.host, port: cfg.port }, () => resolve(s));
    s.once("error", reject);
  });
  const c = new SmtpConn(sock);
  try {
    await c.cmd(null, [220]);
    let ehlo = await c.cmd("EHLO payminto", [250]);
    if (!cfg.secure && /STARTTLS/i.test(ehlo.text)) {
      await c.cmd("STARTTLS", [220]);
      await c.upgrade(cfg.host, !!cfg.insecureTls);
      ehlo = await c.cmd("EHLO payminto", [250]);
    } else if (!cfg.secure && cfg.user && !/^(localhost|127\.|::1)/.test(cfg.host)) {
      // Never send credentials in clear text to a remote server.
      throw new Error("SMTP server does not offer STARTTLS; refusing to send credentials without TLS");
    }
    if (cfg.user && cfg.pass) {
      if (/AUTH[ =][^\n]*PLAIN/i.test(ehlo.text)) {
        await c.cmd(`AUTH PLAIN ${Buffer.from(`\0${cfg.user}\0${cfg.pass}`).toString("base64")}`, [235], true);
      } else {
        await c.cmd("AUTH LOGIN", [334]);
        await c.cmd(Buffer.from(cfg.user).toString("base64"), [334], true);
        await c.cmd(Buffer.from(cfg.pass).toString("base64"), [235], true);
      }
    }
    await c.cmd(`MAIL FROM:<${addressOf(cfg.from)}>`, [250]);
    await c.cmd(`RCPT TO:<${addressOf(e.to)}>`, [250, 251]);
    await c.cmd("DATA", [354]);
    const done = c.reply();
    c.write(buildMessage(cfg, e) + "\r\n.\r\n");
    const r = await done;
    if (r.code !== 250) throw new Error(`SMTP DATA failed: ${r.text.slice(0, 200)}`);
    await c.cmd("QUIT", [221]).catch(() => undefined);
  } finally {
    c.close();
  }
}
