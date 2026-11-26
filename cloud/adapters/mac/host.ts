// A Cloud hosted on a Mac: the Worker's protocol (docs/cloud/protocol.md) and the same room and team logic
// (cloud/core) on node:http and node:sqlite. It runs as its own process (cloud/adapters/mac/main.ts) with this http.Server
// only: the Cloud API, nothing of the editor. It listens on 127.0.0.1 and nowhere else; other Macs reach it through an
// encrypted tunnel (src/cloud-tunnel.ts) that also arrives on 127.0.0.1, so an address proves nothing and every
// route, the room socket included, needs a bearer token.
//
// People and devices. A person has a random id (who they are) and a label (an email or a name the host typed; shown,
// never trusted). The host invites a person: a join code, single use, valid 48 h. The joining Mac sends the code once,
// with a device token it made itself, through the tunnel; from then on that device token is its key. Removing a person
// deletes their devices and pending codes and closes their sockets at once. Authorization is checked again on every
// message. Tokens and codes are stored as SHA-256 hashes and compared in constant time.
//
// Storage, in `dir` (0700, files 0600): team.sqlite and rooms/<doc>.sqlite (one per shared document, the Worker's room
// schema). Comments and people only; no files, no tokens in clear.

import { FILE_TRANSFER } from "../../file-transfer.ts";
import { MacFiles } from "./files.ts";
import { route } from "../../core/router.ts";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import { WHITEBOARD } from "../../protocol-files.ts";
import type { AddressInfo, Socket } from "node:net";
import path from "node:path";
import type { Duplex } from "node:stream";
import { CLOUD_TIMERS, PER_VOTE_DESIGN, PRIVATE_VOTE_VIEWS, COMMENTS_CAPABILITIES_HEADER, LIMITS, PROTOCOL_VERSION, supportsPrivateVoteViews, voteRoomCapabilities } from "../../protocol.ts";
import type { Applied, Role, ServerInfo, ServerMessage } from "../../protocol.ts";
import { Operations, type Identity } from "../../core/operations.ts";
import { ranks } from "../../core/people.ts";
import { TeamStore } from "../../core/team-store.ts";
import { roomHasSocialDeadline, SqliteStore } from "./sqlite.ts";
import { ServerSocket, upgrade } from "./websocket.ts";

export const SERVER_VERSION = "0.1.0-mac";
/** The hosted Cloud's port, on 127.0.0.1 only. The tunnel serves exactly this port. */
export const HOST_PORT = 5190;
export const INVITE_MS = 48 * 3600_000;
/** Upgraded room sockets, all devices together. */
const MAX_SOCKETS = 256;
/** Plain HTTP connections not (yet) upgraded: kept apart, so idle ones cannot take the sockets' places. */
const MAX_HTTP_CONNECTIONS = 64;
/** Request bodies being read at once, and their bytes together. */
const MAX_BODIES = 16;
const MAX_BODY_BYTES = 8 * 1024 * 1024;
const MAX_BODIES_BYTES = 32 * 1024 * 1024;
const JOIN_BODY_BYTES = 4 * 1024;
const SOCKETS_PER_DEVICE = 20;
const ROLES: Role[] = ["owner", "editor", "commenter", "viewer"];
const uuid = (v: unknown): v is string => typeof v === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(v);
const sha = (s: string) => createHash("sha256").update(s).digest();

/** `<kind>_<16 hex id>.<43 base64url secret>`: the id finds the row, the whole is compared by hash. */
export type SecretKind = "ccd" | "ccj";
export function newSecret(kind: SecretKind): string {
  return `${kind}_${randomBytes(8).toString("hex")}.${randomBytes(32).toString("base64url")}`;
}
export function parseSecret(kind: SecretKind, s: unknown): { id: string; secret: string } | null {
  if (typeof s !== "string") return null;
  const m = new RegExp(`^${kind}_([0-9a-f]{16})\\.[A-Za-z0-9_-]{43}$`).exec(s);
  return m ? { id: m[1], secret: s } : null;
}
const sameHash = (stored: unknown, secret: string) => {
  if (typeof stored !== "string" || !/^[0-9a-f]{64}$/.test(stored)) return false;
  return timingSafeEqual(Buffer.from(stored, "hex"), sha(secret));
};

/** A label the host typed for a person: one line, 1 to 120 characters. */
export function cleanLabel(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const s = raw.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
  return s && s.length <= 120 ? s : null;
}
/** A device name the joining Mac sent: one line, at most 60 characters. */
const deviceName = (raw: unknown) => (cleanLabel(raw) ?? "A Mac").slice(0, 60);

/**
 * Closes a socket whose device lost access. A removed device is told so first ("unauthenticated"): its tunnel key
 * leaves the member tunnel at the same moment, so a later question could not reach the Cloud to learn why.
 */
function drop(ws: ServerSocket, removed: boolean): void {
  if (removed) ws.send(JSON.stringify({ type: "error", code: "unauthenticated", message: "Removed from this Cloud" } satisfies ServerMessage));
  ws.close(1008, "Permission changed");
}

export class HostError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) { super(message); this.status = status; this.code = code; }
}

