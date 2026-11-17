// The only way widgets reach the network. Hand-rolled on node:http(s) so the address a name
// resolves to is checked before connecting: the user's own apps on localhost or the LAN are fine,
// link-local (cloud metadata) and other nonsense addresses are not. No cookies, no keep-alive,
// bounded time, bounded size, bounded concurrency.

import dns from "node:dns";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import { WidgetError } from "./types.ts";

export type SafeFetchOptions = {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string | Buffer;
  /** Sent only to the same origin as `url`, and over plain http only to local hosts. */
  secret?: { name: string; value: string };
  maxBytes: number;
  totalMs?: number;
  idleMs?: number;
  maxRedirects?: number;
};
export type SafeResponse = { status: number; headers: Record<string, string>; body: Buffer; url: string };

const blocked = new net.BlockList();
blocked.addSubnet("0.0.0.0", 8, "ipv4");
blocked.addSubnet("169.254.0.0", 16, "ipv4");
blocked.addSubnet("224.0.0.0", 4, "ipv4");
blocked.addSubnet("240.0.0.0", 4, "ipv4");
blocked.addAddress("::", "ipv6");
blocked.addSubnet("fe80::", 10, "ipv6");
blocked.addSubnet("ff00::", 8, "ipv6");

const local = new net.BlockList();
local.addSubnet("127.0.0.0", 8, "ipv4");
local.addSubnet("10.0.0.0", 8, "ipv4");
local.addSubnet("172.16.0.0", 12, "ipv4");
local.addSubnet("192.168.0.0", 16, "ipv4");
local.addAddress("::1", "ipv6");
local.addSubnet("fc00::", 7, "ipv6");

/** An IPv4-mapped IPv6 address ("::ffff:a9fe:a9fe") is checked as the IPv4 address inside it. */
function unmap(ip: string): string {
  const dotted = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
  if (dotted) return dotted[1];
  const hex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(ip);
  if (hex) {
    const a = parseInt(hex[1], 16);
    const b = parseInt(hex[2], 16);
    return `${a >> 8}.${a & 255}.${b >> 8}.${b & 255}`;
  }
  return ip;
}

const bare = (host: string) => host.replace(/^\[|\]$/g, "");

/** Why this address may not be connected to, or null. */
export function blockedReason(ip: string): string | null {
  const a = unmap(bare(ip));
  const family = net.isIP(a);
  if (!family) return null;
  return blocked.check(a, family === 4 ? "ipv4" : "ipv6") ? `address ${a} is not allowed` : null;
}

/** Loopback, private ranges, *.local and localhost: where a secret may travel unencrypted. */
export function isLocalHost(host: string): boolean {
  const h = bare(host).toLowerCase();
  const ip = net.isIP(unmap(h));
  if (ip) return local.check(unmap(h), ip === 4 ? "ipv4" : "ipv6");
  return h === "localhost" || h.endsWith(".localhost") || h.endsWith(".local");
}

// 4 requests at once overall, 2 per host: a dashboard of widgets must not hammer one small server.
const MAX_ALL = 4;
const MAX_HOST = 2;
let active = 0;
const perHost = new Map<string, number>();
const waiting: { host: string; go: () => void }[] = [];

function pump(): void {
  for (let i = 0; i < waiting.length && active < MAX_ALL; ) {
    const w = waiting[i];
    if ((perHost.get(w.host) ?? 0) >= MAX_HOST) {
      i++;
      continue;
    }
    waiting.splice(i, 1);
    active++;
    perHost.set(w.host, (perHost.get(w.host) ?? 0) + 1);
    w.go();
  }
}

async function acquire(host: string): Promise<() => void> {
  await new Promise<void>((go) => {
    waiting.push({ host, go });
    pump();
  });
  return () => {
    active--;
    perHost.set(host, (perHost.get(host) ?? 1) - 1);
    if (!perHost.get(host)) perHost.delete(host);
    pump();
  };
}

const lookup: net.LookupFunction = (hostname, options, cb) => {
  dns.lookup(hostname, { ...options, all: true }, (err, addrs) => {
    if (err) return (cb as (e: Error | null) => void)(err);
    const ok = addrs.filter((a) => !blockedReason(a.address));
    if (!ok.length) return (cb as (e: Error | null) => void)(new WidgetError(0, "blocked-address", "That host resolves to an address Canvas will not connect to"));
    if (options.all) (cb as unknown as (e: null, a: dns.LookupAddress[]) => void)(null, ok);
    else (cb as unknown as (e: null, a: string, f: number) => void)(null, ok[0].address, ok[0].family);
  });
};

function check(u: URL, withSecret: boolean): void {
  if (u.protocol !== "http:" && u.protocol !== "https:") throw new WidgetError(0, "bad-url", "Only http and https URLs are allowed");
  if (u.username || u.password) throw new WidgetError(0, "bad-url", "URLs with a user name or password are not allowed");
  const why = blockedReason(u.hostname);
  if (why) throw new WidgetError(0, "blocked-address", `Canvas will not connect: ${why}`);
  if (withSecret && u.protocol === "http:" && !isLocalHost(u.hostname)) throw new WidgetError(0, "insecure-auth", "Secrets are only sent over https, or to this Mac and your local network");
}

type Hop = { method: string; headers: Record<string, string>; body?: string | Buffer };

