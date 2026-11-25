// Talking to the Clouds this Canvas was given (cloud/adapters/cloudflare servers, Clouds hosted on a Mac): who we are at each,
// one room socket per open shared file, sharing a file, and the routes the app and the page use. What the messages
// mean for comments.json is in src/cloud-sync.ts; this file only moves them.
//
//   GET  /api/cloud/status?url=            one Cloud: { url, host, status, email, role, ... } (asks it at most every 3 s);
//                                          404 for an address that is not one of this Canvas's Clouds
//   GET  /api/cloud/status                 { clouds: [ the same, for each Cloud ] }
//   POST /api/cloud/token  { url, token }  the Access token the app got from its sign-in window. Kept in MEMORY only.
//   POST /api/cloud/signout { url }        forget it (memory and Keychain), and do not read the Keychain again until a new one
//   POST /api/cloud/remove { url }         stop talking to that Cloud: sockets, tunnel, token, invite all go at once
//   POST /api/cloud/share?file=&url=       share the open file's comments to that Cloud (the only one when there is one)
//   POST /api/comments/retry|discard?file= { opId }  for a comment the server refused
//
// Every request, socket and Keychain read goes through `target`, which refuses any address that is not, exactly, one
// of the Clouds in src/cloud-config.ts. A file's comments.json names its Cloud; a file whose Cloud is not in the list
// (or whose address is not a safe one, like http to another host) is never connected: its status is "notAdded" and its
// comments wait in the outbox until the Cloud is added again.
//
// The token: the shell (apps/macos/CloudSettings.swift) reads the `CF_Authorization` cookie of the sign-in window and
// writes it to the Keychain; it also posts it here so this process need not ask the Keychain for every request. After
// a restart this process reads the Keychain item (src/widgets/keychain.ts, the same read-only way widgets read theirs).
// The token is sent as `cf-access-token` to the configured server only, never written to a file, never logged.
// For http://localhost or http://127.0.0.1 (a server run with DEV=1) it sends `x-canvas-dev-email` instead, and for no
// other host.
//
// A Cloud hosted on a Mac (canvas-cloud://<host id>, src/cloud-host.ts) is another kind: never a dev email, never an
// Access token. This Mac reaches it through its own tunnel helper's local port (checked to be the helper's), or on
// 127.0.0.1 when it is the host, with `authorization: Bearer <device token>`. When it cannot be reached at all the
// status is "down": the host's Mac is asleep, closed or offline; comments wait in the outbox.

import { createHash } from "node:crypto";
import fs from "node:fs";
import type http from "node:http";
import path from "node:path";
import { isVoteOp, PROTOCOL_VERSION, type Applied, type Author, type ClientMessage, type Rejected, type ServerMessage, type Thread } from "../cloud/protocol.ts";
import { readBodyText } from "./body.ts";
import { addCloud, bump, cleanServerUrl, cloudConfigs, devEmailFor, generation, hostedId, hostedUrl, hostOf, isConfigured, isLocalDev, onCloudsChanged, parseInvite, removeCloud } from "./cloud-config.ts";
import { hostsHere, hostStatus, hostStatusAll, invite, localHost, removePerson, startHosting, stopHosting, wipeHosting } from "./cloud-host.ts";
import { deleteJoined, readJoined, writeJoined, type JoinedSecrets } from "./cloud-secrets.ts";
import { forward, genkey, helperPath, hostIdFor, type Helper } from "./cloud-tunnel.ts";
import { newSecret } from "../cloud/adapters/mac/host.ts";
import { acknowledge, confirm, discard, hooks, isShared, opsForShare, pendingStates, reject, retry, shareLocal, snapshot, viewOf, type SyncFile } from "./cloud-sync.ts";
import { CommentsError, emptyComments, readCommentsFile, writeCommentsFile } from "./comments-file.ts";
import { localName, packageOf } from "./comments.ts";
import { stateDir } from "./usage-counts.ts";
import { clearSecret, getSecret } from "./widgets/keychain.ts";

export type Status = "signedOut" | "connected" | "offline" | "signInAgain" | "forbidden" | "tooOld" | "tooNew" | "down" | "removed" | "unavailable" | "notAdded";

/**
 * Test seams for races: called right after `target` answered (before anything is sent), and after a join's answer
 * (before anything is saved), or just before a join request. Tests remove a Cloud there to prove nothing goes out
 * or is kept. Never set otherwise.
 */
export const testHooks: { afterTarget?: (url: string) => void; beforeJoinRequest?: (url: string) => void | Promise<void>; afterJoinAnswer?: (url: string) => void | Promise<void> } = {};

/** Thrown inside a Cloud's work when it was removed or signed out of meanwhile: nothing more happens for it. */
const outdated = () => Object.assign(new Error("This Cloud was removed"), { status: "notAdded" as Status });

// ---------- hosted Clouds: where they are reached ----------

const joinedCache = new Map<string, JoinedSecrets | null>();
const forwards = new Map<string, { helper: Helper; origin: string } | Promise<{ helper: Helper; origin: string }>>();