export interface Me extends Identity { id: string; role: Role; device: string }
interface Session { doc: string; me: Me; ready: boolean; voting?: boolean; opened: number; window: number; messages: number }
interface RoomState { store: SqliteStore; ops: Operations; sockets: Map<ServerSocket, Session>; used: number; voteTimer?: ReturnType<typeof setTimeout> }

export interface HostOptions {
  /** Where the SQLite files live. Created 0700. */
  dir: string;
  /** The ID to save when creating a Cloud with a known identity. */
  hostId?: string;
  /** Tests only: another port (0 for a free one). Always on 127.0.0.1. */
  port?: number;
  storageCap?: number;
  /** How often room sockets are pinged (tests shorten it). */
  pingMs?: number;
  now?: () => number;
}

export interface PersonView {
  id: string;
  label: string;
  role: Role;
  devices: { id: string; name: string; joinedAt: string }[];
  invite?: { expiresAt: string };
}

export class CloudHost {
  private readonly opts: HostOptions;
  private readonly db: SqliteStore;
  readonly team: TeamStore;
  readonly files: MacFiles;
  private readonly rooms = new Map<string, RoomState>();
  private server?: http.Server;
  private readonly conns = new Set<Socket>();
  private readonly http = new Set<Socket>();
  private sockets = 0;
  /** Room sockets open now (tests). */
  openSockets(): number { return this.sockets; }
  private readonly failures = { start: 0, count: 0 };
  /** Called after people change (enrolment, removal, revocation), so the tunnel's key list can follow. */
  onPeopleChanged: () => void = () => {};
  /** The member tunnel's address, set by Canvas once its tunnel is up; a joining device gets it in the join answer. */
  memberAddr: string | null = null;

  constructor(opts: HostOptions) {
    this.opts = opts;
    const old = process.umask(0o077);
    try {
      fs.mkdirSync(path.join(opts.dir, "rooms"), { recursive: true, mode: 0o700 });
      fs.chmodSync(opts.dir, 0o700);
      fs.chmodSync(path.join(opts.dir, "rooms"), 0o700);
      this.db = new SqliteStore(path.join(opts.dir, "team.sqlite"));
    } finally { process.umask(old); }
    this.team = new TeamStore(this.db, () => []);
    this.db.sql.exec(`CREATE TABLE IF NOT EXISTS host (id INTEGER PRIMARY KEY CHECK (id = 1), host_id TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS persons (id TEXT PRIMARY KEY, label TEXT NOT NULL UNIQUE COLLATE NOCASE, role TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS devices (id TEXT PRIMARY KEY, person_id TEXT NOT NULL REFERENCES persons(id) ON DELETE CASCADE, name TEXT NOT NULL, hash TEXT NOT NULL, node_key TEXT, joined_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS invites (id TEXT PRIMARY KEY, person_id TEXT NOT NULL REFERENCES persons(id) ON DELETE CASCADE, hash TEXT NOT NULL, expires_at INTEGER NOT NULL)`);
    this.db.sql.exec("INSERT OR IGNORE INTO host (id, host_id, created_at) VALUES (1, ?, ?)",
      opts.hostId ?? crypto.randomUUID(), new Date().toISOString());
    this.files = new MacFiles(opts.dir, this.db, me => this.current(me), id => this.person(id)?.role as Role | null ?? null, () => this.now(), opts.storageCap ?? Number(process.env.CANVAS_CLOUD_STORAGE_CAP || 20 * 1024 ** 3));
    const rooms = path.join(opts.dir, "rooms");
    for (const file of fs.readdirSync(rooms, { withFileTypes: true })) {
      const doc = file.name.slice(0, -7);
      if (file.isFile() && file.name.endsWith(".sqlite") && this.team.hasDoc(doc) &&
          roomHasSocialDeadline(path.join(rooms, file.name))) this.room(doc);
    }
    this.protect();
  }

  private now(): number { return this.opts.now?.() ?? Date.now(); }

  /** The databases and their -wal and -shm files: 0600. */
  private protect(): void {
    for (const dir of [this.opts.dir, path.join(this.opts.dir, "rooms")]) {
      for (const f of fs.readdirSync(dir)) if (/\.sqlite(-wal|-shm|-journal)?$/.test(f)) { try { fs.chmodSync(path.join(dir, f), 0o600); } catch { /* gone */ } }
    }
  }

  /**
   * This Cloud's id. With a tunnel it is derived from the enrolment tunnel's public key (src/cloud-tunnel.ts
   * hostIdFor), which a joining Mac checks against the key its tunnel actually reached.
   * A new Cloud without a tunnel gets a random id.
   */
  hostId(): string {
    return this.db.sql.exec<{ host_id: string }>("SELECT host_id FROM host WHERE id = 1").one().host_id;
  }
  /** The member tunnel's public key, sent with its address in a join answer, so the joining Mac can pin it. */
  memberKey: string | null = null;

  // ---------- people ----------

  private person(id: string) {
    return this.db.sql.exec<{ id: string; label: string; role: string }>("SELECT id, label, role FROM persons WHERE id = ?", id).toArray()[0];
  }