function hop(u: URL, h: Hop, o: { maxBytes: number; idleMs: number; signal: AbortSignal }): Promise<SafeResponse> {
  return new Promise((resolve, reject) => {
    const mod = u.protocol === "https:" ? https : http;
    const headers: Record<string, string> = { accept: "application/json", "accept-encoding": "identity", "user-agent": "Canvas-widgets/1", ...h.headers };
    if (h.body !== undefined) headers["content-length"] = String(Buffer.byteLength(h.body));
    const req = mod.request(u, { method: h.method, headers, lookup, agent: false, signal: o.signal }, (res) => {
      const len = Number(res.headers["content-length"]);
      if (Number.isFinite(len) && len > o.maxBytes) {
        res.destroy();
        return reject(new WidgetError(0, "too-large", `The response is larger than ${Math.round(o.maxBytes / 1024)} KB`));
      }
      const chunks: Buffer[] = [];
      let size = 0;
      res.on("data", (c: Buffer) => {
        size += c.length;
        if (size > o.maxBytes) {
          res.destroy();
          reject(new WidgetError(0, "too-large", `The response is larger than ${Math.round(o.maxBytes / 1024)} KB`));
        } else chunks.push(c);
      });
      res.on("end", () => {
        const out: Record<string, string> = {};
        for (const [k, v] of Object.entries(res.headers)) if (v !== undefined) out[k] = Array.isArray(v) ? v.join(", ") : v;
        resolve({ status: res.statusCode ?? 0, headers: out, body: Buffer.concat(chunks), url: u.href });
      });
      res.on("error", (e) => reject(e));
    });
    req.setTimeout(o.idleMs, () => req.destroy(new WidgetError(0, "timeout", "The server stopped answering")));
    req.on("error", reject);
    if (h.body !== undefined) req.write(h.body);
    req.end();
  });
}

const FORBIDDEN_STATIC = /^(authorization|cookie|host|proxy-.*|content-length|connection|transfer-encoding)$/i;

/** Static headers a widget may set. Credentials go through `secret`, never here. */
export function checkStaticHeaders(h: Record<string, string>): void {
  for (const [k, v] of Object.entries(h)) {
    if (!/^[A-Za-z0-9-]{1,60}$/.test(k) || FORBIDDEN_STATIC.test(k)) throw new WidgetError(422, "bad-header", `The header "${k}" is not allowed`);
    if (typeof v !== "string" || v.length > 500 || /[\r\n]/.test(v)) throw new WidgetError(422, "bad-header", `The value of header "${k}" is not allowed`);
  }
}

export async function safeFetch(o: SafeFetchOptions): Promise<SafeResponse> {
  let u: URL;
  try {
    u = new URL(o.url);
  } catch {
    throw new WidgetError(0, "bad-url", "That is not a valid URL");
  }
  check(u, !!o.secret);
  const release = await acquire(u.host);
  const ac = new AbortController();
  const total = o.totalMs ?? 8000;
  const timer = setTimeout(() => ac.abort(), total);
  try {
    const origin = u.origin;
    let method = o.method ?? "GET";
    let body = o.body;
    let headers = { ...(o.headers ?? {}) };
    let secret = o.secret;
    for (let n = 0; ; n++) {
      const h = { ...headers };
      if (secret) h[secret.name] = secret.value;
      let res: SafeResponse;
      try {
        res = await hop(u, { method, headers: h, body }, { maxBytes: o.maxBytes, idleMs: o.idleMs ?? 5000, signal: ac.signal });
      } catch (e) {
        if (ac.signal.aborted) throw new WidgetError(0, "timeout", `The request took longer than ${Math.round(total / 1000)} seconds`);
        if (e instanceof WidgetError) throw e;
        const code = (e as NodeJS.ErrnoException).code;
        throw new WidgetError(0, "network", code ? `Network error (${code})` : "Network error");
      }
      const loc = res.headers.location;
      if (![301, 302, 303, 307, 308].includes(res.status) || !loc) return res;
      if (n >= (o.maxRedirects ?? 3)) throw new WidgetError(0, "redirect-limit", "Too many redirects");
      let next: URL;
      try {
        next = new URL(loc, u);
      } catch {
        throw new WidgetError(0, "bad-url", "The server redirected to an invalid URL");
      }
      if (next.origin !== origin) {
        // Credentials and custom headers stay with the origin they were meant for.
        secret = undefined;
        headers = {};
      }
      check(next, !!secret);
      if (res.status !== 307 && res.status !== 308) {
        method = "GET";
        body = undefined;
      }
      u = next;
    }
  } finally {
    clearTimeout(timer);
    release();
  }
}

/** safeFetch for JSON APIs: a 2xx must be application/json (or +json) and parse. */
export async function safeFetchJson(o: SafeFetchOptions): Promise<{ status: number; headers: Record<string, string>; json: unknown }> {
  const r = await safeFetch(o);
  if (r.status < 200 || r.status >= 300) return { status: r.status, headers: r.headers, json: undefined };
  if (!/^application\/(?:[\w.+-]+\+)?json\b/i.test(r.headers["content-type"] ?? "")) throw new WidgetError(0, "bad-content-type", "The response is not JSON");
  try {
    return { status: r.status, headers: r.headers, json: JSON.parse(r.body.toString("utf8")) };
  } catch {
    throw new WidgetError(0, "bad-json", "The response is not valid JSON");
  }
}
