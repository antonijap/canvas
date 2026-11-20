// Presence in a Cloud file, the page's pure part (node-tested, test/cloud-presence.test.ts): what this window sends
// about its pointer, selection and gestures, and what it draws for everyone else. The server side is
// cloud/core/presence.ts; the message shapes and limits are there.
//
// Sending: a patch per change, latest wins per kind (page, cursor, sel, preview, editing). The first change after a
// pause goes at once; changes while a send is cooling down wait and go together, at most one message every
// SEND_EVERY_MS (about 9 a second, under the server's 10 per person with room for network jitter) and never more
// than PER_SECOND in any second. Values are copied when queued. A value equal to what peers already have is not
// sent. Live typing is cut at a whole character so the frame fits the server's 1 KB. Nothing is sent at rest: no
// timers run once the pending patch is empty. When a gesture ends, `end()` clears the preview and that state goes
// out in exactly one message. A window in the background sends one message hiding its pointer and preview (within
// the same budget, so the room accepts it), then nothing until it is in front again.
//
// Drawing: `createPeers()` keeps one entry per remote session from the server's patches and answers, per frame,
// what to draw on the page the person is looking at: a pointer with the person's name in their colour (the same
// colour as their comment avatar), outlines around what they selected, the box of a drag in progress, and who is
// typing. A pointer that has not moved for IDLE_MS fades out over FADE_MS; selections stay while they are in the
// file. A preview or typing with no news of its own for IDLE_MS is dropped, in case the message that ended it was
// lost. Names and typed text are plain strings from other people: the page sets them with textContent, never HTML.
//
// Integration (not wired yet; nothing imports this file outside the tests):
// - Page: when the open file is a Cloud file, make one sender with `send: (p) => socket.send(JSON.stringify({ type:
//   "presence", p }))`. Pointer moves over the view call `update({ cursor: world point })`, leaving the view
//   `update({ cursor: null })`; selection changes `update({ sel: ids.slice(0, 20) })`; page switches `update({ page })`;
//   live move, resize and scrub gestures `update({ preview })` each frame and `end()` on release; text editing
//   `update({ editing: { id, text } })` and `update({ editing: null })` when it ends. `visibilitychange` calls
//   `setHidden(document.hidden)`. Drawing matches /page/agent-cursor.js: one pointer-events: none layer in the view,
//   z-index under the agent cursor, positioned from `view()` with `toScreen` on each animation frame, and the frame
//   loop stops when `busy(now)` is false (so at rest the page does no work either).
// - Server: the room's socket handler passes each "presence" frame to `receivePresence` with the socket's identity,
//   stores `kept` in the socket attachment, sends `relay` to `fanOut(...)`, sends `snapshotFor(...)` in the welcome,
//   and `goneOf(socket)` on close. The Mac host holds one `PresenceLimiter` for all its rooms. On Cloudflare each
//   room is its own object, so the per person count across rooms needs the Team's lease (plan section 5) before it
//   is exact; until then a room-local limiter caps each room at 10 a second per person.

import { colorOf } from "./comments-logic.js";

export const SEND_EVERY_MS = 110;
export const IDLE_MS = 3000;
export const FADE_MS = 400;
export const KINDS = ["page", "cursor", "sel", "preview", "editing"];
/** Kinds that show a person is active right now; a page or selection change alone does not. */
const MOTION = ["cursor", "preview", "editing"];

/** The server's limits (cloud/core/presence.ts PRESENCE_LIMITS; a test keeps them equal). */
export const FRAME_BYTES = 1024;
export const TEXT_CHARS = 512;
export const PER_SECOND = 10;

const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
/** A copy, so a caller that later mutates what it passed cannot change what is queued or what peers were sent. */
const copy = (v) => (v == null ? null : JSON.parse(JSON.stringify(v)));
const encoder = new TextEncoder();
const frameBytes = (p) => encoder.encode(JSON.stringify({ type: "presence", p })).length;

/**
 * The patch as it goes on the wire: live typing cut (at a whole character) to TEXT_CHARS and then until the frame
 * fits FRAME_BYTES of UTF-8. Null when it cannot fit even with no text.
 */
export function fitFrame(patch) {
  const e = patch.editing;
  if (!e || typeof e.text !== "string") return frameBytes(patch) <= FRAME_BYTES ? patch : null;
  const chars = Array.from(e.text);
  const ends = [0];
  for (const ch of chars) {
    const next = ends[ends.length - 1] + ch.length;
    if (next > TEXT_CHARS) break;
    ends.push(next);
  }
  const at = (n) => ({ ...patch, editing: { ...e, text: e.text.slice(0, ends[n]) } });
  let lo = 0, hi = ends.length - 1;
  if (frameBytes(at(lo)) > FRAME_BYTES) return null;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (frameBytes(at(mid)) <= FRAME_BYTES) lo = mid;
    else hi = mid - 1;
  }
  return at(lo);
}

