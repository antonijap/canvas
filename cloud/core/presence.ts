// Presence in a Cloud file room: where each person's pointer is, what they have selected, and while they drag,
// scrub or type, a preview of it. Pure and adapter-neutral: the Mac host and the Cloudflare room both call these
// with their own sockets and clocks. Nothing here is stored; a room keeps at most `KeptPresence` per socket (in the
// socket attachment on Cloudflare) so someone who joins late sees where the others are.
//
// Rules (task plan sections 5, 6 and 13):
// - The server stamps who sent it from the socket's identity. Any identity the client put in the message is dropped.
// - Shape and size are checked: known keys only, finite numbers, short ids, at most 20 selected ids, live typing at
//   most 512 characters, the whole frame at most 1 KB.
// - Viewers and commenters may show their pointer and selection, never a preview or live typing.
// - At most 10 presence messages a second per person, across every room and socket. Excess is dropped quietly:
//   presence is lossy, the next message carries the latest state.
// - Nothing at rest: the room sends presence only when one arrives, a socket closes, or someone joins.

import type { Author, Role } from "../protocol.ts";

export const PRESENCE_LIMITS = {
  /** A whole presence frame from a client, as UTF-8 bytes. */
  frameBytes: 1024,
  /** What a room keeps per socket for late joiners: page, cursor and selection. */
  keptBytes: 1024,
  /** Messages a person may send in any one second, all rooms and sockets together. */
  perPersonPerSecond: 10,
  selIds: 20,
  /** An id as JSON, quotes and escapes included, in UTF-8 bytes. Canvas's own ids are 5 letters. */
  idBytes: 42,
  textChars: 512,
  keyChars: 40,
  /** Pointer and preview coordinates are world units; anything past this is not a place on a canvas. */
  coord: 1e7,
} as const;

/** A drag, resize or scrub in progress, shown to others before it is written as an action on release. */
export interface PresencePreview {
  kind: "move" | "resize" | "scrub";
  ids: string[];
  dx?: number;
  dy?: number;
  dw?: number;
  dh?: number;
  /** scrub: the property being scrubbed and its value right now. */
  key?: string;
  value?: number;
}

/** Live typing in a text layer: the layer and (optionally) its text so far. */
export interface PresenceEditing {
  id: string;
  text?: string;
}

/**
 * What a client sends: a patch. A key that is absent did not change; `null` clears it (the pointer left the canvas,
 * the drag ended, typing stopped). `sel: []` clears the selection.
 */
export interface Presence {
  page?: string | null;
  cursor?: { x: number; y: number } | null;
  sel?: string[];
  preview?: PresencePreview | null;
  editing?: PresenceEditing | null;
}

/** What a room keeps per socket: the parts a late joiner needs. Previews and typing are never kept. */
export interface KeptPresence {
  page?: string | null;
  cursor?: { x: number; y: number } | null;
  sel?: string[];
}

/** What peers receive: the patch, stamped with who sent it. `gone`: that socket closed, forget it. */
export interface PeerPresence extends Presence {
  session: string;
  by: Author;
  role: Role;
  gone?: true;
}

export type PresenceClientMessage = { type: "presence"; p: Presence };
export type PresenceServerMessage = { type: "presence"; peers: PeerPresence[] };

/** One socket in a room, as the server knows it. `person`: the stable key the rate limit counts by. */
export interface PresenceSocket {
  session: string;
  person: string;
  author: Author;
  role: Role;
}

const PRESENCE_KEYS = new Set(["page", "cursor", "sel", "preview", "editing"]);
/** Keys a client might use to claim to be someone. Dropped, never trusted, never an error. */
const IDENTITY_KEYS = new Set(["by", "session", "role", "author", "name", "email", "id", "person", "agent", "gone"]);
const PREVIEW_KEYS = new Set(["kind", "ids", "dx", "dy", "dw", "dh", "key", "value"]);
const PREVIEW_KINDS = new Set(["move", "resize", "scrub"]);
const EDITING_KEYS = new Set(["id", "text"]);
const CURSOR_KEYS = new Set(["x", "y"]);

const L = PRESENCE_LIMITS;
const encoder = new TextEncoder();
export const byteLength = (s: string) => encoder.encode(s).length;
const plain = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype;
const onlyKeys = (o: Record<string, unknown>, keys: Set<string>) => Object.keys(o).every((k) => keys.has(k));
const coord = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n) && Math.abs(n) <= L.coord;
const anId = (s: unknown): s is string => typeof s === "string" && s.length > 0 && s.length <= L.idBytes && byteLength(JSON.stringify(s)) <= L.idBytes;
const idList = (v: unknown, max: number): v is string[] => Array.isArray(v) && v.length <= max && v.every(anId) && new Set(v).size === v.length;

