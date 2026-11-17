// Talking to a team's own Canvas server (cloud/cloudflare): who we are there, one room socket per open shared file,
// sharing a file, and the routes the app and the page use. What the messages mean for comments.json is in
// src/cloud-sync.ts; this file only moves them.
//
//   GET  /api/cloud/status                 { configured, url, host, status, email, role, ... }  (asks the server, at most every 3 s)
//   POST /api/cloud/token  { url, token }  the Access token the app got from its sign-in window. Kept in MEMORY only.
//   POST /api/cloud/signout { url }        forget it
//   POST /api/cloud/share?file=            share the open file's comments to the configured server
//   POST /api/comments/retry|discard?file= { opId }  for a comment the server refused
//
// The token: the shell (apps/macos/CloudSettings.swift) reads the `CF_Authorization` cookie of the sign-in window and
// writes it to the Keychain; it also posts it here so this process need not ask the Keychain for every request. After
// a restart this process reads the Keychain item (src/widgets/keychain.ts, the same read-only way widgets read theirs).
// The token is sent as `cf-access-token` to the configured server only, never written to a file, never logged.
// For http://localhost or http://127.0.0.1 (a server run with DEV=1) it sends `x-canvas-dev-email` instead, and for no
// other host.

import type http from "node:http";
import { PROTOCOL_VERSION, type Applied, type Author, type ClientMessage, type Rejected, type ServerMessage, type Thread } from "../cloud/protocol.ts";
import { readBodyText } from "./body.ts";
import { cloudConfig, hostOf, isLocalDev } from "./cloud-config.ts";
import { acknowledge, confirm, discard, hooks, isShared, opsForShare, pendingStates, reject, retry, shareLocal, snapshot, viewOf, type SyncFile } from "./cloud-sync.ts";
import { CommentsError, emptyComments, readCommentsFile, writeCommentsFile } from "./comments-file.ts";
import { localName, packageOf } from "./comments.ts";
import { clearSecret, getSecret } from "./widgets/keychain.ts";

export type Status = "signedOut" | "connected" | "offline" | "signInAgain" | "forbidden" | "tooOld" | "tooNew";

/** The Keychain item the shell writes the token to (account: the server's host). The service is overridable for tests. */
export const keychainService = () => process.env.CANVAS_CLOUD_KEYCHAIN_SERVICE || "cc.getcanvas.canvas.cloud";

const tokens = new Map<string, string>();

/** What a response means for the person: fine, or why not. Pure, so the 401 rules are tested without a network. */
export function classify(r: { status: number; type?: string; contentType?: string | null; code?: string }): "ok" | Status {
  if (r.type === "opaqueredirect" || (r.status >= 300 && r.status < 400)) return "signInAgain"; // Access sends a browser to its login page
  if (r.status === 401) return "signInAgain";
  const json = /json/i.test(r.contentType ?? "");
  if (r.status === 403) return json && r.code === "forbidden" ? "forbidden" : "signInAgain"; // JSON from the Worker: no role. Anything else: Access
  if (r.status >= 500 || r.status === 429) return "offline";
  if (r.status >= 200 && r.status < 300 && /html/i.test(r.contentType ?? "")) return "signInAgain"; // a login page answered with 200
  return "ok";
}

/** The headers that say who we are to `origin`: a dev email for a local development server, else the Access token. */
export async function authHeaders(origin: string): Promise<Record<string, string> | null> {
  if (isLocalDev(origin)) {
    const email = cloudConfig().devEmail;
    return email ? { "x-canvas-dev-email": email } : null;
  }
  const host = hostOf(origin);
  let t = tokens.get(host);
  if (!t) {
    try {
      t = (await getSecret({ service: keychainService(), account: host })).trim();
    } catch {
      return null;
    }
    if (t) tokens.set(host, t);
  }
  return t ? { "cf-access-token": t } : null;
}

export function setToken(url: string, token: string | null): void {
  const host = hostOf(url);
  if (token) tokens.set(host, token);
  else tokens.delete(host);
  clearSecret({ service: keychainService(), account: host });
  servers.delete(url);
  for (const s of sessions.values()) if (s.origin === url) { if (!token) setStatus(s, "signedOut"); reconnectNow(s); }
}

// ---------- the server ----------

interface ServerState { status: Status; email?: string; name?: string; role?: string; server?: string; protocol?: number; at: number }
const servers = new Map<string, ServerState>();

