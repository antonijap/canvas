// Board snapshots: a picture of each board as the engine last drew it, kept in IndexedDB by file, board, content
// key and canvas colour. On the next load (a launch, a tab whose page was let go, a page's first visit) a board
// the engine has not laid out yet shows its snapshot in its place at once, the same size and place, and the
// engine's own drawing replaces it once it is ready: the canvas looks finished immediately, then sharpens. A key
// changes whenever anything drawn in the board could (src/boards.ts), so a snapshot never shows stale content;
// snapshots of keys a board no longer has are deleted, and all of them together stay under a byte budget (least
// recently shown go first).
//
// The pure parts (ids, which boards to capture and at what size, what to evict) are exported for tests; the
// store is a thin IndexedDB layer the page creates with createSnapshots().

/** Every snapshot together, in bytes. */
export const SNAP_BUDGET = 200 << 20;
/** The longest side of a snapshot, in pixels. */
export const SNAP_MAX_SIDE = 2048;
/** Smaller on screen than this (short side, device px) is not worth a picture. */
export const SNAP_MIN_SIDE = 24;
/** A new capture replaces a stored one only when it is this much sharper. */
export const SNAP_SHARPER = 1.25;

/** The record id of one board's snapshot. `bg`: the canvas colour under it (a theme change is another picture). */
export const snapId = (file, board, key, bg, env = "") => JSON.stringify([file, board, key, bg || "", env]);

/**
 * Where to read a board from the engine's canvas, or null when it is not wholly on screen or too small.
 * `r`: the board's world rect; `cam`: {x, y, z}; vw/vh: the view in CSS px; `dpr`: device pixels per CSS px.
 * Returns the source rect in canvas (device) px and the stored picture's size (capped at `max` on the long side).
 */
export function captureRect(r, cam, vw, vh, dpr, max = SNAP_MAX_SIDE, min = SNAP_MIN_SIDE) {
  if (!r || !cam || !(r.w > 0) || !(r.h > 0)) return null;
  const x = r.x * cam.z + cam.x, y = r.y * cam.z + cam.y, w = r.w * cam.z, h = r.h * cam.z;
  if (x < 0 || y < 0 || x + w > vw || y + h > vh) return null;
  const sx = Math.round(x * dpr), sy = Math.round(y * dpr), sw = Math.round(w * dpr), sh = Math.round(h * dpr);
  if (Math.min(sw, sh) < min) return null;
  const k = Math.min(1, max / Math.max(sw, sh));
  return { sx, sy, sw, sh, w: Math.max(1, Math.round(sw * k)), h: Math.max(1, Math.round(sh * k)) };
}

/** True when a capture `w` px wide should be stored over `have` (the stored one's meta, or null). */
export const worthStoring = (have, w) => !have || w > have.w * SNAP_SHARPER;

/** Two rects overlap (a card over a board would end up in its picture). */
const overlaps = (a, b) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

/**
 * The boards to capture now: drawn at their current key (`loadedKey === meta.key`), wholly in view, not under a
 * card or another board, without live edits on top (`touched`), and with no stored picture this sharp (`have(meta)`).
 * `list`: [{ id, key, loadedKey, rect }]; returns [{ id, key, rect, crop }].
 */
export function toCapture(list, { cam, vw, vh, dpr, cards = [], touched = () => false, have = () => null, limit = Infinity, pixelBudget = Infinity }) {
  const out = [];
  let pixels = 0;
  for (const b of list) {
    if (out.length >= limit) break;
    if (!b.key || b.loadedKey !== b.key) continue;
    const crop = captureRect(b.rect, cam, vw, vh, dpr);
    if (!crop || !worthStoring(have(b), crop.w)) continue;
    if (touched(b.id) || cards.some((c) => c && overlaps(c, b.rect))) continue;
    if (list.some((o) => o !== b && overlaps(o.rect, b.rect))) continue;
    if (out.length && pixels + crop.w * crop.h > pixelBudget) continue;
    pixels += crop.w * crop.h;
    out.push({ id: b.id, key: b.key, rect: b.rect, crop });
  }
  return out;
}

/**
 * The snapshots to delete. `metas`: [{ id, file, board, key, bytes, used }]. Those of `file` whose board is gone
 * or holds another key now (`keys`: board id -> current key, for that file) go first; then the least recently
 * used, until all of them fit `budget`.
 */
export function toEvict(metas, budget = SNAP_BUDGET, file = null, keys = null) {
  const out = new Set();
  if (file && keys) for (const m of metas) if (m.file === file && keys.get(m.board) !== m.key) out.add(m.id);
  let total = 0;
  for (const m of metas) if (!out.has(m.id)) total += m.bytes || 0;
  for (const m of [...metas].sort((a, b) => (a.used || 0) - (b.used || 0))) {
    if (total <= budget) break;
    if (out.has(m.id)) continue;
    out.add(m.id);
    total -= m.bytes || 0;
  }
  return [...out];
}

// ---------------------------------------------------------------- the store (IndexedDB)

const DB = "canvas-snapshots", META = "meta", BLOB = "blob";

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(META)) db.createObjectStore(META, { keyPath: "id" }).createIndex("file", "file");
      if (!db.objectStoreNames.contains(BLOB)) db.createObjectStore(BLOB);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