  /** The host itself: the owner, made once; its label follows the host's name. */
  owner(label: string): string {
    const clean = cleanLabel(label) ?? "Host";
    const row = this.db.sql.exec<{ id: string }>("SELECT id FROM persons WHERE role = 'owner' ORDER BY created_at LIMIT 1").toArray()[0];
    if (row) {
      const taken = this.db.sql.exec("SELECT 1 FROM persons WHERE label = ? AND id != ?", clean, row.id).toArray().length;
      if (!taken) this.db.sql.exec("UPDATE persons SET label = ? WHERE id = ?", clean, row.id);
      return row.id;
    }
    const id = crypto.randomUUID();
    this.db.sql.exec("INSERT INTO persons (id, label, role, created_at) VALUES (?, ?, 'owner', ?)", id, clean, new Date(this.now()).toISOString());
    return id;
  }

  /**
   * A device token for the host's own Canvas, made now; the previous one stops working. It never leaves this Mac (the
   * hosting Canvas reaches the Cloud on 127.0.0.1).
   */
  ownerDevice(label: string): string {
    const person = this.owner(label);
    const token = newSecret("ccd");
    const { id } = parseSecret("ccd", token)!;
    this.db.transactionSync(() => {
      this.db.sql.exec("DELETE FROM devices WHERE person_id = ? AND name = 'This Mac (host)'", person);
      this.db.sql.exec("INSERT INTO devices (id, person_id, name, hash, joined_at) VALUES (?, ?, 'This Mac (host)', ?, ?)", id, person, sha(token).toString("hex"), new Date(this.now()).toISOString());
    });
    return token;
  }

  /**
   * Invites a person (new, or one already here who adds a device): a join code, single use, valid 48 hours. Any
   * earlier pending code for that person stops working. Returns the code; the host keeps only its hash.
   */
  invite(label: string, role?: Role): { personId: string; code: string; expiresAt: string } {
    const clean = cleanLabel(label);
    if (!clean) throw new HostError(400, "invalid", "Type a name or an email for this person");
    if (role !== undefined && (!ROLES.includes(role) || role === "owner")) throw new HostError(400, "invalid", "Choose editor, commenter or viewer");
    const code = newSecret("ccj");
    const { id } = parseSecret("ccj", code)!;
    const expires = this.now() + INVITE_MS;
    const personId = this.db.transactionSync(() => {
      const existing = this.db.sql.exec<{ id: string; role: string }>("SELECT id, role FROM persons WHERE label = ?", clean).toArray()[0];
      if (existing?.role === "owner") throw new HostError(409, "conflict", "That is the host");
      const pid = existing?.id ?? crypto.randomUUID();
      // A new person is an editor unless the host chose; a person already here keeps their role unless the host chose one.
      if (!existing) this.db.sql.exec("INSERT INTO persons (id, label, role, created_at) VALUES (?, ?, ?, ?)", pid, clean, role ?? "editor", new Date(this.now()).toISOString());
      else if (role) this.db.sql.exec("UPDATE persons SET role = ? WHERE id = ?", role, pid);
      this.db.sql.exec("DELETE FROM invites WHERE person_id = ?", pid);
      this.db.sql.exec("INSERT INTO invites (id, person_id, hash, expires_at) VALUES (?, ?, ?, ?)", id, pid, sha(code).toString("hex"), expires);
      return pid;
    });
    this.recheck();
    this.onPeopleChanged();
    return { personId, code, expiresAt: new Date(expires).toISOString() };
  }

  /** Removes a person: every device token and pending code goes, their open sockets close now. */
  remove(personId: string): boolean {
    const p = this.person(personId);
    if (!p) return false;
    if (p.role === "owner") throw new HostError(409, "conflict", "The host cannot remove itself");
    this.db.sql.exec("DELETE FROM persons WHERE id = ?", personId);
    this.recheck();
    this.onPeopleChanged();
    return true;
  }

  people(): PersonView[] {
    const persons = this.db.sql.exec<{ id: string; label: string; role: string }>("SELECT id, label, role FROM persons ORDER BY role = 'owner' DESC, created_at").toArray();
    const devices = this.db.sql.exec<{ id: string; person_id: string; name: string; joined_at: string }>("SELECT id, person_id, name, joined_at FROM devices ORDER BY joined_at").toArray();
    const invites = this.db.sql.exec<{ person_id: string; expires_at: number }>("SELECT person_id, expires_at FROM invites WHERE expires_at > ?", this.now()).toArray();
    return persons.map((p) => {
      const invite = invites.find((i) => i.person_id === p.id);
      return {
        id: p.id, label: p.label, role: p.role as Role,
        devices: devices.filter((d) => d.person_id === p.id).map((d) => ({ id: d.id, name: d.name, joinedAt: d.joined_at })),
        ...(invite ? { invite: { expiresAt: new Date(invite.expires_at).toISOString() } } : {}),
      };
    });
  }

  /** The tunnel keys of enrolled devices: the only clients the member tunnel lets in. */
  deviceKeys(): string[] {
    return this.db.sql.exec<{ node_key: string }>("SELECT node_key FROM devices WHERE node_key IS NOT NULL ORDER BY node_key").toArray().map((r) => r.node_key);
  }
  /** Codes still waiting to be used (the enrolment tunnel runs only then). */
  pendingInvites(): number {
    return this.db.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM invites WHERE expires_at > ?", this.now()).one().n;
  }

