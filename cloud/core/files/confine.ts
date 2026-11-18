// Where a Cloud file's package file lives on a disk (a Mac hosting the Cloud, or a Mac's cache of the file): only
// under the package folder, only a path checkBlobPath allows, and never through a symlink. The disk is passed in, so
// this stays pure and the test can give it a folder with a planted link.

import { checkBlobPath } from "./seam.ts";

export type Lstat = (path: string) => { isSymbolicLink(): boolean } | null;

/** The absolute path of `rel` inside `root`, or why it may not be read. `lstat` returns null for a missing path. */
export function resolveInPackage(root: string, rel: string, lstat: Lstat): { path: string } | { refused: string } {
  const bad = checkBlobPath(rel);
  if (bad) return { refused: bad };
  if (!root.startsWith("/") || root.includes("\\")) return { refused: "the package folder must be an absolute path" };
  const base = root.replace(/\/+$/, "");
  let at = base;
  for (const part of rel.split("/")) {
    at = `${at}/${part}`;
    const st = lstat(at);
    if (st?.isSymbolicLink()) return { refused: `${rel} goes through a link; Canvas reads only real files in the package` };
  }
  const top = lstat(base);
  if (top?.isSymbolicLink()) return { refused: "the package folder is a link" };
  return { path: at };
}
