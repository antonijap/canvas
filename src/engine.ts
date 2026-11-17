// The design engine: the document parser, schema, resolver, renderer and tree helpers in src/doc/. Every engine
// import in Canvas goes through this file.

import fs from "node:fs";
import { logFields, sha, type LoadedDoc } from "./doc/docfile.ts";
import { readLog, tieOf, withLog } from "./doc/doclog.ts";
export { logPathOf, stateHashOf, type LogInfo } from "./doc/doclog.ts";
export { backupDirFor, loadDoc, revisionOf, serialize, sha } from "./doc/docfile.ts";
export type { LoadedDoc, CanvasDoc } from "./doc/docfile.ts";
export { buildIndex, defaultTheme, expand, resolveProps, resolveVariable } from "./doc/resolve.ts";
export { iconArt } from "./doc/render/icons.ts";
export { fontAssets, FIT_SCRIPT, gradientCss, nodeHtml } from "./doc/render/html.ts";
import { setShaderResolver } from "./doc/render/html.ts";
import { resolveShaderFill } from "./shader-fill.ts";
// Shader fills in headless renders (render_node, export): the renderer asks for their WGSL and params.
setShaderResolver(resolveShaderFill);
export type { HtmlOptions } from "./doc/render/html.ts";
export { findNode, updateNode, walk } from "./doc/tree.ts";
export { writeDoc } from "./doc/store.ts";
export type { Json, DocNode } from "./doc/schema.ts";
export { allIds, findNodes, insertNode, newId } from "./doc/tree.ts";
export { NODE_KEYS, unknownKeys, ValidationError, validateNode } from "./doc/schema.ts";
export { StaleFileError } from "./doc/docfile.ts";
export { exportTargets, layout as layoutBoxes, pdfFromSvgs, screenshots, shutdownRenderer, warmRenderer } from "./doc/render/index.ts";
export type { ExportShot, ExportTarget } from "./doc/render/index.ts";

// Accepts a .canvas package as well as a single .canvas.json; returns the file that holds the design (see docpath.ts).
export { resolveDocPath } from "./docpath.ts";

/**
 * loadDoc without blocking the event loop. the engine only exports a loader that reads the file
 * synchronously (a protected macOS folder can hold that read for as long as the privacy prompt is open),
 * so the read happens here with fs.promises and the parse mirrors docfile.loadDoc. `file` is a real path.
 */
export async function loadDocAsync(file: string): Promise<LoadedDoc> {
  const logRaw = await readLog(file); // before the document: see docfile.loadDoc
  // The bytes and their file's tie from one descriptor (see docfile.loadDoc).
  const fh = await fs.promises.open(file, "r");
  let raw: string, st: fs.Stats;
  try {
    [raw, st] = await Promise.all([fh.readFile("utf8"), fh.stat()]);
  } finally {
    await fh.close();
  }
  let doc: LoadedDoc["doc"];
  try {
    doc = JSON.parse(raw);
  } catch (e) {
    throw new Error(`${file} is not plain JSON (${(e as Error).message}). This server only edits plain-JSON Canvas files.`);
  }
  if (!doc || typeof doc !== "object" || !Array.isArray(doc.children)) throw new Error(`${file} has no "children" array; not a Canvas document`);
  const m = raw.match(/^\{\r?\n([ \t]+)"/);
  const indent = m ? m[1] : raw.startsWith("{\n") || raw === "{}" ? "  " : "";
  const trailing = raw.slice(raw.trimEnd().length);
  const hash = sha(raw);
  const lg = withLog(file, hash, doc, logRaw, tieOf(st));
  return { path: file, raw, hash, mtimeMs: st.mtimeMs, size: st.size, mode: st.mode & 0o777, indent, trailing, doc: lg.doc, ...logFields(lg) };
}