  /** Stop hosting: every device token and code is revoked (the host's own too) and every socket closes. */
  revokeAll(): void {
    this.db.transactionSync(() => {
      this.db.sql.exec("DELETE FROM devices");
      this.db.sql.exec("DELETE FROM invites");
    });
    this.recheck();
    this.onPeopleChanged();
  }

  /**
   * Redeems a join code: once, before it expires. The device token is one the joining Mac made; the host stores its
   * hash. Returns who the device now is.
   */
  enroll(code: string, body: unknown): Me {
    const c = parseSecret("ccj", code);
    if (!c) throw new HostError(401, "unauthenticated", "That invite is not valid");
    const b = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
    const device = parseSecret("ccd", b.token);
    if (!device) throw new HostError(400, "invalid", "The device token is missing");
    const nodeKey = typeof b.key === "string" && /^nodekey:[0-9a-f]{64}$/.test(b.key) ? b.key : null;
    const me = this.db.transactionSync(() => {
      const row = this.db.sql.exec<{ person_id: string; hash: string; expires_at: number }>("SELECT person_id, hash, expires_at FROM invites WHERE id = ?", c.id).toArray()[0];
      if (!row || !sameHash(row.hash, code)) throw new HostError(401, "unauthenticated", "That invite is not valid");
      // Used or expired: gone either way.
      this.db.sql.exec("DELETE FROM invites WHERE id = ?", c.id);
      if (row.expires_at <= this.now()) return null;
      const p = this.person(row.person_id);
      if (!p) return null;
      if (this.db.sql.exec("SELECT 1 FROM devices WHERE id = ?", device.id).toArray().length) throw new HostError(409, "conflict", "Make a new device token");
      this.db.sql.exec("INSERT INTO devices (id, person_id, name, hash, node_key, joined_at) VALUES (?, ?, ?, ?, ?, ?)", device.id, p.id, deviceName(b.device), sha(device.secret).toString("hex"), nodeKey, new Date(this.now()).toISOString());
      return { id: p.id, email: p.label, name: p.label, role: p.role as Role, device: device.id };
    });
    if (!me) throw new HostError(401, "unauthenticated", "That invite has expired");
    this.onPeopleChanged();
    return me;
  }

  /** Who a device token belongs to now, or null. */
  identify(token: string): Me | null {
    const t = parseSecret("ccd", token);
    if (!t) return null;
    const row = this.db.sql.exec<{ hash: string; person_id: string; label: string; role: string }>(
      "SELECT d.hash, d.person_id, p.label, p.role FROM devices d JOIN persons p ON p.id = d.person_id WHERE d.id = ?", t.id).toArray()[0];
    if (!row || !sameHash(row.hash, token)) return null;
    return { id: row.person_id, email: row.label, name: row.label, role: row.role as Role, device: t.id };
  }

  /** Every open socket against the devices and roles now: a removed device or a lower role closes it. */
  private recheck(): void {
    this.files.recheck();
    // Requests still sending their body from a device that is gone are cut off.
    for (const [req, device] of this.reading) {
      if (!this.db.sql.exec("SELECT 1 FROM devices WHERE id = ?", device).toArray().length) req.destroy();
    }
    for (const room of this.rooms.values()) {
      for (const [socket, s] of room.sockets) {
        const now = this.current(s.me);
        if (!now || ranks[now.role] < ranks[s.me.role]) { room.sockets.delete(socket); drop(socket, !now); }
        else s.me = now;
      }
    }
  }
  /** The same device as the database has it now, or null once it is gone. */
  private current(me: Me): Me | null {
    const row = this.db.sql.exec<{ label: string; role: string }>("SELECT p.label, p.role FROM devices d JOIN persons p ON p.id = d.person_id WHERE d.id = ? AND p.id = ?", me.device, me.id).toArray()[0];
    return row ? { ...me, email: row.label, name: row.label, role: row.role as Role } : null;
  }

  // ---------- rooms ----------

  private room(doc: string): RoomState {
    let r = this.rooms.get(doc);
    if (!r) {
      const old = process.umask(0o077);
      let store: SqliteStore;
      try { store = new SqliteStore(path.join(this.opts.dir, "rooms", `${doc}.sqlite`)); } finally { process.umask(old); }
      const ops = new Operations(store, () => this.now());
      // The hosted Cloud records the person id with each op (the Worker has no ids).
      if (!store.sql.exec("SELECT 1 AS one FROM pragma_table_info('ops') WHERE name = 'by_id'").toArray().length) store.sql.exec("ALTER TABLE ops ADD COLUMN by_id TEXT");
      r = { store, ops, sockets: new Map(), used: Date.now() };
      this.rooms.set(doc, r);
      const room = r;
      ops.onVotesExpired = entries => this.broadcastVotes(room, entries);
      this.scheduleVoteExpiry(room);
      this.protect();
      if (this.rooms.size > 64) {
        const idle = [...this.rooms.entries()].filter(([, x]) => !x.sockets.size && !x.voteTimer).sort((a, b) => a[1].used - b[1].used)[0];
        if (idle) { idle[1].store.close(); this.rooms.delete(idle[0]); }
      }
    }
    r.used = Date.now();
    return r;
  }