async function joinedSecrets(id: string, url: string, g: number): Promise<JoinedSecrets | null> {
  // Only a found item is kept: a Cloud joined later (or by the shell) is read again.
  if (joinedCache.get(id)) return joinedCache.get(id)!;
  const s = await readJoined(id);
  if (generation(url) !== g) throw outdated(); // left or removed while the Keychain answered: nothing is kept
  if (s) joinedCache.set(id, s);
  return s;
}

/** The local origin of a joined Cloud's tunnel: this Mac's helper, started once and again when it dies. */
async function tunnelOrigin(id: string, s: JoinedSecrets, url: string, g: number): Promise<string> {
  const known = forwards.get(id);
  if (known && !(known instanceof Promise) && known.helper.alive) return known.origin;
  if (known instanceof Promise) {
    const f = await known;
    if (generation(url) !== g) throw outdated();
    return f.origin;
  }
  const bin = helperPath();
  if (!bin) throw Object.assign(new Error("no helper"), { status: "unavailable" });
  const p = forward(bin, s.key, s.addr).then((f) => {
    // Removed while the helper started (closeTunnel found only this promise): the helper goes now, unused.
    if (generation(url) !== g) { f.helper.stop(); throw outdated(); }
    // The tunnel must reach the member key pinned when this Mac joined; anything else gets no token.
    if (s.memberKey && f.server !== s.memberKey) { f.helper.stop(); throw Object.assign(new Error("The Cloud's key changed"), { status: "down" }); }
    return f;
  });
  forwards.set(id, p);
  try {
    const f = await p;
    // Closed meanwhile (a request through it failed, or the Cloud was left): this helper is not used.
    if (forwards.get(id) !== p) { f.helper.stop(); throw generation(url) !== g ? outdated() : Object.assign(new Error("The tunnel closed"), { status: "down" as Status }); }
    forwards.set(id, f);
    f.helper.onExit = () => { if (forwards.get(id) === f) forwards.delete(id); };
    return f.origin;
  } catch (e) {
    if (forwards.get(id) === p) forwards.delete(id);
    throw e;
  }
}

/**
 * Where to send a request for a Cloud address, and as whom. Only for an address that is exactly one of this Canvas's
 * Clouds: anything else (an address a file names but the person removed, http to another host) is refused before
 * any Keychain read. For a hosted Cloud this starts its tunnel if needed.
 */
export async function target(url: string): Promise<{ base: string; headers: Record<string, string>; hosted: boolean } | { fail: Status }> {
  if (!isConfigured(url)) return { fail: "notAdded" };
  const g = generation(url);
  const id = hostedId(url);
  if (!id) {
    const headers = await authHeaders(url);
    if (generation(url) !== g || !isConfigured(url)) return { fail: "notAdded" };
    return headers ? { base: url, headers, hosted: false } : { fail: "signedOut" };
  }
  const self = localHost(id);
  if (self) return { base: self.origin, headers: { authorization: `Bearer ${self.token}` }, hosted: true };
  try {
    const s = await joinedSecrets(id, url, g);
    if (!s) return { fail: "signedOut" };
    const base = await tunnelOrigin(id, s, url, g);
    if (generation(url) !== g || !isConfigured(url)) return { fail: "notAdded" };
    return { base, headers: { authorization: `Bearer ${s.token}` }, hosted: true };
  } catch (e) {
    return { fail: (e as { status?: Status }).status ?? "down" };
  }
}

/** How a joined Cloud's traffic goes now: "direct" between the two Macs, "relay", or null (unknown, or not a tunnel). */
export function tunnelPath(url: string): "direct" | "relay" | null {
  const id = hostedId(url);
  const f = id ? forwards.get(id) : undefined;
  const e = f && !(f instanceof Promise) && f.helper.alive ? f.helper.last.get("path") : undefined;
  return e ? (e.direct ? "direct" : "relay") : null;
}

/** Stops a joined Cloud's tunnel helper (leaving, removing, or a test). A helper still starting is stopped once it has. */
export function closeTunnel(id: string): void {
  const f = forwards.get(id);
  forwards.delete(id);
  if (f instanceof Promise) f.then((x) => x.helper.stop(), () => {});
  else f?.helper.stop();
}

/** The Keychain item the shell writes the token to (account: the server's host). The service is overridable for tests. */
export const keychainService = () => process.env.CANVAS_CLOUD_KEYCHAIN_SERVICE || "cc.getcanvas.canvas.cloud";

const tokens = new Map<string, string>();
/** Hosts signed out of in this run: the Keychain is not read for them again until a new token arrives. */
const signedOut = new Set<string>();

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

/**
 * The headers that say who we are to `origin`, one of this Canvas's Clouds: the development email given for exactly
 * that address (port included) for a local development server, else the Access token. Null for anything else.
 */