type Reply = { fail: Status } | { fail?: undefined; res: Response; json: any };

async function request(origin: string, path: string, init: { method?: string; body?: unknown } = {}): Promise<Reply> {
  const auth = await authHeaders(origin);
  if (!auth) return { fail: "signedOut" };
  let res: Response;
  try {
    res = await fetch(origin + path, {
      method: init.method ?? "GET",
      headers: { ...auth, ...(init.body !== undefined ? { "content-type": "application/json" } : {}) },
      body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
      redirect: "manual",
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    return { fail: "offline" };
  }
  const contentType = res.headers.get("content-type");
  let json: any = null;
  if (/json/i.test(contentType ?? "")) json = await res.json().catch(() => null);
  const verdict = classify({ status: res.status, type: res.type, contentType, code: json?.code });
  if (verdict === "signInAgain" && !isLocalDev(origin)) clearSecret({ service: keychainService(), account: hostOf(origin) });
  if (verdict !== "ok") return { fail: verdict };
  return { res, json };
}

/** Asks the server who we are and whether it speaks our protocol. At most one real request per 3 s. */
export async function checkServer(origin: string, force = false): Promise<ServerState> {
  const known = servers.get(origin);
  if (!force && known && Date.now() - known.at < 3000) return known;
  const set = (s: Omit<ServerState, "at">) => { const v = { ...s, at: Date.now() }; servers.set(origin, v); return v; };
  const info = await request(origin, "/v1/info");
  if (info.fail) return set({ status: info.fail });
  const protocol = Number(info.json?.protocol);
  if (!(info.res.ok && Number.isFinite(protocol))) return set({ status: "offline" });
  if (protocol < PROTOCOL_VERSION) return set({ status: "tooOld", protocol, server: info.json?.server });
  if (protocol > PROTOCOL_VERSION) return set({ status: "tooNew", protocol, server: info.json?.server });
  const me = await request(origin, "/v1/me");
  if (me.fail) return set({ status: me.fail, protocol });
  if (!me.res.ok) return set({ status: "offline", protocol });
  return set({ status: "connected", email: me.json?.email, name: me.json?.name, role: me.json?.role, protocol, server: info.json?.server });
}

// ---------- one room per shared file ----------

const MAX_BATCH = 50;
/** Ops sent per rolling minute: under the server's 120, so a big share paces itself instead of being refused. */
const OPS_PER_MINUTE = 100;

interface Session {
  pkg: string;
  display: string | null;
  origin: string;
  doc: string;
  status: Status;
  role?: string;
  ws?: WebSocket;
  ready: boolean;
  attempt: number;
  timer?: ReturnType<typeof setTimeout>;
  flushTimer?: ReturnType<typeof setTimeout>;
  inflight: Set<string>;
  sentAt: number[];
  stopped: boolean;
}
const sessions = new Map<string, Session>();

let notifier: (display: string | null, pkg: string) => void = () => {};
/** The server tells the pages of a file that its comments changed (src/server.ts: the "comments" event). */
export function onChanged(fn: (display: string | null, pkg: string) => void): void { notifier = fn; }
const notify = (s: Session) => notifier(s.display, s.pkg);

function setStatus(s: Session, status: Status): void {
  if (s.status === status) return;
  s.status = status;
  notify(s);
}

/** Reads, changes and writes the file in one step. `fn` says whether it changed anything. */
function mutate(s: Session, fn: (f: SyncFile) => boolean): void {
  let f: SyncFile | null;
  try {
    f = readCommentsFile(s.pkg) as SyncFile | null;
  } catch {
    return; // not readable comments: left as it is
  }
  if (!f || !isShared(f) || f.doc !== s.doc) { stop(s); return; }
  if (fn(f)) {
    try { writeCommentsFile(s.pkg, f); } catch { return; }
    notify(s);
  }
}

/** The backoff before the next try: 1 s doubling to 60 s, with up to 20 % jitter either way. */
export function backoffMs(attempt: number, rand = Math.random()): number {
  const base = Math.min(60_000, 1000 * 2 ** Math.min(attempt, 6));
  return Math.round(base * (0.8 + 0.4 * rand));
}

function schedule(s: Session): void {
  if (s.stopped) return;
  clearTimeout(s.timer);
  s.timer = setTimeout(() => void connect(s), backoffMs(s.attempt++));
  s.timer.unref?.();
}

function reconnectNow(s: Session): void {
  if (s.stopped) return;
  clearTimeout(s.timer);
  s.attempt = 0;
  try { s.ws?.close(); } catch { /* already closed */ }
  s.ws = undefined;
  s.ready = false;
  void connect(s);
}

async function connect(s: Session): Promise<void> {
  if (s.stopped || s.ws) return;
  const auth = await authHeaders(s.origin);
  if (s.stopped || s.ws) return;
  if (!auth) { setStatus(s, "signedOut"); schedule(s); return; }
  let ws: WebSocket;
  try {
    // Node's own WebSocket (undici) takes headers as an option, which a browser's does not.
    ws = new WebSocket(`${s.origin.replace(/^http/, "ws")}/v1/docs/${s.doc}/socket`, { headers: auth } as unknown as string[]);
  } catch {
    setStatus(s, "offline");
    schedule(s);
    return;
  }
  s.ws = ws;
  ws.onopen = () => send(s, { type: "hello", protocol: PROTOCOL_VERSION, doc: s.doc, since: seqOf(s) });
  ws.onmessage = (ev) => { try { onMessage(s, JSON.parse(String(ev.data)) as ServerMessage); } catch { /* a bad message is skipped */ } };
  ws.onerror = () => { /* the close that follows decides */ };
  ws.onclose = () => void closed(s, ws);
}

function seqOf(s: Session): number {
  try { return readCommentsFile(s.pkg)?.seq ?? 0; } catch { return 0; }
}

function send(s: Session, m: ClientMessage): void {
  if (s.ws && s.ws.readyState === WebSocket.OPEN) s.ws.send(JSON.stringify(m));
}

async function closed(s: Session, ws: WebSocket): Promise<void> {
  if (s.ws !== ws) return;
  s.ws = undefined;
  s.ready = false;
  s.inflight.clear();
  if (s.stopped) return;
  // Why: offline, signed out of Access, or no longer allowed. One cheap question tells them apart.
  const st = await checkServer(s.origin, true);
  if (s.stopped) return;
  setStatus(s, st.status === "connected" ? "offline" : st.status);
  schedule(s);
}

function onMessage(s: Session, m: ServerMessage): void {
  switch (m.type) {
    case "welcome": {
      if (m.protocol !== PROTOCOL_VERSION) { setStatus(s, m.protocol < PROTOCOL_VERSION ? "tooOld" : "tooNew"); s.ws?.close(); return; }
      mutate(s, (f) => {
        if (m.threads) snapshot(f, m.threads as Thread[], m.seq);
        f.me = m.me;
        return true;
      });
      s.ready = true;
      s.attempt = 0;
      s.role = m.role;
      setStatus(s, "connected");
      flush(s);
      return;
    }
    case "applied": {
      for (const e of m.entries) s.inflight.delete(e.opId);
      mutate(s, (f) => confirm(f, m.entries as Applied[]));
      flush(s);
      return;
    }
    case "ack": {
      s.inflight.delete(m.opId);
      mutate(s, (f) => acknowledge(f, m.opId, m.seq));
      flush(s);
      return;
    }
    case "reject": {
      const rate = (r: Rejected) => r.code === "quota" && /minute/i.test(r.message);
      for (const r of m.rejected) s.inflight.delete(r.opId);
      const hard = m.rejected.filter((r) => !rate(r));
      if (m.rejected.some(rate)) delayFlush(s, 20_000); // too many for this minute: they stay in the outbox
      mutate(s, (f) => reject(f, hard));
      flush(s);
      return;
    }
    case "error": {
      if (m.code === "version") setStatus(s, "tooOld");
      else if (m.code === "unauthenticated") setStatus(s, "signInAgain");
      else if (m.code === "forbidden") setStatus(s, "forbidden");
      return;
    }
  }
}

function delayFlush(s: Session, ms: number): void {
  clearTimeout(s.flushTimer);
  s.flushTimer = setTimeout(() => flush(s), ms);
  s.flushTimer.unref?.();
}

/** Sends what waits in the outbox: up to 50 ops at a time, no more than 100 in a minute, none twice before an answer. */
export function flush(s: Session): void {
  if (!s.ready || s.stopped) return;
  let f: SyncFile | null;
  try { f = readCommentsFile(s.pkg) as SyncFile | null; } catch { return; }
  if (!f) return;
  const now = Date.now();
  s.sentAt = s.sentAt.filter((t) => now - t < 60_000);
  const room = OPS_PER_MINUTE - s.sentAt.length;
  const todo = f.outbox.filter((e) => !s.inflight.has(e.opId));
  if (!todo.length) return;
  if (room <= 0) { delayFlush(s, s.sentAt[0] + 60_000 - now + 50); return; }
  if (s.inflight.size) return; // one batch at a time; the answer sends the next
  const batch = todo.slice(0, Math.min(MAX_BATCH, room));
  for (const e of batch) { s.inflight.add(e.opId); s.sentAt.push(now); }
  send(s, { type: "ops", ops: batch });
}

function stop(s: Session): void {
  s.stopped = true;
  clearTimeout(s.timer);
  clearTimeout(s.flushTimer);
  try { s.ws?.close(); } catch { /* already closed */ }
  s.ws = undefined;
  sessions.delete(s.pkg);
}

/** Closes every room socket (a test, or the server shutting down). */
export function stopAll(): void {
  for (const s of [...sessions.values()]) stop(s);
  servers.clear();
}

/** Closes one file's socket without unsharing it (a test of offline; the app uses it for nothing else). */
export function disconnect(pkg: string): boolean {
  const s = sessions.get(pkg);
  if (!s) return false;
  stop(s);
  return true;
}

/** A shared file was opened or changed here: its room is connected (once) and what waits is sent. */
function touch(pkg: string, display: string | null): void {
  let f: SyncFile | null;
  try { f = readCommentsFile(pkg) as SyncFile | null; } catch { return; }
  const live = sessions.get(pkg);
  if (!f || !isShared(f)) { if (live) stop(live); return; }
  if (live && (live.doc !== f.doc || live.origin !== f.server!.url)) stop(live);
  let s = sessions.get(pkg);
  if (!s) {
    s = { pkg, display, origin: f.server!.url, doc: f.doc, status: "offline", ready: false, attempt: 0, inflight: new Set(), sentAt: [], stopped: false };
    sessions.set(pkg, s);
    void connect(s);
    return;
  }
  if (display) s.display = display;
  flush(s);
}

function info(pkg: string, f: SyncFile): unknown {
  const s = sessions.get(pkg);
  const view = viewOf(f, { name: localName() });
  const { pending, rejected } = pendingStates(f, view);
  return {
    url: f.server!.url,
    host: hostOf(f.server!.url),
    status: s?.status ?? "offline",
    connected: !!s?.ready,
    role: s?.role,
    me: f.me ?? null,
    pending,
    rejected,
  };
}
hooks.touch = touch;
hooks.info = info;

// ---------- sharing ----------

export class CloudError extends CommentsError {}

const WHY: Record<string, string> = {
  signedOut: "Sign in to your team's server in Settings > Cloud first.",
  signInAgain: "Sign in again in Settings > Cloud.",
  offline: "The server did not answer. Check the address and your connection.",
  forbidden: "This account has no access to the team's server.",
  tooOld: "The team's server is too old for this version of Canvas. Update the server.",
  tooNew: "The team's server is newer than this Canvas. Update Canvas.",
};

/**
 * Shares the file's comments to the configured server: registers its doc, turns its threads into ops sent from this
 * person, and links the file (`server` in comments.json). A file already shared only connects.
 */
export async function shareFile(pkg: string, display: string | null): Promise<{ doc: string; url: string; already: boolean; ops: number }> {
  const existing = readCommentsFile(pkg) as SyncFile | null;
  if (existing && isShared(existing)) { touch(pkg, display); return { doc: existing.doc, url: existing.server!.url, already: true, ops: 0 }; }
  const { url } = cloudConfig();
  if (!url) throw new CloudError(400, "invalid", "Set your team's server address in Settings > Cloud first.");
  const st = await checkServer(url, true);
  if (st.status !== "connected") throw new CloudError(st.status === "offline" ? 502 : 401, st.status, WHY[st.status] ?? "Could not reach the server.");
  if (st.role !== "owner" && st.role !== "editor") throw new CloudError(403, "forbidden", "Only an owner or an editor can share a file to the server.");
  const file = (readCommentsFile(pkg) as SyncFile | null) ?? emptyComments();
  const reg = await request(url, "/v1/docs", { method: "POST", body: { doc: file.doc } });
  if (reg.fail) throw new CloudError(reg.fail === "offline" ? 502 : 401, reg.fail, WHY[reg.fail] ?? "Could not register the file.");
  if (!reg.res.ok) throw new CloudError(reg.res.status === 409 ? 409 : 403, "quota", String(reg.json?.message ?? "The server refused to register this file."));
  // Read again: a comment may have been made while the server answered.
  const fresh = (readCommentsFile(pkg) as SyncFile | null) ?? file;
  const me: Author = { email: st.email, name: st.name ?? localName() };
  const ops = opsForShare(fresh);
  writeCommentsFile(pkg, shareLocal(fresh, url, me, ops));
  touch(pkg, display);
  return { doc: fresh.doc, url, already: false, ops: ops.length };
}

// ---------- routes ----------

export async function handleCloudRoute(req: http.IncomingMessage, res: http.ServerResponse, url: URL, changed?: (file: string, pkg: string) => void): Promise<boolean> {
  const p = url.pathname;
  if (!(p.startsWith("/api/cloud/") || p === "/api/comments/retry" || p === "/api/comments/discard")) return false;
  const out = (status: number, body: unknown): true => {
    res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store", "x-content-type-options": "nosniff" });
    res.end(JSON.stringify(body));
    return true;
  };
  try {
    if (p === "/api/cloud/status") {
      if (req.method !== "GET") return out(405, { error: "method not allowed" });
      const cfg = cloudConfig();
      if (!cfg.url) return out(200, { configured: false, url: "", host: "", status: "signedOut", dev: false });
      const st = await checkServer(cfg.url);
      return out(200, { configured: true, url: cfg.url, host: hostOf(cfg.url), dev: isLocalDev(cfg.url), status: st.status, email: st.email ?? null, name: st.name ?? null, role: st.role ?? null, server: st.server ?? null });
    }
    if (req.method !== "POST") return out(405, { error: "method not allowed" });
    if (req.headers["x-canvas"] !== "1") return out(403, { error: "forbidden", code: "forbidden" });
    if (!String(req.headers["content-type"] ?? "").startsWith("application/json")) return out(415, { error: "The request body must be JSON" });
    const raw = await readBodyText(req, 64 * 1024);
    if (raw === null) return out(413, { error: "too large" });
    let body: Record<string, unknown>;
    try { body = JSON.parse(raw || "{}"); } catch { return out(400, { error: "The request body must be JSON" }); }
    if (p === "/api/cloud/token" || p === "/api/cloud/signout") {
      const target = typeof body.url === "string" ? body.url : "";
      const origin = safeOrigin(target);
      if (!origin || origin !== cloudConfig().url) return out(400, { error: "That is not the configured server" });
      if (p === "/api/cloud/signout") { setToken(origin, null); return out(200, { ok: true }); }
      const t = body.token;
      if (typeof t !== "string" || !/^[A-Za-z0-9._~+/=-]{8,8192}$/.test(t) || isLocalDev(origin)) return out(400, { error: "That is not an Access token for this server" });
      setToken(origin, t);
      return out(200, { ok: true });
    }
    const file = url.searchParams.get("file");
    if (!file) return out(400, { error: "file is required" });
    const pkg = packageOf(file);
    if (p === "/api/cloud/share") {
      const r = await shareFile(pkg, file);
      changed?.(file, pkg);
      return out(200, r);
    }
    // retry and discard
    const opId = typeof body.opId === "string" ? body.opId : "";
    const f = readCommentsFile(pkg) as SyncFile | null;
    if (!f || !isShared(f)) return out(404, { error: "This file is not shared", code: "not_found" });
    const done = p === "/api/comments/retry" ? retry(f, opId) : discard(f, opId);
    if (!done) return out(404, { error: "No such refused comment", code: "not_found" });
    writeCommentsFile(pkg, f);
    touch(pkg, file);
    changed?.(file, pkg);
    return out(200, { ok: true, threads: viewOf(f, { name: localName() }), sync: info(pkg, f) });
  } catch (e) {
    if (e instanceof CommentsError) return out(e.status, { error: e.message, code: e.code });
    return out(500, { error: (e as Error).message });
  }
}

function safeOrigin(u: string): string {
  try { return new URL(u).origin; } catch { return ""; }
}