/**
 * The sender. `send(patch)` puts one presence patch on the socket. `now()` and `schedule(fn, ms) => cancel` are the
 * clock (performance.now and setTimeout in the page; fakes in tests).
 */
export function createPresenceSender({ send, now = () => performance.now(), schedule = defaultSchedule, every = SEND_EVERY_MS }) {
  /** What peers have from us, per kind, as asked for (undefined: never sent). */
  const sent = {};
  /** What changed since, per kind, latest wins. */
  let pending = {};
  /** When the last PER_SECOND messages went: no send may be the eleventh within a second, a hide included. */
  const times = [];
  let cancel = null;
  let hidden = false;

  function flush() {
    cancel = null;
    const patch = pending;
    pending = {};
    for (const k of Object.keys(patch)) if (same(patch[k], sent[k])) delete patch[k];
    if (!Object.keys(patch).length) return;
    const wire = fitFrame(patch);
    if (!wire) return; // the server would refuse it; peers keep the last state that fit
    Object.assign(sent, patch);
    times.push(now());
    if (times.length > PER_SECOND) times.shift();
    send(copy(wire));
  }
  function nextAt() {
    const last = times.length ? times[times.length - 1] : -Infinity;
    const window = times.length >= PER_SECOND ? times[times.length - PER_SECOND] + 1000 : -Infinity;
    return Math.max(last + every, window);
  }
  function arm() {
    if (cancel || !Object.keys(pending).length) return;
    const wait = nextAt() - now();
    if (wait <= 0) flush();
    else cancel = schedule(flush, wait);
  }
  function put(patch) {
    for (const k of KINDS) {
      if (!(k in patch)) continue;
      const v = copy(patch[k]);
      if (same(v, sent[k])) delete pending[k];
      else pending[k] = v;
    }
  }

  return {
    /** A change: any of page, cursor, sel, preview, editing. Ignored while the window is in the background. */
    update(patch) {
      if (hidden || !patch) return;
      put(patch);
      arm();
    },
    /** A gesture ended (release): its preview goes, and the final state reaches peers in one message. */
    end(patch = {}) {
      if (hidden) return;
      put({ ...patch, preview: null });
      arm();
    },
    /** The window went to the background (true) or came back (false). */
    setHidden(h) {
      if (h === hidden) return;
      hidden = h;
      if (h) {
        // Whatever was waiting is dropped; the hide itself waits for the same budget as any message, so the room
        // never refuses it and the pointer does go.
        if (cancel) { cancel(); cancel = null; }
        pending = {};
        for (const k of MOTION) if (sent[k] != null) pending[k] = null;
        arm();
      }
    },
    /** Stop: no timer survives. */
    dispose() {
      if (cancel) cancel();
      cancel = null;
      pending = {};
    },
    /** A send is waiting on the cool-down (tests, and the page's "is anything scheduled" check). */
    get waiting() { return !!cancel; },
  };
}

function defaultSchedule(fn, ms) {
  const t = setTimeout(fn, ms);
  return () => clearTimeout(t);
}

/** A pointer's opacity `since` ms after it last moved: full, then a fade over FADE_MS after IDLE_MS. */
export function idleOpacity(since, idleMs = IDLE_MS, fadeMs = FADE_MS) {
  if (since <= idleMs) return 1;
  return Math.max(0, 1 - (since - idleMs) / fadeMs);
}

/** World to screen (CSS px in the view), as /page/agent-cursor-logic.js. */
export const toScreen = (p, cam) => ({ x: p.x * cam.z + cam.x, y: p.y * cam.z + cam.y });

/** Black or white, whichever reads better on a #RRGGBB background. */
export function inkOn(hex) {
  const n = parseInt(String(hex).slice(1), 16);
  const lin = (c) => { const s = c / 255; return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4); };
  const l = 0.2126 * lin((n >> 16) & 255) + 0.7152 * lin((n >> 8) & 255) + 0.0722 * lin(n & 255);
  return (1.05) / (l + 0.05) >= (l + 0.05) / 0.05 ? "#FFFFFF" : "#18181B";
}

