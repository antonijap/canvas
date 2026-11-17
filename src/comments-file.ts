// comments.json inside a .canvas package: reading, the atomic write, and the fork Save As makes. No imports from the
// rest of the server, so docpath.ts can use it. The types and rules are cloud/protocol.ts; this is only the file.

import { randomBytes, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { CommentsFile, Thread } from "../cloud/protocol.ts";

export const COMMENTS_FILE = "comments.json";
/** The largest comments.json this server reads: well past LIMITS.threadsPerDoc threads of ordinary comments. */
export const MAX_COMMENTS_BYTES = 64 * 1024 * 1024;

export class CommentsError extends Error {
  status: number;
  code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export const emptyComments = (): CommentsFile => ({ format: 1, doc: randomUUID(), seq: 0, threads: [], outbox: [] });

/** A comments file as parsed JSON said it was, or null when it is not one. Unknown extra keys are kept. */
export function asCommentsFile(v: unknown): CommentsFile | null {
  if (!v || typeof v !== "object") return null;
  const f = v as Partial<CommentsFile>;
  if (f.format !== 1 || typeof f.doc !== "string" || !Array.isArray(f.threads)) return null;
  return { ...(f as CommentsFile), seq: Number.isFinite(f.seq) ? (f.seq as number) : 0, outbox: Array.isArray(f.outbox) ? f.outbox : [] };
}

/** The file in a package: null when there is none; throws CommentsError when it exists and cannot be read as comments. */
export function readCommentsFile(pkg: string): CommentsFile | null {
  const p = path.join(pkg, COMMENTS_FILE);
  const st = fs.statSync(p, { throwIfNoEntry: false });
  if (!st) return null;
  if (!st.isFile() || st.size > MAX_COMMENTS_BYTES) throw new CommentsError(422, "invalid", `${COMMENTS_FILE} is not a readable comments file`);
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    throw new CommentsError(422, "invalid", `${COMMENTS_FILE} is not valid JSON. Canvas left it as it is; fix or remove it to comment again.`);
  }
  const f = asCommentsFile(raw);
  if (!f) throw new CommentsError(422, "invalid", `${COMMENTS_FILE} is not a version 1 comments file. Canvas left it as it is.`);
  return f;
}

/** Writes the file whole: a temp file in the same folder, flushed, then renamed over it. A crash leaves the old one or the new one. */
export function writeCommentsFile(pkg: string, f: CommentsFile): void {
  const p = path.join(pkg, COMMENTS_FILE);
  const tmp = path.join(pkg, `.${COMMENTS_FILE}.${process.pid}-${randomBytes(4).toString("hex")}.tmp`);
  const fd = fs.openSync(tmp, "w");
  try {
    fs.writeFileSync(fd, JSON.stringify(f, null, 2) + "\n");
    fs.fsyncSync(fd);
  } catch (e) {
    fs.closeSync(fd);
    fs.rmSync(tmp, { force: true });
    throw e;
  }
  fs.closeSync(fd);
  try {
    fs.renameSync(tmp, p);
  } catch (e) {
    fs.rmSync(tmp, { force: true });
    throw e;
  }
}

/**
 * Save As: the copy keeps the threads under a new `doc` (a fork). It is not tied to a server, so the outbox, the
 * server link and the refused ops stay behind. A plain copy of the package (Finder, a sync folder) keeps the file as it is.
 */
export function forkComments(fromPkg: string, toDir: string): void {
  const f = readCommentsFile(fromPkg);
  if (!f) return;
  const doc = randomUUID();
  const threads: Thread[] = f.threads.map((t) => ({ ...t, doc }));
  const copy: CommentsFile = { format: 1, doc, seq: 0, threads, outbox: [] };
  fs.writeFileSync(path.join(toDir, COMMENTS_FILE), JSON.stringify(copy, null, 2) + "\n");
}