  /** Applies ops and sends the applied entries to every socket in the room that is still allowed in. */
  private submit(doc: string, ops: unknown[], me: Me, allowance: number, voting: boolean) {
    const r = this.room(doc);
    const members = this.people().filter(person => person.devices.length).map(person => ({ id: person.id, name: person.label }));
    const result = r.ops.submit(doc, ops, { email: me.email, name: me.name, id: me.id }, me.role, allowance, members, voting || undefined);
    this.scheduleVoteExpiry(r);
    if (result.entries.length) this.broadcastVotes(r, result.entries);
    return { acks: result.acks, rejected: result.rejected };
  }

  private broadcastVotes(r: RoomState, entries: Applied[]) {
    const changed = entries.some(entry => entry.op.kind === "vote.changed");
    for (const [socket, s] of r.sockets) {
      if (!s.ready) continue;
      if (!this.current(s.me)) { r.sockets.delete(socket); drop(socket, true); continue; }
      socket.send(JSON.stringify({ type: "applied", entries, ...(changed && s.voting && r.ops.socialView(s.me)) } satisfies ServerMessage));
    }
  }

  private scheduleVoteExpiry(r: RoomState) {
    clearTimeout(r.voteTimer);
    const next = r.ops.nextVoteExpiry();
    r.voteTimer = next === undefined ? undefined : setTimeout(() => {
      r.ops.expireDueVotes();
      this.scheduleVoteExpiry(r);
    }, Math.max(1, next - this.now()));
    r.voteTimer?.unref();
  }

  // ---------- HTTP ----------

  /**
   * Failed sign-ins, all peers together (every tunnel peer arrives as 127.0.0.1): past 30 in a minute a failing
   * attempt gets 429. Only failing ones: a valid token is checked first and always gets in.
   */
  private blocked(): boolean {
    if (this.now() - this.failures.start >= 60_000) { this.failures.start = this.now(); this.failures.count = 0; }
    return this.failures.count >= 30;
  }
  private failed(): void { if (!this.blocked()) this.failures.count++; }
  /** The answer to a failed sign-in: 401, or 429 once the minute's failures are used up. */
  private refusal(): [number, string, string] {
    const over = this.blocked();
    this.failed();
    return over ? [429, "quota", "Too many failed sign-ins"] : [401, "unauthenticated", "A valid device token is required"];
  }

  /**
   * What every request must look like before anything else: no identity headers but the bearer, no browser (no
   * Origin, no Sec-Fetch-Site), a loopback Host. Null when fine, else the status, code and reason.
   */
  static screen(req: http.IncomingMessage): [number, string, string] | null {
    const h = req.headers;
    if (Object.keys(h).some((k) => k.startsWith("x-canvas-internal-") || k === "x-canvas-dev-email" || k === "cf-access-token" || k === "cf-access-jwt-assertion")) return [401, "unauthenticated", "Identity comes from a token only"];
    // Node's own fetch sends Sec-Fetch-Mode, never Sec-Fetch-Site; a browser always sends Sec-Fetch-Site.
    if (h.origin !== undefined || h["sec-fetch-site"] !== undefined) return [403, "forbidden", "Browsers are not served"];
    if (!/^(127\.0\.0\.1|localhost|\[::1\])(:\d{1,5})?$/i.test(String(h.host ?? ""))) return [403, "forbidden", "Unexpected Host"];
    return null;
  }

  private bearer(req: http.IncomingMessage): string | null {
    const m = /^Bearer ([A-Za-z0-9_.-]{1,200})$/.exec(String(req.headers.authorization ?? ""));
    return m ? m[1] : null;
  }

  private who(req: http.IncomingMessage): Me | null {
    const t = this.bearer(req);
    return t ? this.identify(t) : null;
  }

  /** Whether a join code would be taken now (without taking it): checked before a join's body is read. */
  private validCode(code: string): boolean {
    const c = parseSecret("ccj", code);
    if (!c) return false;
    const row = this.db.sql.exec<{ hash: string; expires_at: number }>("SELECT hash, expires_at FROM invites WHERE id = ?", c.id).toArray()[0];
    if (!row || !sameHash(row.hash, code)) return false;
    if (row.expires_at <= this.now()) { this.db.sql.exec("DELETE FROM invites WHERE id = ?", c.id); return false; } // expired: gone
    return true;
  }

  // Bodies being read, for the aggregate limits, and the requests reading them, so a removal can cut them off.
  private bodies = { count: 0, bytes: 0 };
  private readonly reading = new Map<http.IncomingMessage, string>();

