// Uploads (Section 3, decision 4): bytes are reserved against the Cloud's storage before they are accepted, checked
// against their hash and their type, and stored under their hash without ever overwriting. An action's blob op makes
// an upload part of the file; one no action uses within UPLOAD_GRACE_MS goes (gc.ts) and gives its bytes back.

import type { SqlStore } from "../sql.ts";
import type { FileRoom, Conn } from "./room.ts";
import { CAN_EDIT } from "./messages.ts";
import { blobKey } from "./objects.ts";
import { sha256HexAsync } from "./sha256.ts";
import { BLOB_TYPES } from "./seam.ts";

export const UPLOAD_GRACE_MS = 24 * 3_600_000;
/** Decision 4: 100 MB per image or video, 1 GB per file. */
export const UPLOAD_LIMITS = { image: 100 * 1024 * 1024, video: 100 * 1024 * 1024, font: 20 * 1024 * 1024, shader: 1024 * 1024, file: 1024 * 1024 * 1024 };

/** The Cloud's storage, reserved before bytes come in. The Team holds it (one for every room of the Cloud). */
export interface StorageBudget {
  /** Hold `bytes` for `key`; false when they do not fit. */
  reserve(key: string, bytes: number): boolean;
  /** Give a reservation or stored bytes back. */
  release(key: string): void;
}

/** A StorageBudget in SQL: used + reserved never passes the cap, because each reservation is one transaction. */
export class StorageLedger implements StorageBudget {
  private readonly store: SqlStore;
  constructor(store: SqlStore, cap: number) {
    this.store = store;
    store.transactionSync(() => {
      store.sql.exec("CREATE TABLE IF NOT EXISTS storage_cap (id INTEGER PRIMARY KEY CHECK (id = 1), cap INTEGER NOT NULL); CREATE TABLE IF NOT EXISTS storage_held (key TEXT PRIMARY KEY, bytes INTEGER NOT NULL)");
      store.sql.exec("INSERT INTO storage_cap (id, cap) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET cap = excluded.cap", cap);
    });
  }
  held(): number {
    return this.store.sql.exec<{ n: number }>("SELECT COALESCE(SUM(bytes), 0) AS n FROM storage_held").one().n;
  }
  reserve(key: string, bytes: number): boolean {
    return this.store.transactionSync(() => {
      if (this.store.sql.exec("SELECT 1 FROM storage_held WHERE key = ?", key).toArray().length) return true;
      const cap = this.store.sql.exec<{ cap: number }>("SELECT cap FROM storage_cap WHERE id = 1").one().cap;
      if (this.held() + bytes > cap) return false;
      this.store.sql.exec("INSERT INTO storage_held (key, bytes) VALUES (?, ?)", key, bytes);
      return true;
    });
  }
  release(key: string): void {
    this.store.sql.exec("DELETE FROM storage_held WHERE key = ?", key);
  }
}

export class UploadError extends Error {
  code: "forbidden" | "invalid" | "quota" | "conflict";
  constructor(code: UploadError["code"], message: string) {
    super(message);
    this.code = code;
  }
}

const kindOf = (type: string) => (type.startsWith("image/") ? "image" : type.startsWith("video/") ? "video" : type.startsWith("font/") ? "font" : type === "text/wgsl" ? "shader" : null);

/** The type the first bytes say, or null when they say none Canvas takes. */
export function sniffType(b: Uint8Array): string | null {
  const s = (i: number, n: number) => String.fromCharCode(...b.subarray(i, i + n));
  if (b[0] === 0x89 && s(1, 3) === "PNG") return "image/png";
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (s(0, 4) === "GIF8") return "image/gif";
  if (s(0, 4) === "RIFF" && s(8, 4) === "WEBP") return "image/webp";
  if (s(4, 4) === "ftyp") return s(8, 2) === "qt" ? "video/quicktime" : "video/mp4";
  if (b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) return "video/webm";
  if (s(0, 4) === "OTTO") return "font/otf";
  if ((b[0] === 0 && b[1] === 1 && b[2] === 0 && b[3] === 0) || s(0, 4) === "true") return "font/ttf";
  if (s(0, 4) === "wOF2") return "font/woff2";
  if (b.includes(0)) return null;
  const text = new TextDecoder("utf-8", { fatal: false }).decode(b.subarray(0, 4096)).trimStart();
  if (/^(<\?xml[^>]*>\s*)?(<!--[\s\S]*?-->\s*)*<svg[\s>]/i.test(text)) return "image/svg+xml";
  return "text/wgsl";
}

