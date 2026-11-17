// Read and write document files with the safety rules:
// - remember the revision this server last saw for each file; refuse a write if the file changed since
// - backup + atomic write live in docfile.ts

import fs from "node:fs";
import { loadDoc, resolveDocPath, revisionOf, saveDoc, StaleFileError, type CanvasDoc, type LoadedDoc } from "./docfile.ts";

const lastSeen = new Map<string, string>();
// Read cache: big files (15 MB) take ~0.5 s to read, hash and parse. Reused only while size, mtime and inode match.
// Read tools never mutate the document. Writes always load fresh bytes.
const readCache = new Map<string, { key: string; loaded: LoadedDoc }>();

export function readDocFile(file: string): LoadedDoc {
  const p = resolveDocPath(file);
  const st = fs.statSync(p);
  const key = `${st.size}:${st.mtimeMs}:${st.ino}`;
  const hit = readCache.get(p);
  const l = hit && hit.key === key ? hit.loaded : loadDoc(p);
  readCache.set(p, { key, loaded: l });
  lastSeen.set(l.path, l.hash);
  return l;
}

export type WriteOpts = { expectedRevision?: string };

export type WriteResult = { file: string; revision?: string; backup: string; bytes: number; note?: string };

export function writeDoc<T>(file: string, opts: WriteOpts, change: (doc: CanvasDoc) => T): { result: T; write: WriteResult } {
  const l = loadDoc(file);
  const seen = lastSeen.get(l.path);
  if (opts.expectedRevision && !l.hash.startsWith(opts.expectedRevision)) {
    throw new StaleFileError(`${l.path} is at revision ${revisionOf(l.hash)}, not ${opts.expectedRevision}. It changed; read it again before editing.`);
  }
  if (seen && seen !== l.hash) {
    lastSeen.delete(l.path); // the next read sets it again
    throw new StaleFileError(`${l.path} changed on disk since this server last read it (another app or tool saved it). Nothing was written. Read it again (get_tree / get_node) and redo the change.`);
  }
  const result = change(l.doc);
  const w = saveDoc(l, l.doc);
  lastSeen.set(l.path, w.hash);
  readCache.delete(l.path);
  const note = w.conflict ? `Someone else saved the file at the same moment; their save is kept as ${w.conflict}.` : undefined;
  return { result, write: { file: l.path, revision: revisionOf(w.hash), backup: w.backup, bytes: w.bytes, ...(note ? { note } : {}) } };
}

export function forgetSeen() {
  lastSeen.clear();
  readCache.clear();
}