  /**
   * A JSON body within the limits: `max` bytes for this request, 16 bodies and 32 MiB for all at once. With a
   * device, the request is cut off if that device is removed while its body arrives.
   */
  private body(req: http.IncomingMessage, max: number, device?: string): Promise<unknown> {
    const declared = Number(req.headers["content-length"] ?? 0);
    if (declared > max) return Promise.reject(new HostError(413, "quota", "Request body is too large"));
    if (this.bodies.count >= MAX_BODIES || this.bodies.bytes + Math.min(declared || max, max) > MAX_BODIES_BYTES) return Promise.reject(new HostError(503, "quota", "Busy, try again"));
    this.bodies.count++;
    if (device) this.reading.set(req, device);
    let held = 0;
    const release = () => { this.bodies.count--; this.bodies.bytes -= held; held = 0; this.reading.delete(req); };
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      let size = 0, done = false;
      const end = (e: Error | null, v?: unknown) => { if (done) return; done = true; release(); e ? reject(e) : resolve(v); };
      req.on("data", (c: Buffer) => {
        size += c.length;
        if (size > max || this.bodies.bytes + c.length > MAX_BODIES_BYTES) { req.destroy(); end(new HostError(413, "quota", "Request body is too large")); return; }
        held += c.length; this.bodies.bytes += c.length;
        chunks.push(c);
      });
      req.on("end", () => {
        let v: unknown;
        try { v = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { return end(new HostError(400, "invalid", "Invalid JSON")); }
        end(null, v);
      });
      req.on("error", () => end(new HostError(400, "invalid", "The request ended")));
      req.on("close", () => end(new HostError(400, "invalid", "The request ended")));
    });
  }

  /** After a body is read: the same device, still here, with its role now. Null when it was removed meanwhile. */
  private still(me: Me): Me | null { return this.current(me); }

  private async route(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const json = (status: number, body: unknown) => {
      res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store", "x-content-type-options": "nosniff" });
      res.end(JSON.stringify(body));
    };
    const bad = CloudHost.screen(req);
    if (bad) return json(bad[0], { code: bad[1], message: bad[2] });
    const url = new URL(req.url ?? "/", "http://cloud.invalid");
    const method = req.method ?? "GET";
    const p = url.pathname;
    const importBlobs = method === "PUT" && /^\/v1\/files\/[0-9a-f-]{36}\/import\/blobs$/.test(p);
    const transfer = importBlobs || (method === "POST" && /^\/v1\/files\/[0-9a-f-]{36}\/(?:import\/(?:actions|comments)|blob-batch)$/.test(p));
    if (importBlobs && req.headers["content-type"] !== "application/octet-stream") return json(415, { code: "invalid", message: "Binary upload required" });
    if (method !== "GET" && !importBlobs && !(method === "PUT" && /^\/v1\/files\/[^/]+\/uploads\/[^/]+(?:\/parts\/\d+)?$/.test(p))) {
      const type = String(req.headers["content-type"] ?? "").split(";", 1)[0].trim().toLowerCase();
      if (type !== "application/json") return json(415, { code: "invalid", message: "JSON required" });
    }
    // Enrolment: the join code is the bearer, once. It is checked before any of the body is read, and the body is small.
    if (p === "/v1/join" && method === "POST") {
      const code = this.bearer(req) ?? "";
      if (!this.validCode(code)) { const [st, c, m] = this.refusal(); res.setHeader("connection", "close"); return json(st, { code: c, message: m }); }
      try {
        const me = this.enroll(code, await this.body(req, JOIN_BODY_BYTES));
        // The member tunnel's address: what this device uses from now on (the invite's address is for joining only).
        return json(200, { hostId: this.hostId(), member: this.memberAddr, memberKey: this.memberKey, me: { id: me.id, email: me.email, name: me.name, role: me.role } });
      } catch (e) {
        if (e instanceof HostError && e.status === 401) this.failed();
        throw e;
      }
    }
    const me = this.who(req);
    if (!me) {
      const [st, c, m] = this.refusal(); res.setHeader("connection", "close");
      if (st !== 429 && p === "/v1/members" && parseSecret("ccd", this.bearer(req))) return json(403, { code: "forbidden", message: "No access to this Cloud" });
      return json(st, { code: c, message: m });
    }
    if (!transfer && !this.team.allowMessage(me.device)) return json(429, { code: "quota", message: "Too many requests in one minute" });
    if (await this.files.route(req, res, url, me, () => this.body(req, 1024 * 1024, me.device))) return;
    if (p === "/v1/info" && method === "GET") return json(200, { protocol: PROTOCOL_VERSION, server: SERVER_VERSION, capabilities: ["comments", "hosted", "files", FILE_TRANSFER, WHITEBOARD, PRIVATE_VOTE_VIEWS, CLOUD_TIMERS, PER_VOTE_DESIGN], hostId: this.hostId() } as ServerInfo);
    if (p === "/v1/members" && method === "GET") return json(200, this.people().filter(p => p.devices.length).map(p => ({ id: p.id, name: p.label, role: p.role })));
    if (p === "/v1/me" && method === "GET") return json(200, { id: me.id, email: me.email, name: me.name, role: me.role, hostId: this.hostId() });
    if (p === "/v1/docs" && method === "POST") {
      if (me.role !== "owner" && me.role !== "editor") return json(403, { code: "forbidden", message: "Owner or editor role required" });
      const body = await this.body(req, MAX_BODY_BYTES, me.device);
      // Checked again now the body is here: a device removed (or demoted) while it arrived changes nothing.
      const now = this.still(me);
      if (!now) return json(401, { code: "unauthenticated", message: "This device was removed" });
      if (now.role !== "owner" && now.role !== "editor") return json(403, { code: "forbidden", message: "Owner or editor role required" });
      const doc = body && typeof body === "object" && "doc" in body ? (body as { doc: unknown }).doc : null;
      if (!uuid(doc)) return json(400, { code: "invalid", message: "doc must be a uuid" });
      if (!this.team.register(doc, now.id)) return json(409, { code: "quota", message: "This Cloud has too many documents" });
      return json(200, { doc });
    }
    const design = /^\/v1\/docs\/([0-9a-f-]+)\/vote-design$/.exec(p);
    if (design && method === "PUT" && uuid(design[1]) && this.team.hasDoc(design[1])) {
      const body = await this.body(req, 1024 * 1024, me.device);
      const now = this.still(me);
      if (now?.role !== "owner" && now?.role !== "editor") return json(403, { code: "forbidden", message: "Owner or editor role required" });
      if (!this.room(design[1]).ops.setVoteDesign(body)) return json(400, { code: "invalid", message: "Invalid vote design" });
      return json(200, { ok: true });
    }
    const voting = supportsPrivateVoteViews(String(req.headers[COMMENTS_CAPABILITIES_HEADER] ?? "").split(/\s*,\s*/));
    const result = await route({
      kind: "mac",
      team: () => this.team,
      room: doc => ({
        read: request => {
          const since = Number(request.query.get("since") ?? "0");
          if (!Number.isSafeInteger(since) || since < 0) return { status: 400, body: { code: "invalid", message: "since must be a nonnegative integer" } };
          const { ops } = this.room(doc);
          return { status: 200, body: { ...ops.read(since), ...(voting && ops.socialView(me)) } };
        },
        submit: async request => {
          const body = await request.body();
          const now = this.still(me);
          if (!now) return { status: 401, body: { code: "unauthenticated", message: "This device was removed" } };
          const ops = body && typeof body === "object" && "ops" in body ? (body as { ops: unknown }).ops : null;
          if (!Array.isArray(ops)) return { status: 400, body: { code: "invalid", message: "ops must be a list" } };
          const allowance = this.team.takeOps(now.id, ops.length);
          if (ops.length > LIMITS.opsPerMessage) return { status: 429, body: { code: "quota", message: "Too many ops in one message" } };
          return { status: 200, body: this.submit(doc, ops, now, allowance, voting) };
        },
      }),
    }, { method, path: p, query: url.searchParams, headers: new Headers(), body: () => this.body(req, MAX_BODY_BYTES, me.device) });
    return json(result.status, result.body);
  }

  private onUpgrade(req: http.IncomingMessage, socket: Duplex, head: Buffer): void {
    const refuse = (status: number, text: string) => { socket.end(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`); };
    socket.on("error", () => socket.destroy());
    try {
      const bad = CloudHost.screen(req);
      if (bad) return refuse(bad[0], bad[0] === 401 ? "Unauthorized" : "Forbidden");
      const url = new URL(req.url ?? "/", "http://cloud.invalid");
      const m = /^\/v1\/docs\/([^/]+)\/socket$/.exec(url.pathname);
      // Authentication first: nothing about routes or documents is said to someone without a token.
      const me = this.who(req);
      if (!me) { const [st] = this.refusal(); return refuse(st, st === 429 ? "Too Many Requests" : "Unauthorized"); }
      if (!this.team.allowMessage(me.device)) return refuse(429, "Too Many Requests");
      if (this.files.upgrade(req, socket, head, url, me)) return;
      if (!m || !uuid(m[1])) return refuse(404, "Not Found");
      if (this.sockets >= MAX_SOCKETS) return refuse(503, "Service Unavailable");
      const doc = m[1];
      if (!this.team.hasDoc(doc)) return refuse(404, "Not Found");
      const room = this.room(doc);
      const mine = [...room.sockets].filter(([, s]) => s.me.id === me.id).sort((a, b) => a[1].opened - b[1].opened);
      while (mine.length >= LIMITS.socketsPerUserPerDoc) { const [ws] = mine.shift()!; room.sockets.delete(ws); ws.close(1008, "Socket limit reached"); }
      let all = 0;
      for (const r of this.rooms.values()) for (const s of r.sockets.values()) if (s.me.device === me.device) all++;
      if (all >= SOCKETS_PER_DEVICE) return refuse(429, "Too Many Requests");
      // Registered before any byte that came with the upgrade is read (upgrade's `register`): a frame there that closes
      // the socket at once still finds it counted and its close handled. The count goes back once, on whichever
      // close comes first (the WebSocket's or the TCP connection's).
      upgrade(req, socket, head, { maxMessage: 8 * 1024 * 1024, maxFragments: 1024, pingMs: this.opts.pingMs }, (ws) => {
        // An upgraded connection counts as a socket now, no longer as one of the plain HTTP connections.
        this.http.delete(socket as Socket);
        this.sockets++;
        let counted = true;
        const release = () => { if (!counted) return; counted = false; this.sockets--; room.sockets.delete(ws); };
        ws.on("close", release);
        socket.once("close", release);
        const session: Session = { doc, me, ready: false, opened: Date.now(), window: Date.now(), messages: 0 };
        room.sockets.set(ws, session);
        ws.on("message", (text: string) => this.onMessage(room, ws, text));
      });
    } catch (e) {
      if (e instanceof HostError && e.status === 429) return refuse(429, "Too Many Requests");
      refuse(500, "Internal Server Error");
    }
  }

  private onMessage(room: RoomState, ws: ServerSocket, text: string): void {
    const s = room.sockets.get(ws);
    if (!s) return;
    const send = (m: ServerMessage) => ws.send(JSON.stringify(m));
    try {
      const now = Date.now();
      if (now - s.window >= 60_000) { s.window = now; s.messages = 0; }
      s.messages++;
      if (s.messages > 60 || !this.team.allowMessage(s.me.device)) {
        send({ type: "error", code: "quota", message: "Too many messages in one minute" });
        ws.close(1008, "Message quota exceeded");
        return;
      }
      // Who this is now: a removed device or a lower role closes the socket before anything is read.
      const current = this.current(s.me);
      if (!current || ranks[current.role] < ranks[s.me.role]) { room.sockets.delete(ws); drop(ws, !current); return; }
      s.me = current;
      let message: any;
      try { message = JSON.parse(text); } catch { throw new HostError(400, "invalid", "Invalid JSON"); }
      if (!message || typeof message !== "object") throw new HostError(400, "invalid", "Message required");
      if (message.type === "hello") {
        if (message.protocol !== PROTOCOL_VERSION) {
          send({ type: "error", code: "version", message: "Unsupported protocol" });
          ws.close(1008, "Unsupported protocol");
          return;
        }
        if (message.doc !== s.doc) throw new HostError(400, "invalid", "Document does not match the room");
        const since = Number(message.since);
        if (!Number.isSafeInteger(since) || since < 0) throw new HostError(400, "invalid", "since must be a nonnegative integer");
        s.voting = supportsPrivateVoteViews(message.capabilities);
        const data = room.ops.read(since);
        const me = { id: s.me.id, email: s.me.email, name: s.me.name };
        send({ type: "welcome", protocol: PROTOCOL_VERSION, server: SERVER_VERSION, role: s.me.role, me, seq: data.seq, serverTime: new Date(this.now()).toISOString(), capabilities: [...voteRoomCapabilities(!!s.voting), ...(s.voting ? [PER_VOTE_DESIGN] : [])], ...(s.voting && room.ops.socialView(me)), ...("threads" in data ? { threads: data.threads } : {}) });
        if ("entries" in data && data.entries.length) send({ type: "applied", entries: data.entries });
        s.ready = true;
        return;
      }
      if (message.type !== "ops" || !s.ready) throw new HostError(400, "invalid", "Send hello before ops");
      if (!Array.isArray(message.ops)) throw new HostError(400, "invalid", "ops must be a list");
      const allowance = this.team.takeOps(s.me.id, message.ops.length);
      if (message.ops.length > LIMITS.opsPerMessage) throw new HostError(429, "quota", "Too many ops in one message");
      const result = this.submit(s.doc, message.ops, s.me, allowance, !!s.voting);
      for (const ack of result.acks) send({ type: "ack", ...ack });
      if (result.rejected.length) send({ type: "reject", rejected: result.rejected });
    } catch (e) {
      const f = e instanceof HostError ? e : null;
      send({ type: "error", code: (f?.code ?? "server") as any, message: f?.message ?? "Could not process message" });
    }
  }

  // ---------- life ----------

  /** Listens on 127.0.0.1 only; resolves with the port. */
  start(): Promise<number> {
    if (this.server) return Promise.resolve((this.server.address() as AddressInfo).port);
    const server = http.createServer({ maxHeaderSize: 16 * 1024, headersTimeout: 10_000, requestTimeout: 30_000, keepAliveTimeout: 5_000 }, (req, res) => {
      this.route(req, res).catch((e) => {
        const f = e instanceof HostError ? e : new HostError(500, "server", "Could not process request");
        if (!res.headersSent) { res.writeHead(f.status, { "content-type": "application/json", "cache-control": "no-store" }); res.end(JSON.stringify({ code: f.code, message: f.message })); }
        else res.destroy();
      });
    });
    // Every TCP connection, upgraded ones included (the http server stops tracking those), so stop() ends them all.
    // Plain HTTP connections have their own cap; an upgrade moves its connection to the sockets' count.
    server.on("connection", (c: Socket) => {
      if (this.http.size >= MAX_HTTP_CONNECTIONS) { c.destroy(); return; }
      this.conns.add(c); this.http.add(c);
      c.on("close", () => { this.conns.delete(c); this.http.delete(c); });
    });
    server.on("upgrade", (req, socket, head) => this.onUpgrade(req, socket, head));
    server.on("clientError", (_e, socket) => socket.destroy());
    this.server = server;
    return new Promise((resolve, reject) => {
      server.once("error", (e) => { this.server = undefined; reject(e); });
      server.listen(this.opts.port ?? HOST_PORT, "127.0.0.1", () => resolve((server.address() as AddressInfo).port));
    });
  }

  port(): number | null {
    const a = this.server?.address();
    return a && typeof a === "object" ? a.port : null;
  }

  async stop(): Promise<void> {
    const server = this.server;
    this.server = undefined;
    for (const room of this.rooms.values()) for (const ws of room.sockets.keys()) ws.terminate();
    if (server) {
      server.closeAllConnections();
      for (const c of this.conns) c.destroy();
      await new Promise<void>((r) => server.close(() => r()));
    }
    this.files.close();
    for (const room of this.rooms.values()) { clearTimeout(room.voteTimer); room.store.close(); }
    this.rooms.clear();
    this.db.close();
  }

  /** Delete hosted data: stops, then removes the folder (databases, their -wal and -shm files, rooms). */
  async wipe(): Promise<void> {
    await this.stop();
    fs.rmSync(this.opts.dir, { recursive: true, force: true });
  }
}