/**
 * Null when `p` is a well formed presence patch (identity keys already removed), else why not. Shape and size only;
 * what a role may show is `forRole`'s job.
 */
export function checkPresence(p: unknown): string | null {
  if (!plain(p)) return "presence is not an object";
  if (!onlyKeys(p, PRESENCE_KEYS)) return "presence has an unknown key";
  if (Object.keys(p).length === 0) return "presence is empty";
  if (p.page !== undefined && p.page !== null && !anId(p.page)) return "page is not an id";
  if (p.cursor !== undefined && p.cursor !== null) {
    const c = p.cursor;
    if (!plain(c) || !onlyKeys(c, CURSOR_KEYS) || !coord(c.x) || !coord(c.y)) return "cursor needs finite x and y";
  }
  if (p.sel !== undefined && !idList(p.sel, L.selIds)) return `sel is not a list of at most ${L.selIds} distinct ids`;
  if (p.preview !== undefined && p.preview !== null) {
    const v = p.preview;
    if (!plain(v) || !onlyKeys(v, PREVIEW_KEYS)) return "preview is not plain";
    if (!PREVIEW_KINDS.has(v.kind as string)) return "preview kind is unknown";
    if (!idList(v.ids, L.selIds) || (v.ids as string[]).length === 0) return "preview ids are not a short list of ids";
    for (const k of ["dx", "dy", "dw", "dh", "value"]) if (v[k] !== undefined && !coord(v[k])) return `preview ${k} is not a number`;
    if (v.key !== undefined && (typeof v.key !== "string" || v.key.length === 0 || v.key.length > L.keyChars)) return "preview key is not a short name";
    if (v.kind === "scrub" ? v.key === undefined || v.value === undefined : v.key !== undefined || v.value !== undefined) return "preview fields do not match its kind";
  }
  if (p.editing !== undefined && p.editing !== null) {
    const e = p.editing;
    if (!plain(e) || !onlyKeys(e, EDITING_KEYS) || !anId(e.id)) return "editing needs a layer id";
    if (e.text !== undefined && (typeof e.text !== "string" || e.text.length > L.textChars)) return `editing text is longer than ${L.textChars} characters`;
  }
  return null;
}

export type PresenceOutcome =
  | { ok: true; relay: PeerPresence | null; kept: KeptPresence }
  | { ok: false; reason: "too_large" | "invalid" | "rate" | "brake"; message: string };

/**
 * Parses one frame from a socket and decides what the room does with it. `frame` is the socket's raw text; nothing is
 * parsed before its size is checked. `kept` is what the room holds for this socket now (empty for a new one).
 *
 * Returns the stamped patch to relay (null when nothing is left to show: a viewer that only sent a preview), and the
 * socket's kept state after it. A refusal changes nothing; the room drops the frame and may count it.
 */
export function receivePresence(
  frame: string,
  from: PresenceSocket,
  kept: KeptPresence,
  ctx: { limiter: PresenceLimiter; now: number; brake?: boolean },
): PresenceOutcome {
  if (typeof frame !== "string" || byteLength(frame) > L.frameBytes) return { ok: false, reason: "too_large", message: `presence is over ${L.frameBytes} bytes` };
  let msg: unknown;
  try { msg = JSON.parse(frame); } catch { return { ok: false, reason: "invalid", message: "presence is not JSON" }; }
  if (!plain(msg) || msg.type !== "presence" || !onlyKeys(msg, new Set(["type", "p"]))) return { ok: false, reason: "invalid", message: "not a presence message" };
  const p = stripIdentity(msg.p);
  const bad = checkPresence(p);
  if (bad) return { ok: false, reason: "invalid", message: bad };
  // Counted after the shape check, so a malformed flood does not use up the person's budget, and before the role
  // filter, so a viewer's dropped previews still count.
  if (ctx.brake) return { ok: false, reason: "brake", message: "presence is paused near the daily cap" };
  if (!ctx.limiter.take(from.person, ctx.now)) return { ok: false, reason: "rate", message: `over ${L.perPersonPerSecond} presence messages a second` };
  const shown = forRole(p as Presence, from.role);
  const next = keep(kept, shown);
  return { ok: true, relay: shown ? stamp(shown, from) : null, kept: next };
}