export async function authHeaders(origin: string): Promise<Record<string, string> | null> {
  if (!isConfigured(origin) || hostedId(origin)) return null;
  if (isLocalDev(origin)) {
    const email = devEmailFor(origin);
    return email ? { "x-canvas-dev-email": email } : null;
  }
  const host = hostOf(origin);
  if (signedOut.has(host)) return null;
  let t = tokens.get(host);
  if (!t) {
    const g = generation(origin);
    try {
      t = (await getSecret({ service: keychainService(), account: host })).trim();
    } catch {
      return null;
    }
    // Signed out or removed while the Keychain answered: that answer is not used, nor kept.
    if (generation(origin) !== g || signedOut.has(host) || !isConfigured(origin)) { clearSecret({ service: keychainService(), account: host }); return null; }
    if (t) tokens.set(host, t);
  }
  return t ? { "cf-access-token": t } : null;
}

/** A new token (signed in), or none (signed out: memory, the Keychain item and the status go together). */
export function setToken(url: string, token: string | null): void {
  const host = hostOf(url);
  clearSecret({ service: keychainService(), account: host });
  servers.delete(url);
  if (token) {
    tokens.set(host, token);
    signedOut.delete(host);
    for (const s of sessions.values()) if (s.origin === url) reconnectNow(s);
    return;
  }
  // The shell deleted the Keychain item before it said so (it is the item's only writer, so a sign-in right after
  // cannot race a delete from here). A Keychain read still under way is dropped by the generation.
  tokens.delete(host);
  signedOut.add(host);
  bump(url);
  for (const s of sessions.values()) if (s.origin === url) { setStatus(s, "signedOut"); reconnectNow(s); }
}

// ---------- the server ----------

interface ServerState { status: Status; email?: string; name?: string; role?: string; server?: string; protocol?: number; at: number; devEmail: string }

/**
 * How long a status answer is reused, so the team's server is not asked on every look. A connected server is asked
 * again after a minute (an open room socket to it counts as a newer answer); any other answer after 3 s, so a fix shows
 * quickly. `fresh` (the app came to the front, Home or Settings opened) asks again once the answer is 3 s old.
 */
export const STATUS_REUSE_MS = { connected: 60_000, other: 3_000, fresh: 3_000 };
const servers = new Map<string, ServerState>();

type Reply = { fail: Status } | { fail?: undefined; res: Response; json: any };