/** The model of everyone else in the file, fed by the server's presence messages. */
export function createPeers({ idleMs = IDLE_MS, fadeMs = FADE_MS } = {}) {
  /** session -> { by, role, page, cursor, sel, preview, editing, at: { cursor, preview, editing } } */
  const peers = new Map();
  /** Each moving field keeps its own clock: pointer traffic never keeps a stale preview or typing alive. */
  const fresh = (e, k, now) => now - e.at[k] <= idleMs;

  return {
    /** One server message's peers. Patches merge per session; `gone` forgets it. */
    receive(list, now) {
      for (const p of Array.isArray(list) ? list : []) {
        if (!p || typeof p.session !== "string" || !p.by) continue;
        if (p.gone) { peers.delete(p.session); continue; }
        const e = peers.get(p.session) || { page: null, cursor: null, sel: [], preview: null, editing: null, at: { cursor: now, preview: now, editing: now } };
        e.by = p.by;
        e.role = p.role;
        for (const k of KINDS) if (k in p) e[k] = p[k] === undefined ? null : p[k];
        for (const k of MOTION) if (k in p) e.at[k] = now;
        peers.set(p.session, e);
      }
    },
    /**
     * What to draw on `page` at `now`: one entry per peer on that page, with the pointer (null once it has faded),
     * its opacity, the selection, the preview while it is fresh, and the layer being typed in.
     */
    view(now, page) {
      const out = [];
      for (const [session, e] of peers) {
        if (page != null && e.page != null && e.page !== page) continue;
        const opacity = e.cursor ? idleOpacity(now - e.at.cursor, idleMs, fadeMs) : 0;
        const name = String((e.by && e.by.name) || "Someone").slice(0, 24) + (e.by?.agent ? "'s agent" : '');
        const color = colorOf(e.by && e.by.name);
        out.push({
          session,
          agent: !!e.by?.agent,
          name,
          color,
          ink: inkOn(color),
          cursor: opacity > 0 ? e.cursor : null,
          opacity,
          sel: e.sel || [],
          preview: e.preview && fresh(e, "preview", now) ? e.preview : null,
          editing: e.editing && fresh(e, "editing", now) ? e.editing : null,
        });
      }
      return out;
    },
    /** True while anything on screen still changes over time (a pointer fading); false means stop the frame loop. */
    busy(now) {
      for (const e of peers.values()) for (const k of MOTION) if (e[k] && now - e.at[k] <= idleMs + fadeMs) return true;
      return false;
    },
    get size() { return peers.size; },
    clear() { peers.clear(); },
  };
}

/** The world boxes to outline for a peer's selection; layers not on this page (no box) are skipped. */
export function selectionBoxes(ids, rectOf) {
  const out = [];
  for (const id of ids || []) {
    const r = rectOf(id);
    if (r) out.push({ id, ...r });
  }
  return out;
}

/** Where a previewed move or resize puts each layer now: its box plus the preview's change. Scrubs have no box. */
export function previewBoxes(preview, rectOf) {
  if (!preview || preview.kind === "scrub") return [];
  const dx = preview.dx || 0, dy = preview.dy || 0, dw = preview.dw || 0, dh = preview.dh || 0;
  const out = [];
  for (const id of preview.ids || []) {
    const r = rectOf(id);
    if (r) out.push({ id, x: r.x + dx, y: r.y + dy, w: Math.max(0, r.w + dw), h: Math.max(0, r.h + dh) });
  }
  return out;
}

const SCRUB_KEYS = new Set(['x','y','width','height','rotation','opacity','cornerRadius','gap','padding','paddingLeft','paddingRight','paddingTop','paddingBottom','fontSize','letterSpacing','lineHeight']);
/** Remote gestures apply to a fresh server scene. Local edits and pins applied afterwards take priority. */
export function applyPeerPreviews(root, peers) {
  let changed=false;
  const find = (n,id) => n.id===id ? n : (n.children || []).map(c=>find(c,id)).find(Boolean);
  for(const p of peers || []) {
    const v=p.preview;
    if(v) for(const id of v.ids || []) {
      const n=find(root,id);if(!n)continue;
      if(v.kind==='scrub') { if(SCRUB_KEYS.has(v.key) && Number.isFinite(v.value)) { n[v.key]=v.value;changed=true; } }
      else {
        if(id!==root.id) { n.x=(n.x || 0)+(v.dx || 0);n.y=(n.y || 0)+(v.dy || 0); }
        if(v.kind==='resize') { n.width=Math.max(0,(n.width || 0)+(v.dw || 0));n.height=Math.max(0,(n.height || 0)+(v.dh || 0)); }
        changed=true;
      }
    }
    if(p.editing && typeof p.editing.text==='string') {
      const n=find(root,p.editing.id);if(n?.type==='text') {n.content=p.editing.text;changed=true;}
    }
  }
  return changed;
}
