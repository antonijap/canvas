import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { stateDir } from "./usage-counts.ts";

export const PREVIEW_BATCH = 1024;
const MAX_PREVIEWS = 24_000;
const MAX_ACTIVE = 3;
const MAX_QUEUED = 12;

export function assetTag(st: { ino: number; size: number; mtimeMs: number; ctimeMs: number }) {
  return `"${st.ino}-${st.size}-${st.mtimeMs}-${st.ctimeMs}"`;
}

export function unpackPreviews(bytes: Buffer, count: number) {
  const out: (Buffer | null)[] = [];
  let at = 0;
  for (let i = 0; i < count; i++) {
    if (bytes.length - at < 16) throw new Error("truncated preview batch");
    const w = bytes.readUInt32LE(at + 8), h = bytes.readUInt32LE(at + 12);
    if (w > 32 || h > 32 || (!w !== !h)) throw new Error("invalid preview batch dimensions");
    const end = at + 16 + w * h * 4;
    if (end > bytes.length) throw new Error("truncated preview batch");
    out.push(w ? bytes.subarray(at, end) : null);
    at = end;
  }
  if (at !== bytes.length) throw new Error("extra data in preview batch");
  return out;
}

type Preview = { etag: string; pixels: Buffer; cached: boolean };

// One record per request path: a four-byte header, its ASCII asset tag, then the native pixel record.
export function packPreviews(records: (Preview | null)[]) {
  const size = records.reduce((sum, r) => sum + 4 + (r ? r.etag.length + r.pixels.length : 0), 0);
  const body = Buffer.allocUnsafe(size);
  let at = 0;
  for (const record of records) {
    const { etag, pixels, cached } = record ?? { etag: "", pixels: Buffer.alloc(0), cached: false };
    body.writeUInt16LE(pixels.length, at);
    body[at + 2] = etag.length;
    body[at + 3] = Number(cached);
    at += 4;
    at += body.write(etag, at, "ascii");
    at += pixels.copy(body, at);
  }
  return body;
}

let active = 0;
const waiting: (() => void)[] = [];
async function decode(helper: string, paths: string[]) {
  if (active >= MAX_ACTIVE) {
    if (waiting.length >= MAX_QUEUED) throw new Error("preview decoder busy");
    await new Promise<void>((resolve) => waiting.push(resolve));
  } else active++;
  try {
    return await new Promise<Buffer>((resolve, reject) => {
      const child = execFile(helper, [], { encoding: "buffer", timeout: 20_000, maxBuffer: PREVIEW_BATCH * (16 + 32 * 32 * 4) }, (error, bytes) => {
        if (error) reject(error);
        else resolve(bytes);
      });
      child.stdin?.on("error", () => {});
      child.stdin?.end(JSON.stringify(paths));
    });
  } finally {
    const next = waiting.shift();
    if (next) next();
    else active--;
  }
}

async function openCache() {
  const dir = stateDir();
  await fs.mkdir(dir, { recursive: true });
  const db = new DatabaseSync(path.join(dir, "image-previews-v1.sqlite"));
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA busy_timeout=1000;
    CREATE TABLE IF NOT EXISTS preview (
      file TEXT PRIMARY KEY, etag TEXT NOT NULL, pixels BLOB NOT NULL, touched INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS preview_touched ON preview(touched);`);
  const find = db.prepare("SELECT pixels FROM preview WHERE file=? AND etag=?");
  const touch = db.prepare("UPDATE preview SET touched=? WHERE file=? AND etag=?");
  const put = db.prepare("INSERT OR REPLACE INTO preview (file, etag, pixels, touched) VALUES (?, ?, ?, ?)");
  const prune = db.prepare("DELETE FROM preview WHERE rowid IN (SELECT rowid FROM preview ORDER BY touched DESC LIMIT -1 OFFSET ?)");
  return { db, find, touch, put, prune };
}
let cache: ReturnType<typeof openCache> | undefined;

export async function jpegPreviews(helper: string, paths: string[]) {
  const stat = await Promise.all(paths.map(async (file) => {
    if (!path.isAbsolute(file) || !/\.jpe?g$/i.test(file)) return null;
    const s = await fs.stat(file).catch(() => null);
    return s?.isFile() && s.size > 0 && s.size <= 50 * 1024 * 1024 ? assetTag(s) : null;
  }));
  const store = await (cache ??= openCache().catch((error) => { cache = undefined; throw error; })).catch(() => null);
  const misses: number[] = [];
  const records = paths.map<Buffer | null>((file, i) => {
    const etag = stat[i];
    if (!etag) return null;
    const row = store?.find.get(file, etag);
    if (row?.pixels instanceof Uint8Array) return Buffer.from(row.pixels.buffer, row.pixels.byteOffset, row.pixels.byteLength);
    misses.push(i);
    return null;
  });
  if (misses.length) {
    const pixels = unpackPreviews(await decode(helper, misses.map((i) => paths[i])), misses.length);
    for (const [j, i] of misses.entries()) records[i] = pixels[j];
  }
  const fresh = new Set(misses);
  if (store) {
    const now = Date.now();
    try {
      store.db.exec("BEGIN IMMEDIATE");
      for (const [i, pixels] of records.entries()) {
        if (!pixels) continue;
        if (fresh.has(i)) store.put.run(paths[i], stat[i], pixels, now);
        else store.touch.run(now, paths[i], stat[i]);
      }
      store.prune.run(MAX_PREVIEWS);
      store.db.exec("COMMIT");
    } catch {
      if (store.db.isTransaction) store.db.exec("ROLLBACK");
    }
  }
  return records.map((pixels, i) => {
    const etag = stat[i];
    return pixels && etag ? { etag, pixels, cached: !fresh.has(i) } : null;
  });
}