const done = (tx) => new Promise((resolve, reject) => { tx.oncomplete = () => resolve(); tx.onerror = tx.onabort = () => reject(tx.error); });
const result = (req) => new Promise((resolve, reject) => { req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error); });

/**
 * The page's snapshot store for one file. `get` answers { url, w, h, ww, wh } (an object URL to show; the world
 * size it covers) or null; `putBatch` stores pictures; `evict` drops what a document no longer has. Every call fails
 * quietly (no IndexedDB, private mode): a missing snapshot only means the placeholder shows, as before.
 */
/** Every file's snapshots together, in bytes (Settings > Performance shows it). 0 when there is no store. */
export async function totalBytes() {
  try {
    const d = await openDb();
    const metas = await result(d.transaction(META).objectStore(META).getAll());
    d.close();
    return metas.reduce((n, m) => n + (m.bytes || 0), 0);
  } catch { return 0; }
}

/** Deletes every file's snapshots (Settings > Performance > Clear). */
export async function clearAll() {
  try {
    const d = await openDb();
    const tx = d.transaction([META, BLOB], "readwrite");
    tx.objectStore(META).clear();
    tx.objectStore(BLOB).clear();
    await done(tx);
    d.close();
    return true;
  } catch { return false; }
}

export function createSnapshots(file, { budget = SNAP_BUDGET, env = "" } = {}) {
  let dbp = null;
  const db = () => (dbp ??= openDb().catch(() => null));
  /** id -> meta, for this file: what is stored, without reading pictures. */
  const known = new Map();
  let loaded = null;
  const load = () => (loaded ??= db().then(async (d) => {
    if (!d) return;
    const list = await result(d.transaction(META).objectStore(META).index("file").getAll(file));
    for (const m of list) if (m.env === env) known.set(m.id, m);
  }).catch(() => {}));
  let usedT = 0;
  const usedIds = new Set();
  function touch(id) {
    usedIds.add(id);
    if (usedT) return;
    usedT = setTimeout(async () => {
      usedT = 0;
      const ids = [...usedIds];
      usedIds.clear();
      const d = await db();
      if (!d) return;
      const tx = d.transaction(META, "readwrite"), st = tx.objectStore(META), now = Date.now();
      for (const id of ids) {
        const req = st.get(id);
        req.onsuccess = () => { if (req.result) st.put({ ...req.result, used: now }); };
      }
      done(tx).catch(() => {});
    }, 2000);
  }
  return {
    ready: load,
    /** A new byte budget (Settings > Performance): what no longer fits goes now. */
    setBudget(bytes) { if (bytes > 0 && bytes !== budget) { budget = bytes; void this.evict(); } },
    /** Forget what this page knew was stored (after clearAll). */
    forget() { known.clear(); },
    /** The stored picture's meta for a board at a key (after ready()), or null. */
    meta: (board, key, bg) => known.get(snapId(file, board, key, bg, env)) || null,
    async get(board, key, bg) {
      await load();
      const id = snapId(file, board, key, bg, env);
      if (!known.has(id)) return null;
      const d = await db();
      if (!d) return null;
      try {
        const blob = await result(d.transaction(BLOB).objectStore(BLOB).get(id));
        const m = known.get(id);
        if (!blob || !m) { known.delete(id); return null; }
        touch(id);
        return { url: URL.createObjectURL(blob), w: m.w, h: m.h, ww: m.ww, wh: m.wh };
      } catch { return null; }
    },
    async putBatch(pictures) {
      const d = await db();
      if (!d || !pictures.length) return false;
      const records = pictures.map(({ board, key, bg, blob, size }) => ({
        blob, meta: { id: snapId(file, board, key, bg, env), file, board, key, bg, env, ...size, bytes: blob.size, used: Date.now() },
      }));
      try {
        const tx = d.transaction([META, BLOB], "readwrite");
        const metas = tx.objectStore(META), blobs = tx.objectStore(BLOB);
        for (const { meta, blob } of records) { metas.put(meta); blobs.put(blob, meta.id); }
        const evicted = trim(metas, blobs);
        await done(tx);
        for (const { meta } of records) if (!evicted.has(meta.id)) known.set(meta.id, meta);
        for (const id of evicted) known.delete(id);
        return true;
      } catch { return false; }
    },
    /** Deletes this file's snapshots of keys its boards no longer have (`keys`: board id -> key), then keeps every file's within the budget. */
    async evict(keys = null) {
      const d = await db();
      if (!d) return 0;
      try {
        const tx = d.transaction([META, BLOB], "readwrite");
        const ids = trim(tx.objectStore(META), tx.objectStore(BLOB), keys);
        await done(tx);
        for (const id of ids) known.delete(id);
        return ids.size;
      } catch { return 0; }
    },
  };

  function trim(metas, blobs, keys = null) {
    const ids = new Set();
    const req = metas.getAll();
    req.onsuccess = () => {
      for (const id of toEvict(req.result, budget, keys ? file : null, keys)) {
        metas.delete(id);
        blobs.delete(id);
        ids.add(id);
      }
    };
    return ids;
  }
}
