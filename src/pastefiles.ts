// Files a paste from another file added to this document's folder (images planAssets copied, videos copyIn copied).
// Undo of the paste takes back the ones nothing in the document uses any more: they wait in a temp folder, and a
// redo puts them back. A file that was there before the paste is never in the list, so it is never touched.

import { randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { visitRefs } from "./docpath.ts";
import { setStepFilesHook, type StepFile } from "./history.ts";
import { currentDoc } from "./docwriter.ts";
import { resolveSrc } from "./videos.ts";
import { listWidgets } from "./widgets.ts";

const STASH = () => path.join(os.tmpdir(), "canvas-undone-files");
const local = (ref: string) => !!ref && !/^([a-z][a-z0-9+.-]*:|\/\/)/i.test(ref);

/** Every file the document and its cards use, absolute. */
export function filesInUse(docFile: string): Set<string> {
  const out = new Set<string>();
  const base = path.dirname(docFile);
  try {
    visitRefs(currentDoc(docFile).doc, (ref) => {
      if (local(ref)) out.add(path.resolve(base, ref.split(/[?#]/)[0]));
      return undefined;
    });
  } catch { /* a cards-only document */ }
  try {
    for (const w of listWidgets(docFile).widgets as { config?: { src?: unknown } }[]) {
      const src = w.config?.src;
      const abs = typeof src === "string" ? resolveSrc(docFile, src) : null;
      if (abs) out.add(abs);
    }
  } catch { /* no widgets file */ }
  return out;
}

/** Move `from` to `to` now, with no await in between (the caller's checks still hold when it lands). */
function moveNow(from: string, to: string) {
  fs.mkdirSync(path.dirname(to), { recursive: true });
  try {
    fs.renameSync(from, to);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EXDEV") throw e;
    fs.copyFileSync(from, to);
    fs.rmSync(from, { force: true });
  }
}

/** Put `from` at `to` unless something is there already (never over it): false when `to` was taken. */
function placeNew(from: string, to: string): boolean {
  fs.mkdirSync(path.dirname(to), { recursive: true });
  try {
    fs.linkSync(from, to);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "EEXIST") return false;
    try {
      fs.copyFileSync(from, to, fs.constants.COPYFILE_EXCL);
    } catch (e2) {
      if ((e2 as NodeJS.ErrnoException).code === "EEXIST") return false;
      throw e2;
    }
  }
  fs.rmSync(from, { force: true });
  return true;
}

const sameBytes = (a: string, b: string) => {
  try { return fs.readFileSync(a).equals(fs.readFileSync(b)); } catch { return false; }
};

/** Fault injection for tests: runs before each undo move, at its await. */
export const settleHooks: { beforeMove?: (file: string) => Promise<void> | void } = {};

/** After an undo: the step's files nothing uses go to the temp folder. After a redo: they come back. */
export async function settleFiles(docFile: string, list: StepFile[], dir: "undo" | "redo"): Promise<void> {
  if (dir === "redo") {
    for (const f of list) {
      if (!f.stash) continue;
      const stash = f.stash;
      delete f.stash;
      if (!fs.existsSync(stash) || placeNew(stash, f.path)) continue;
      // Another app wrote this path while the paste was undone. The same bytes: nothing to keep. Others: their file
      // stays where it is and the paste's original bytes go beside it, never deleted.
      if (sameBytes(stash, f.path)) { fs.rmSync(stash, { force: true }); continue; }
      const ext = path.extname(f.path), stem = f.path.slice(0, f.path.length - ext.length);
      for (let n = 1; n < 1000; n++) {
        const to = `${stem}-original${n > 1 ? `-${n}` : ""}${ext}`;
        if (placeNew(stash, to)) {
          console.error(`[canvas] redo: ${f.path} was replaced while the paste was undone; its original bytes are in ${to}`);
          break;
        }
      }
    }
    return;
  }
  const top = path.dirname(docFile);
  const used = filesInUse(docFile);
  for (const f of list) {
    if (f.stash || used.has(f.path) || !fs.existsSync(f.path)) continue;
    const stash = path.join(STASH(), randomBytes(8).toString("hex"), path.basename(f.path));
    await settleHooks.beforeMove?.(f.path);
    // What the document uses now, read right before the move with no await in between: a paste that came in while
    // this undo ran (another tab) and reuses the file keeps it.
    if (!fs.existsSync(f.path) || filesInUse(docFile).has(f.path)) continue;
    moveNow(f.path, stash);
    f.stash = stash;
    // A folder the paste made for it (images/, media/) goes too once empty; the document's own folder stays.
    for (let d = path.dirname(f.path); d.startsWith(top + path.sep); d = path.dirname(d)) {
      try { fs.rmdirSync(d); } catch { break; }
    }
  }
}

setStepFilesHook(settleFiles);