async function request(origin: string, path: string, init: { method?: string; body?: unknown } = {}): Promise<Reply> {
  const g = generation(origin);
  const t = await target(origin);
  if ("fail" in t) return { fail: t.fail };
  testHooks.afterTarget?.(origin);
  // Removed or signed out of after `target` answered: its headers are not sent.
  if (generation(origin) !== g || !isConfigured(origin)) return { fail: "notAdded" };
  let res: Response;
  try {
    res = await fetch(t.base + path, {
      method: init.method ?? "GET",
      headers: { ...t.headers, ...(init.body !== undefined ? { "content-type": "application/json" } : {}) },
      body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
      redirect: "manual",
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    // A hosted Cloud that does not answer through its tunnel: its Mac is asleep, closed or offline.
    if (t.hosted) { const id = hostedId(origin); if (id) closeTunnel(id); }
    return { fail: t.hosted ? "down" : "offline" };
  }
  const contentType = res.headers.get("content-type");
  let json: any = null;
  if (/json/i.test(contentType ?? "")) json = await res.json().catch(() => null);
  if (t.hosted) {
    // The tunnel pins the host's key, so this answer is the host's own. A 401 means this device was removed; the
    // Keychain item stays until the person leaves the Cloud (Settings > Cloud), so nothing is lost by a mistake.
    if (res.status === 401) return { fail: "removed" };
    if (res.status === 403) return { fail: "forbidden" };
    if (res.status >= 500 || res.status === 429) return { fail: "down" };
    return { res, json };
  }
  const verdict = classify({ status: res.status, type: res.type, contentType, code: json?.code });
  if (verdict === "signInAgain" && !isLocalDev(origin)) clearSecret({ service: keychainService(), account: hostOf(origin) });
  if (verdict !== "ok") return { fail: verdict };
  return { res, json };
}

/** Asks the server who we are and whether it speaks our protocol, reusing a recent answer (STATUS_REUSE_MS). */
export async function checkServer(origin: string, force = false, fresh = false): Promise<ServerState> {
  const devEmail = devEmailFor(origin);
  if (!isConfigured(origin)) return { status: "notAdded", at: Date.now(), devEmail };
  const g = generation(origin);
  const known = servers.get(origin);
  if (!force && known && known.devEmail === devEmail) {
    const age = Date.now() - known.at;
    const reuse = fresh ? STATUS_REUSE_MS.fresh : known.status === "connected" ? STATUS_REUSE_MS.connected : STATUS_REUSE_MS.other;
    if (age < reuse) return known;
    // A room socket that is up says the same as asking, without a request.
    if (!fresh && known.status === "connected" && [...sessions.values()].some((s) => s.origin === origin && s.status === "connected")) {
      known.at = Date.now();
      return known;
    }
  }
  // Once a hosted Cloud said this Mac was removed, its tunnel stops letting it in, which looks like "down": it stays "removed".
  const set = (s: Omit<ServerState, "at" | "devEmail">): ServerState => {
    // Removed or signed out of while it answered: the answer is not kept, and says so.
    if (generation(origin) !== g || !isConfigured(origin)) return { status: isConfigured(origin) ? "signedOut" : "notAdded", at: Date.now(), devEmail };
    const v = { ...s, status: s.status === "down" && known?.status === "removed" ? "removed" as Status : s.status, at: Date.now(), devEmail };
    servers.set(origin, v);
    return v;
  };
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
  if (s.status === "removed" && status === "down") return; // see checkServer: a removed Mac is kept out by the tunnel too
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
  const g = generation(s.origin);
  const t = await target(s.origin);
  if (s.stopped || s.ws) return;
  if (!("fail" in t)) testHooks.afterTarget?.(s.origin);
  // Removed, signed out of, or its development email changed after `target` answered: no socket with those headers.
  if (!("fail" in t) && (generation(s.origin) !== g || !isConfigured(s.origin))) { if (isConfigured(s.origin)) schedule(s); else park(s); return; }
  // Not one of this Canvas's Clouds (any more): no socket, no retry; it wakes when the Cloud is added again.
  if ("fail" in t && t.fail === "notAdded" && !isConfigured(s.origin)) { park(s); return; }
  if ("fail" in t) { setStatus(s, t.fail); schedule(s); return; }
  let ws: WebSocket;
  try {
    // Node's own WebSocket (undici) takes headers as an option, which a browser's does not.
    ws = new WebSocket(`${t.base.replace(/^http/, "ws")}/v1/docs/${s.doc}/socket`, { headers: t.headers } as unknown as string[]);
  } catch {
    setStatus(s, "offline");
    schedule(s);
    return;
  }
  s.ws = ws;
  if (t.hosted) watch(s, ws);
  ws.onopen = () => { if (s.ws === ws && !s.stopped) send(s, { type: "hello", protocol: PROTOCOL_VERSION, doc: s.doc, since: seqOf(s) }); };
  ws.onmessage = (ev) => {
    if (s.ws !== ws || s.stopped) return; // a socket this session no longer owns (removed, signed out) says nothing
    try { onMessage(s, JSON.parse(String(ev.data)) as ServerMessage); } catch { /* a bad message is skipped */ }
  };
  ws.onerror = () => { /* the close that follows decides */ };
  ws.onclose = () => void closed(s, ws);
}

/**
 * A hosted Cloud's Mac can vanish without closing anything (a lid shut): no close ever arrives. While its socket is
 * open, the Cloud is asked every 20 s; no answer in 10 s and the socket is closed, which reads as "Cloud down".
 */
function watch(s: Session, ws: WebSocket): void {
  const timer = setInterval(async () => {
    if (s.ws !== ws) { clearInterval(timer); return; }
    const r = await request(s.origin, "/v1/info").catch(() => ({ fail: "down" as Status }));
    if (s.ws === ws && r.fail === "down") { try { ws.close(); } catch { /* closed */ } void closed(s, ws); }
  }, Number(process.env.CANVAS_CLOUD_WATCH_MS) || 20_000);
  timer.unref?.();
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
  if (!isConfigured(s.origin)) { park(s); return; }
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
      else if (m.code === "unauthenticated" && hostedId(s.origin)) {
        // A hosted Cloud says this Mac was removed, just before its tunnel shuts the Mac out: kept, so it never reads "down".
        const known = servers.get(s.origin);
        if (isConfigured(s.origin)) servers.set(s.origin, { ...(known ?? { devEmail: devEmailFor(s.origin) }), status: "removed", at: Date.now() });
        setStatus(s, "removed");
      } else if (m.code === "unauthenticated") setStatus(s, "signInAgain");
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
  // Vote ops stay in the outbox until the room implements private ballots and vote snapshots.
  const todo = f.outbox.filter((e) => !isVoteOp(e.op) && !s.inflight.has(e.opId));
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

/**
 * Files whose Cloud is not one of this Canvas's Clouds now: never connected, their comments wait in the outbox. When
 * that Cloud is added again they connect (onCloudsChanged below).
 */
const parked = new Map<string, string | null>();
function park(s: Session): void {
  stop(s);
  parked.set(s.pkg, s.display);
  notify(s);
}

/** Everything that belonged to a Cloud that is gone: sockets, timers, tunnel, cached answers and secrets in memory. */
function forget(url: string): void {
  servers.delete(url);
  for (const s of [...sessions.values()]) if (s.origin === url) park(s);
  const id = hostedId(url);
  if (id) { closeTunnel(id); joinedCache.delete(id); }
  else { tokens.delete(hostOf(url)); clearSecret({ service: keychainService(), account: hostOf(url) }); }
}

onCloudsChanged((removed, back) => {
  for (const url of removed) forget(url);
  if (!back.length) return;
  for (const [pkg, display] of [...parked]) {
    let f: SyncFile | null = null;
    try { f = readCommentsFile(pkg) as SyncFile | null; } catch { /* unreadable: stays parked */ }
    if (f?.server?.url && back.includes(f.server.url)) { parked.delete(pkg); touch(pkg, display); }
  }
});

/** Closes every room socket and joined Cloud tunnel (a test, or the server shutting down). */
export function stopAll(): void {
  for (const s of [...sessions.values()]) stop(s);
  for (const id of [...forwards.keys()]) closeTunnel(id);
  servers.clear();
  parked.clear();
}

/** Closes one file's socket without unsharing it (a test of offline; the app uses it for nothing else). */
export function disconnect(pkg: string): boolean {
  const s = sessions.get(pkg);
  if (!s) return false;
  stop(s);
  return true;
}

/** A shared file was opened or changed here: its room is connected (once) and what waits is sent. */
// ---------- files this Mac vouches for ----------
//
// A comments.json can come from anyone (a copy, a sync folder, a download) and name one of this person's Clouds, with
// ops waiting in its outbox. Those must never go out as this person without them saying so. So the first time a
// shared file (its folder, doc and Cloud) is seen here, whatever waits in its outbox moves to the refused list with a
// plain reason: Retry sends it as them, Discard drops it. A file shared from this Mac is vouched for when it is shared.
// <state>/cloud-known.json keeps hashes of (folder, doc, Cloud), never a path or a name in clear.

const UNVOUCHED = "This file arrived with it waiting to be sent. Retry sends it as you";
const KNOWN_MAX = 5000;
const knownFile = () => path.join(stateDir(), "cloud-known.json");
function knownKey(pkg: string, f: SyncFile): string {
  let real = pkg;
  try { real = fs.realpathSync(pkg); } catch { /* as given */ }
  return createHash("sha256").update(`${real}\n${f.doc}\n${f.server?.url ?? ""}`).digest("hex").slice(0, 32);
}
function readKnown(): string[] {
  try { const a = JSON.parse(fs.readFileSync(knownFile(), "utf8")); return Array.isArray(a) ? a.filter((x) => typeof x === "string") : []; } catch { return []; }
}
function markKnown(key: string): void {
  const list = readKnown().filter((k) => k !== key);
  list.push(key);
  try {
    fs.mkdirSync(stateDir(), { recursive: true });
    const tmp = `${knownFile()}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(list.slice(-KNOWN_MAX)), { mode: 0o600 });
    fs.renameSync(tmp, knownFile());
  } catch { /* not kept: the next look holds back again, which only asks once more */ }
}
export function vouch(pkg: string, f: SyncFile): boolean {
  if (!isShared(f)) return false;
  const key = knownKey(pkg, f);
  if (readKnown().includes(key)) return false;
  markKnown(key);
  const comments = f.outbox.filter(e => !isVoteOp(e.op));
  if (!comments.length) return false;
  f.rejected = [...(f.rejected ?? []), ...comments.map((envelope) => ({ envelope, code: "forbidden" as const, message: UNVOUCHED }))];
  f.outbox = f.outbox.filter(e => isVoteOp(e.op));
  return true;
}
hooks.vouch = vouch;

function touch(pkg: string, display: string | null): void {
  let f: SyncFile | null;
  try { f = readCommentsFile(pkg) as SyncFile | null; } catch { return; }
  const live = sessions.get(pkg);
  if (!f || !isShared(f)) { if (live) stop(live); parked.delete(pkg); return; }
  if (vouch(pkg, f)) { try { writeCommentsFile(pkg, f); } catch { return; } notifier(display, pkg); }
  if (live && (live.doc !== f.doc || live.origin !== f.server!.url)) stop(live);
  // A Cloud this Canvas does not have (removed, never added, or an address that is not safe): nothing connects.
  if (!isConfigured(f.server!.url)) { const l = sessions.get(pkg); if (l) stop(l); parked.set(pkg, display ?? parked.get(pkg) ?? null); return; }
  parked.delete(pkg);
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
    status: s?.status ?? (isConfigured(f.server!.url) ? "offline" : "notAdded"),
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
  signedOut: "Sign in to this Cloud in Settings > Cloud first.",
  notAdded: "That Cloud is not one of your Clouds. Add it in Home > Add Cloud.",
  down: "The Cloud isn't open right now. Its Mac may be asleep or closed.",
  removed: "The host removed this Mac from the Cloud. Ask them for a new invite.",
  unavailable: "This Canvas has no tunnel helper, so it cannot reach a Cloud hosted on a Mac.",
  signInAgain: "Sign in again in Settings > Cloud.",
  offline: "The server did not answer. Check the address and your connection.",
  forbidden: "This account has no access to the team's server.",
  tooOld: "The team's server is too old for this version of Canvas. Update the server.",
  tooNew: "The team's server is newer than this Canvas. Update Canvas.",
};

/** Shares run one at a time per file: two at once (to two Clouds, or twice) could both register and both write. */
const sharing = new Map<string, Promise<unknown>>();

/**
 * Shares the file's comments to `url`, one of this Canvas's Clouds (with none given: the only one, when there is
 * exactly one): registers its doc, turns its threads into ops sent from this person, and links the file (`server` in
 * comments.json). A file already shared keeps its Cloud and only connects; the answer names that Cloud.
 */
export function shareFile(pkg: string, display: string | null, to?: string | null): Promise<{ doc: string; url: string; already: boolean; ops: number }> {
  const prev = sharing.get(pkg) ?? Promise.resolve();
  const run = prev.catch(() => {}).then(() => shareOnce(pkg, display, to));
  sharing.set(pkg, run);
  void run.catch(() => {}).finally(() => { if (sharing.get(pkg) === run) sharing.delete(pkg); });
  return run;
}

const failStatus = (s: Status) => (s === "offline" || s === "down" ? 502 : s === "notAdded" ? 404 : 401);

async function shareOnce(pkg: string, display: string | null, to?: string | null): Promise<{ doc: string; url: string; already: boolean; ops: number }> {
  const existing = readCommentsFile(pkg) as SyncFile | null;
  if (existing && isShared(existing)) { touch(pkg, display); return { doc: existing.doc, url: existing.server!.url, already: true, ops: 0 }; }
  let url: string;
  if (to) {
    const clean = cleanServerUrl(to);
    if (!clean || !isConfigured(clean)) throw new CloudError(404, "not_found", WHY.notAdded);
    url = clean;
  } else {
    const all = cloudConfigs();
    if (!all.length) throw new CloudError(400, "invalid", "Add a Cloud first: Home > Add Cloud.");
    if (all.length > 1) throw new CloudError(400, "invalid", "Choose which Cloud to share to.");
    url = all[0].url;
  }
  const g = generation(url);
  const gone = () => generation(url) !== g || !isConfigured(url);
  const st = await checkServer(url, true);
  if (gone()) throw new CloudError(404, "not_found", WHY.notAdded);
  if (st.status !== "connected") throw new CloudError(failStatus(st.status), st.status, WHY[st.status] ?? "Could not reach the Cloud.");
  if (st.role !== "owner" && st.role !== "editor") throw new CloudError(403, "forbidden", "Only an owner or an editor can share a file to this Cloud.");
  const file = (readCommentsFile(pkg) as SyncFile | null) ?? emptyComments();
  const reg = await request(url, "/v1/docs", { method: "POST", body: { doc: file.doc } });
  if (gone()) throw new CloudError(404, "not_found", WHY.notAdded);
  if (reg.fail) throw new CloudError(failStatus(reg.fail), reg.fail, WHY[reg.fail] ?? "Could not register the file.");
  if (!reg.res.ok) throw new CloudError(reg.res.status === 409 ? 409 : 403, "quota", String(reg.json?.message ?? "The Cloud refused to register this file."));
  // Read again: a comment may have been made while the Cloud answered, and the file may have been linked meanwhile
  // (another Canvas process, or a copy put in place): a file already shared keeps its Cloud.
  const fresh = (readCommentsFile(pkg) as SyncFile | null) ?? file;
  if (isShared(fresh)) { touch(pkg, display); return { doc: fresh.doc, url: fresh.server!.url, already: true, ops: 0 }; }
  if (fresh.doc !== file.doc) throw new CloudError(409, "conflict", "The file's comments changed while sharing. Try again.");
  const me: Author = { email: st.email, name: st.name ?? localName() };
  const ops = opsForShare(fresh);
  const shared = shareLocal(fresh, url, me, ops);
  markKnown(knownKey(pkg, shared)); // shared from this Mac: its ops are this person's
  writeCommentsFile(pkg, shared);
  touch(pkg, display);
  return { doc: fresh.doc, url, already: false, ops: ops.length };
}

/** What Settings and Home show for one Cloud. */
async function cloudStatus(origin: string, fresh: boolean): Promise<Record<string, unknown>> {
  const st = await checkServer(origin, false, fresh);
  const id = hostedId(origin);
  return {
    url: origin, host: hostOf(origin), dev: isLocalDev(origin), hosted: !!id, hostedHere: !!id && !!localHost(id),
    via: tunnelPath(origin), status: st.status, email: st.email ?? null, name: st.name ?? null, role: st.role ?? null, server: st.server ?? null,
  };
}

/**
 * Removes a Cloud from this process: nothing goes to it from now on (src/cloud-config.ts removeCloud holds it back
 * until a newer list from the shell names it again). Its sockets, timers, tunnel and cached answers go, and the
 * invite of a joined Cloud is deleted from the Keychain. The shell deletes an Access token's Keychain item itself.
 * Files shared there keep their comments here; nothing is deleted on the Cloud.
 */
export async function removeCloudHere(url: string): Promise<void> {
  removeCloud(url); // bumps the generation and runs forget(): sockets, tunnel, caches
  const id = hostedId(url);
  if (id && !(await hostsHere(id))) await deleteJoined(id);
  if (id) joinedCache.delete(id);
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
      const fresh = url.searchParams.get("fresh") === "1";
      const one = url.searchParams.get("url");
      if (one !== null) {
        // Only one of this Canvas's Clouds is ever asked: any other address is not looked up at all.
        if (!isConfigured(one)) return out(404, { error: "That is not one of your Clouds", code: "not_found" });
        return out(200, await cloudStatus(one, fresh));
      }
      return out(200, { clouds: await Promise.all(cloudConfigs().map((c) => cloudStatus(c.url, fresh))) });
    }
    if (p === "/api/cloud/host" && req.method === "GET") {
      const id = url.searchParams.get("hostId");
      return out(200, id ? await hostStatus(hostIdArg({ hostId: id }) ?? "00000000-0000-0000-0000-000000000000") : await hostStatusAll());
    }
    if (req.method !== "POST") return out(405, { error: "method not allowed" });
    if (req.headers["x-canvas"] !== "1") return out(403, { error: "forbidden", code: "forbidden" });
    if (!String(req.headers["content-type"] ?? "").startsWith("application/json")) return out(415, { error: "The request body must be JSON" });
    const raw = await readBodyText(req, 64 * 1024);
    if (raw === null) return out(413, { error: "too large" });
    let body: Record<string, unknown>;
    try { body = JSON.parse(raw || "{}"); } catch { return out(400, { error: "The request body must be JSON" }); }
    const host = await hostRoute(p, body);
    if (host) return out(host[0], host[1]);
    if (p === "/api/cloud/token" || p === "/api/cloud/signout") {
      const origin = cleanServerUrl(body.url);
      if (!origin || !isConfigured(origin) || hostedId(origin)) return out(400, { error: "That is not one of your Clouds" });
      if (p === "/api/cloud/signout") { setToken(origin, null); return out(200, { ok: true }); }
      const t = body.token;
      if (typeof t !== "string" || !/^[A-Za-z0-9._~+/=-]{8,8192}$/.test(t) || isLocalDev(origin)) return out(400, { error: "That is not an Access token for this Cloud" });
      setToken(origin, t);
      return out(200, { ok: true });
    }
    if (p === "/api/cloud/remove") {
      const origin = cleanServerUrl(body.url);
      if (!origin) return out(400, { error: "That is not a Cloud address" });
      await removeCloudHere(origin);
      return out(200, { ok: true });
    }
    const file = url.searchParams.get("file");
    if (!file) return out(400, { error: "file is required" });
    const pkg = packageOf(file);
    if (p === "/api/cloud/share") {
      const to = url.searchParams.get("url");
      const r = await shareFile(pkg, file, to);
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

// ---------- hosting and joining (Settings > Cloud) ----------

const text = (v: unknown, max: number) => (typeof v === "string" ? v.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, max) : "");
/** The hosted Cloud a host route is for (`hostId`, an id), or null: the only one running. */
const hostIdArg = (body: Record<string, unknown>): string | null => (typeof body.hostId === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(body.hostId) ? body.hostId.toLowerCase() : null);

/** The host and join routes, or null for another path. Errors never carry a secret. */
async function hostRoute(p: string, body: Record<string, unknown>): Promise<[number, unknown] | null> {
  const fail = (e: unknown, status = 400): [number, unknown] => [status, { error: (e as Error).message }];
  try {
    switch (p) {
      case "/api/cloud/host/start": {
        // A host id: that Cloud again. None: a new Cloud (this Mac may host several, one per team).
        const id = await startHosting({ name: text(body.name, 60), label: text(body.label, 120) || "Host", hostId: hostIdArg(body) });
        // The hosting Canvas is a member of its own Cloud, on loopback, from now on. The shell adds the entry it gets
        // back (`url`); until its next list, this process counts it as added (src/cloud-config.ts addCloud).
        addCloud(hostedUrl(id));
        servers.delete(hostedUrl(id));
        return [200, { ...(await hostStatus(id)), url: hostedUrl(id) }];
      }
      case "/api/cloud/host/stop": {
        const id = hostIdArg(body);
        await stopHosting(id);
        if (id) servers.delete(hostedUrl(id));
        return [200, await hostStatus(id)];
      }
      case "/api/cloud/host/wipe": {
        const id = hostIdArg(body);
        await wipeHosting(id);
        return [200, await hostStatus(id)];
      }
      case "/api/cloud/host/invite":
        return [200, { link: await invite(text(body.label, 120), text(body.role, 20) || undefined, hostIdArg(body)) }];
      case "/api/cloud/host/remove": {
        const id = hostIdArg(body);
        await removePerson(text(body.personId, 64), id);
        return [200, await hostStatus(id)];
      }
      case "/api/cloud/join":
        return [200, await join(body.link, text(body.device, 60) || "A Mac")];
      case "/api/cloud/leave": {
        const id = hostedId(text(body.url, 100));
        if (!id) return [400, { error: "That is not a hosted Cloud" }];
        // Leaving is removing: the tunnel stops, the invite is deleted, and nothing goes to that Cloud any more.
        await removeCloudHere(hostedUrl(id));
        return [200, { ok: true }];
      }
      default: return null;
    }
  } catch (e) {
    return fail(e);
  }
}

/**
 * Joins a hosted Cloud from an invite link: this Mac makes its tunnel key and its device token, reaches the Cloud
 * through the invite's tunnel address (which pins the host's key), redeems the single-use code, and checks the answer
 * comes from the Cloud the link names. Only then is anything saved (Keychain). The shell asked the person first.
 */
export function join(link: unknown, device: string): Promise<{ url: string; hostId: string; name: string; me: unknown }> {
  // One join at a time: two at once into the same Cloud would both redeem a code and the second Keychain write would
  // orphan the first device token.
  const inv = parseInvite(link);
  const g = inv ? generation(hostedUrl(inv.hostId)) : 0;
  const run = joining.catch(() => {}).then(() => joinOnce(link, device, g));
  joining = run;
  return run;
}
let joining: Promise<unknown> = Promise.resolve();

async function joinOnce(link: unknown, device: string, g: number): Promise<{ url: string; hostId: string; name: string; me: unknown }> {
  const inv = parseInvite(link);
  if (!inv) throw new CloudError(400, "invalid", "That is not a Canvas invite link");
  // Removed while this join waited for the Cloud: nothing is saved, and the removal stands.
  const url = hostedUrl(inv.hostId);
  const removedMeanwhile = () => generation(url) !== g;
  const check = () => { if (removedMeanwhile()) throw new CloudError(409, "conflict", "That Cloud was removed while joining. Nothing was saved."); };
  check();
  // Never twice into the same Cloud, and never into the one this Mac hosts: the invite would be spent for nothing.
  const here = await hostsHere(inv.hostId);
  check();
  if (here) throw new CloudError(409, "conflict", "This Mac hosts that Cloud.");
  if (isConfigured(hostedUrl(inv.hostId))) throw new CloudError(409, "conflict", "This Mac is already in that Cloud.");
  const bin = helperPath();
  if (!bin) throw new CloudError(400, "invalid", WHY.unavailable);
  const key = await genkey(bin, "client");
  check();
  let f: { helper: Helper; origin: string; server: string } | null = null;
  try {
    f = await forward(bin, key.key, inv.addr);
    check();
    // The Cloud's id comes from the public key its tunnel reached, not from anything the other side says: an invite
    // that names one Cloud and leads to another (a member passing his own Cloud off as the host's) stops here.
    if (hostIdFor(f.server) !== inv.hostId) throw new CloudError(409, "conflict", "This invite leads to a different Cloud than the one it names. Ask the host for a new one.");
    const existing = await readJoined(inv.hostId);
    await testHooks.beforeJoinRequest?.(url);
    check();
    if (existing?.hostKey && existing.hostKey !== f.server) throw new CloudError(409, "conflict", "This Mac already joined a Cloud with that id and another key. Leave it first.");
    const token = newSecret("ccd");
    let res: Response;
    try {
      res = await fetch(`${f.origin}/v1/join`, {
        method: "POST",
        headers: { authorization: `Bearer ${inv.code}`, "content-type": "application/json" },
        body: JSON.stringify({ token, device, key: key.public }),
        signal: AbortSignal.timeout(30_000),
      });
    } catch {
      throw new CloudError(502, "down", "The Cloud did not answer. Its Mac may be asleep or closed; try again when it is open.");
    }
    const j = await res.json().catch(() => null) as any;
    await testHooks.afterJoinAnswer?.(url);
    if (removedMeanwhile()) throw new CloudError(409, "conflict", "That Cloud was removed while joining. Nothing was saved.");
    if (res.status === 401) throw new CloudError(401, "unauthenticated", "This invite was already used or has expired. Ask for a new one.");
    if (!res.ok || !j) throw new CloudError(502, "server", "The Cloud refused the invite.");
    if (j.hostId !== inv.hostId || typeof j.member !== "string" || typeof j.memberKey !== "string" || !/^nodekey:[0-9a-f]{64}$/.test(j.memberKey)) throw new CloudError(409, "conflict", "The Cloud that answered is not the one in the invite.");
    if (!(await writeJoined(inv.hostId, { token, addr: j.member, key: key.key, hostKey: f.server, memberKey: j.memberKey }))) throw new CloudError(500, "server", "Could not save the invite to the Keychain.");
    if (removedMeanwhile()) { await deleteJoined(inv.hostId); throw new CloudError(409, "conflict", "That Cloud was removed while joining. Nothing was saved."); }
    joinedCache.delete(inv.hostId);
    addCloud(url); // until the shell's next list, which has it (it adds the entry this answer gives it)
    servers.delete(url);
    return { url, hostId: inv.hostId, name: inv.name, me: j.me };
  } finally {
    f?.helper.stop();
  }
}