/** POST /v1/files/:file/uploads: hold the bytes against the Cloud's storage first. Returns the upload id. */
export function reserveUpload(room: FileRoom, budget: StorageBudget, conn: Conn, req: { id: string; sha256: string; bytes: number; type: string }): string {
  if (!CAN_EDIT[conn.role]) throw new UploadError("forbidden", "your role in this Cloud cannot add files");
  if (typeof req.id !== "string" || !/^[A-Za-z0-9-]{8,64}$/.test(req.id)) throw new UploadError("invalid", "an upload needs an id");
  if (typeof req.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(req.sha256)) throw new UploadError("invalid", "sha256 must be 64 hex digits");
  if (!Number.isSafeInteger(req.bytes) || req.bytes <= 0) throw new UploadError("invalid", "bytes must be a positive whole number");
  const kind = kindOf(req.type);
  if (!kind || !(Object.values(BLOB_TYPES) as string[]).includes(req.type)) throw new UploadError("invalid", `${req.type} is not a type Canvas stores`);
  if (req.bytes > UPLOAD_LIMITS[kind]) throw new UploadError("quota", `a ${kind} is at most ${UPLOAD_LIMITS[kind] / 1024 / 1024} MB`);
  return room.store.transactionSync(() => {
    const sql = room.store.sql;
    if (sql.exec("SELECT 1 FROM uploads WHERE id = ?", req.id).toArray().length) throw new UploadError("conflict", "this upload id is taken");
    const inFile = sql.exec<{ n: number }>("SELECT COALESCE(SUM(bytes), 0) AS n FROM (SELECT sha256, MAX(bytes) AS bytes FROM blobs GROUP BY sha256)").one().n;
    const open = sql.exec<{ n: number }>("SELECT COALESCE(SUM(bytes), 0) AS n FROM uploads WHERE state IN ('open', 'stored')").one().n;
    if (inFile + open + req.bytes > UPLOAD_LIMITS.file) throw new UploadError("quota", "a file holds at most 1 GB of images, videos and fonts");
    if (!budget.reserve(`${room.file}/${req.id}`, req.bytes)) throw new UploadError("quota", "this Cloud's storage is full");
    sql.exec("INSERT INTO uploads (id, sha256, bytes, type, by_id, at_ms, state) VALUES (?, ?, ?, ?, ?, ?, 'open')", req.id, req.sha256, req.bytes, req.type, conn.author.id, room.now());
    return req.id;
  });
}

/** PUT /v1/files/:file/uploads/:id: the bytes. Checked against the reservation, the hash and the type. */
export async function putUpload(room: FileRoom, budget: StorageBudget, id: string, bytes: Uint8Array): Promise<{ sha256: string; stored: boolean }> {
  const up = room.store.sql.exec<{ sha256: string; bytes: number; type: string; state: string }>("SELECT sha256, bytes, type, state FROM uploads WHERE id = ?", id).toArray()[0];
  if (!up) throw new UploadError("invalid", "no such upload");
  if (up.state !== "open") return { sha256: up.sha256, stored: false };
  const refuse = (msg: string): never => {
    room.store.sql.exec("DELETE FROM uploads WHERE id = ?", id);
    budget.release(`${room.file}/${id}`);
    throw new UploadError("invalid", msg);
  };
  if (bytes.length !== up.bytes) refuse(`the upload holds ${bytes.length} bytes, not the ${up.bytes} reserved`);
  if ((await sha256HexAsync(bytes)) !== up.sha256) refuse("the bytes do not match their hash");
  const sniffed = sniffType(bytes);
  const same = sniffed === up.type || (sniffed === "font/ttf" && up.type === "font/ttf");
  if (!same) refuse(`the bytes are ${sniffed ?? "of no type Canvas takes"}, not ${up.type}`);
  return room.exclusive(async () => {
    const stored = await room.objects.putIfAbsent(blobKey(room.file, up.sha256), bytes);
    room.store.sql.exec("UPDATE uploads SET state = 'stored' WHERE id = ? AND state = 'open'", id);
    return { sha256: up.sha256, stored };
  });
}