/** A copy of a patch without any key that claims an identity. Non-objects pass through for checkPresence to refuse. */
export function stripIdentity(p: unknown): unknown {
  if (!plain(p)) return p;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(p)) if (!IDENTITY_KEYS.has(k)) out[k] = v;
  return out;
}

/** The patch stamped with the socket's identity. Whatever identity the patch carried is gone by now. */
export function stamp(p: Presence, from: PresenceSocket): PeerPresence {
  return { ...p, session: from.session, by: { ...from.author }, role: from.role };
}

/** What a role may show: viewers and commenters keep pointer, page and selection; previews and typing go. */
export function forRole(p: Presence, role: Role): Presence | null {
  if (role === "owner" || role === "editor") return p;
  const out: Presence = {};
  if (p.page !== undefined) out.page = p.page;
  if (p.cursor !== undefined) out.cursor = p.cursor;
  if (p.sel !== undefined) out.sel = p.sel;
  return Object.keys(out).length ? out : null;
}

/** The kept state after a patch: page, cursor and selection only. */
export function keep(kept: KeptPresence, p: Presence | null): KeptPresence {
  if (!p) return kept;
  const out: KeptPresence = { ...kept };
  if (p.page !== undefined) out.page = p.page;
  if (p.cursor !== undefined) out.cursor = p.cursor;
  if (p.sel !== undefined) out.sel = p.sel;
  return out;
}

/** The largest kept state the limits allow, as JSON bytes. Must fit PRESENCE_LIMITS.keptBytes (tested). */
export function worstKeptBytes(): number {
  // An id at its byte limit: two-byte characters plus quotes, distinct per index.
  const id = (i: number) => "߿".repeat((L.idBytes - 2) / 2 - 1) + String.fromCharCode(0x41 + i) + "x";
  // The longest a number within the coordinate limit prints as.
  const n = -1.2345678901234567e-7;
  const worst: KeptPresence = { page: id(0), cursor: { x: n, y: n }, sel: Array.from({ length: L.selIds }, (_, i) => id(i)) };
  return byteLength(JSON.stringify(worst));
}

/**
 * Who gets a relayed patch: every other socket in the room, except the sender's own person (their other windows
 * already know where they are). Returns sessions.
 */
export function fanOut(sockets: Iterable<PresenceSocket>, from: PresenceSocket): string[] {
  const out: string[] = [];
  for (const s of sockets) if (s.session !== from.session && s.person !== from.person) out.push(s.session);
  return out;
}

/** What a socket that just joined is sent: the kept state of everyone else who has shown anything. */
export function snapshotFor(me: PresenceSocket, room: Iterable<{ socket: PresenceSocket; kept: KeptPresence }>): PeerPresence[] {
  const out: PeerPresence[] = [];
  for (const { socket, kept } of room) {
    if (socket.session === me.session || socket.person === me.person) continue;
    if (kept.page === undefined && kept.cursor === undefined && kept.sel === undefined) continue;
    out.push(stamp(forRole(kept, socket.role) ?? {}, socket));
  }
  return out;
}

/** What peers are sent when a socket closes, so its cursor and selection go at once. */
export function goneOf(from: PresenceSocket): PeerPresence {
  return { session: from.session, by: { ...from.author }, role: from.role, gone: true };
}

/**
 * At most `limit` messages per person in any window of `windowMs`, shared by every room that holds this limiter
 * (the Mac host holds one for all its rooms; on Cloudflare it lives with the Team, see the integration note in
 * src/page/presence-client.js). Sliding window: it keeps
 * the times of the last `limit` accepted messages per person, nothing more, and forgets people idle a full window.
 */
export class PresenceLimiter {
  private readonly times = new Map<string, number[]>();
  private sweptAt = 0;
  readonly limit: number;
  readonly windowMs: number;
  constructor(limit: number = L.perPersonPerSecond, windowMs = 1000) {
    this.limit = limit;
    this.windowMs = windowMs;
  }

  take(person: string, now: number): boolean {
    this.sweep(now);
    const t = this.times.get(person) ?? [];
    while (t.length && now - t[0] >= this.windowMs) t.shift();
    if (t.length >= this.limit) { this.times.set(person, t); return false; }
    t.push(now);
    this.times.set(person, t);
    return true;
  }

  /** People currently tracked (for tests and memory checks). */
  get size(): number { return this.times.size; }

  private sweep(now: number) {
    if (now - this.sweptAt < this.windowMs) return;
    this.sweptAt = now;
    for (const [k, t] of this.times) if (!t.length || now - t[t.length - 1] >= this.windowMs) this.times.delete(k);
  }
}
