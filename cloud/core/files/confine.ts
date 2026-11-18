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

type Stat = { isSymbolicLink(): boolean; isFile(): boolean; isDirectory(): boolean; ino: number | bigint; dev: number | bigint; nlink: number | bigint };
/** The parts of node:fs that openInPackage uses (passed in, so this file stays free of Node imports). */
export interface PackageFs {
  lstatSync(p: string): Stat;
  fstatSync(fd: number): Stat;
  openSync(p: string, flags: number): number;
  closeSync(fd: number): void;
  realpathSync(p: string): string;
  constants: { O_RDONLY: number; O_NOFOLLOW?: number };
}
/** macOS: refuse a link at any component of the path, inside the open itself (O_NOFOLLOW_ANY, macOS 11). */
const O_NOFOLLOW_ANY = 0x20000000;

/**
 * Open a package file for reading, closing what resolveInPackage leaves open: the check and the open are one step.
 * The open refuses a link at any part of the path (macOS O_NOFOLLOW_ANY, else O_NOFOLLOW on the file plus the checks
 * after it); the opened file must be the regular file the check saw, with one name only (a hard link is a second name
 * for a file that may sit outside the package), in a folder whose real path is the package's own.
 */
export function openInPackage(root: string, rel: string, fs: PackageFs, darwin = typeof process !== "undefined" && process.platform === "darwin"): { fd: number } | { refused: string } {
  const lstat = (p: string) => {
    try {
      return fs.lstatSync(p);
    } catch {
      return null;
    }
  };
  const r = resolveInPackage(root, rel, lstat);
  if ("refused" in r) return r;
  const seen = lstat(r.path);
  if (!seen) return { refused: `${rel} is not in the package` };
  if (!seen.isFile()) return { refused: `${rel} is not a file` };
  const base = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0);
  let fd: number;
  try {
    fd = fs.openSync(r.path, base | (darwin ? O_NOFOLLOW_ANY : 0));
  } catch (e) {
    const code = (e as { code?: string }).code;
    if (code === "ELOOP") return { refused: `${rel} goes through a link; Canvas reads only real files in the package` };
    if (code !== "EINVAL") return { refused: `${rel} cannot be opened (${code ?? "error"})` };
    try {
      fd = fs.openSync(r.path, base);
    } catch (e2) {
      return { refused: `${rel} cannot be opened (${(e2 as { code?: string }).code ?? "error"})` };
    }
  }
  const refuse = (why: string) => {
    fs.closeSync(fd);
    return { refused: why };
  };
  const st = fs.fstatSync(fd);
  if (!st.isFile()) return refuse(`${rel} is not a file`);
  if (Number(st.nlink) !== 1) return refuse(`${rel} has another name on this disk (a hard link); Canvas reads only files that live in the package`);
  if (st.ino !== seen.ino || st.dev !== seen.dev) return refuse(`${rel} changed while it was opened`);
  const dir = rel.slice(0, rel.indexOf("/"));
  let realDir: string, realRoot: string;
  try {
    realDir = fs.realpathSync(r.path.slice(0, r.path.lastIndexOf("/")));
    realRoot = fs.realpathSync(root);
  } catch {
    return refuse(`${rel} moved while it was opened`);
  }
  if (realDir !== `${realRoot}/${dir}`) return refuse(`${rel} goes through a link; Canvas reads only real files in the package`);
  return { fd };
}

