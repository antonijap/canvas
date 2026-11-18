// SNAPSHOT of Phase 1's file (cloud/protocol-files.ts, cloud/core/schema.ts, cloud/core/files/apply.ts) so Phase 2 builds
// and tests against the real apply. Delete this folder when Phase 1 merges and re-point ../seam.ts.
// The files protocol: what one user step does to a design file, as an action of ops, on the wire between a Mac and a
// Cloud's file room. Plain types and pure checks, no imports, so the Canvas server, the Mac adapter and the Worker
// share this file as it is. The shared apply (cloud/core/files/apply.ts) gives every op its meaning.
//
// Values: `{v: x}` is a value (a JSON null included), `null` is "absent". Keys of a node keep their order: existing
// keys keep their place, new keys go last, removed keys go; a set's `order` (the node's key order after the edit)
// overrides that when present. Children lists are addressed by the sibling an item goes after (null: first).

export const FILES_PROTOCOL = 2;

export type Uuid = string;
export type Json = null | boolean | number | string | Json[] | { [k: string]: Json };
/** A value as stored, or null when absent: `{v: null}` is a JSON null, `null` is no value. */
export type Val = { v: Json } | null;
export type DocNode = { [k: string]: Json };

/** Document keys an op may change, one variable at a time. Nothing else at the document's top level. */
export type DocKey = `variables/${string}` | "themes" | "fonts";
/** A file in the design's package: `media/<name>.<ext>` or `shaders/<name>.wgsl` (checkBlobPath). */
export type BlobPath = `media/${string}` | `shaders/${string}`;
export type BlobType = (typeof BLOB_TYPES)[keyof typeof BLOB_TYPES];
/** Envelope keys beside the widgets and pages that ride along whole: the brief, variation sets, agent threads, and the
 *  page list itself when it is not in the shape page ops describe (a hand-edited file). */
export type MetaKey = "pages" | "brief" | "variations" | "threads";
export const META_KEYS: readonly MetaKey[] = ["pages", "brief", "variations", "threads"];

export type FileOp =
  /** Node properties. `order`: the key order after, when keys were added, removed or moved. `if`: per key, the action
   *  that must be the key's last writer (0: never written since load). */
  | { k: "set"; id: string; props: Record<string, Val>; order?: string[]; if?: Record<string, Uuid | 0> }
  /** A whole subtree, its ids as they are. */
  | { k: "insert"; parent: string | null; after: string | null; node: DocNode }
  /** A subtree. `if`: its last structural writer. */
  | { k: "remove"; id: string; if?: Uuid | 0 }
  | { k: "move"; id: string; parent: string | null; after: string | null; if?: Uuid | 0 }
  /** A splice of a text layer's content written after `baseSeq` (the room transforms it over later splices). */
  | { k: "text"; id: string; baseSeq: number; from: number; del: number; ins: string; spans?: Json; lists?: Json }
  | { k: "doc"; key: DocKey; value: Val; if?: Uuid | 0 }
  /** A card. `after`: where it goes among the cards (undefined: an existing one stays, a new one goes last). */
  | { k: "widget"; id: string; value: Val; after?: string | null; if?: Uuid | 0 }
  /** A page and its name (null: the page goes, and its boards are listed on none). */
  | { k: "page"; id: string; value: { v: { name: string } } | null; after?: string | null; if?: Uuid | 0 }
  /** The page a board is listed on (null: none), and where among that page's boards (undefined: last). */
  | { k: "pageOf"; board: string; page: string | null; after?: string | null; if?: Uuid | 0 }
  | { k: "meta"; key: MetaKey; value: Val; if?: Uuid | 0 }
  /** A file added to the package, before or with the op that names it. */
  | { k: "blob"; path: BlobPath; sha256: string; bytes: number; type: BlobType };

export type FileOpKind = FileOp["k"];

export interface Action {
  id: Uuid;
  baseSeq: number;
  epoch: number;
  at: string;
  ops: FileOp[];
  /** A label for an agent's action; never trusted. */
  agent?: string;
}
export type Author = { id: string; name?: string };
/** An op as it applied: inserts and moves with the index they landed at, text with the splice it became. */
export type AppliedOp = FileOp & { index?: number; from?: number; del?: number };
export interface AppliedAction {
  first: number;
  last: number;
  id: Uuid;
  by: Author;
  at: string;
  ops: AppliedOp[];
}
export type RejectCode = "conflict" | "forbidden" | "invalid" | "quota";
export type Reject = { reject: RejectCode; message: string; op?: number };

/** Per action and per insert bounds (Section 2.1 of the plan). */
export const FILE_LIMITS = {
  opsPerAction: 100,
  actionBytes: 1024 * 1024,
  insertNodes: 5000,
  insertDepth: 64,
  treeDepth: 256,
  ancestorWalk: 64,
};

/** The stored type of a package file, by extension. */
export const BLOB_TYPES = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  mp4: "video/mp4",
  m4v: "video/mp4",
  mov: "video/quicktime",
  webm: "video/webm",
  ttf: "font/ttf",
  otf: "font/otf",
  woff2: "font/woff2",
  wgsl: "text/wgsl",
} as const;
const MEDIA_EXT = new Set(["png", "jpg", "jpeg", "gif", "webp", "svg", "mp4", "m4v", "mov", "webm", "ttf", "otf", "woff2"]);
const NAME_RE = /^[A-Za-z0-9._-]{1,120}$/;

/**
 * Why `p` is not a package file a Cloud file may name (null: it is). Only `media/<name>.<ext>` with an image, video or
 * font extension, or `shaders/<name>.wgsl`; the name is letters, digits, dot, dash and underscore, at most 120, with no
 * `..`, no leading dot and no further folder. Absolute paths, schemes (`http:`, `data:`, `file:`) and backslashes are
 * refused. A symlink at the path is the caller's check (it needs the disk), see src/cloud-files-ops.ts.
 */
export function checkBlobPath(p: unknown): string | null {
  if (typeof p !== "string" || !p) return "a file path must be a non-empty string";
  if (p.length > 200) return "the file path is too long";
  if (/^[a-z][a-z0-9+.-]*:/i.test(p) || p.startsWith("//")) return `"${p}" names a URL, not a file in the package`;
  if (p.startsWith("/") || p.startsWith("~") || p.includes("\\")) return `"${p}" is not a path inside the package`;
  const slash = p.indexOf("/");
  const dir = p.slice(0, slash), name = p.slice(slash + 1);
  if (slash < 0 || (dir !== "media" && dir !== "shaders")) return `"${p}" is not in media/ or shaders/`;
  if (!NAME_RE.test(name) || name.startsWith(".") || name.includes("..")) return `"${p}": the file name may hold letters, digits, ".", "-" and "_" only`;
  const ext = name.includes(".") ? name.slice(name.lastIndexOf(".") + 1).toLowerCase() : "";
  if (dir === "shaders" ? ext !== "wgsl" : !MEDIA_EXT.has(ext)) return `"${p}": ${dir}/ does not take .${ext || "(none)"} files`;
  return null;
}

/** The stored type of a checked blob path. */
export function blobTypeOf(p: BlobPath): BlobType {
  const ext = p.slice(p.lastIndexOf(".") + 1).toLowerCase() as keyof typeof BLOB_TYPES;
  return BLOB_TYPES[ext];
}

/** Ops of one action, the payload's size as it goes on the wire. */
export function actionBytes(a: Pick<Action, "ops">): number {
  return JSON.stringify(a.ops).length;
}
