// Headless render of one node, in this process. the engine's screenshots() blocks the event loop
// while Chrome works, which the Canvas server must never do, so it runs here.
// Canvas writes edits to disk in the background (src/docwriter.ts): the render first waits until the state Canvas
// shows is on disk (`settle`, POST /api/flush) and draws only bytes whose hash is that state's file revision.

import { buildIndex, defaultTheme, expand, findNode, loadDoc, resolveDocPath, revisionOf, screenshots, stateHashOf, warmRenderer, type LoadedDoc, type DocNode } from "../src/engine.ts";
import { ToolError } from "./client.ts";

export type RenderOpts = {
  file: string;
  id?: string;
  scale?: number;
  maxSide?: number;
  format?: "png" | "jpeg" | "webp";
  /** Waits until Canvas's state is on disk; returns the engine's revision of those bytes (null: nothing to check against). */
  settle?: () => Promise<string | null | undefined>;
};

/** The document as Canvas shows it: after `settle`, the bytes on disk must be the state it named. */
async function loadSettled(o: RenderOpts): Promise<LoadedDoc> {
  for (let attempt = 0; ; attempt++) {
    const want = o.settle ? await o.settle() : undefined;
    let loaded: LoadedDoc;
    try {
      loaded = loadDoc(resolveDocPath(o.file));
    } catch (e) {
      throw new ToolError("not_found", (e as Error).message);
    }
    if (!o.settle || (want && revisionOf(stateHashOf(loaded)) === want)) return loaded;
    if (!want) throw new ToolError("not_saved", `Canvas could not name the bytes of ${loaded.path} it shows`, "Try render_node again in a moment.");
    if (attempt >= 2) throw new ToolError("stale_revision", `${loaded.path} keeps changing on disk (Canvas's state is ${want}, the file is ${revisionOf(stateHashOf(loaded))})`, "Try render_node again in a moment.");
  }
}

export async function renderNode(o: RenderOpts): Promise<{ image: Buffer; mime: string; id: string; warnings: string[] }> {
  const loaded = await loadSettled(o);
  const doc = loaded.doc;
  const id = o.id ?? String(doc.children[0]?.id ?? "");
  if (!id) throw new ToolError("not_found", "The document has no boards to render");
  const rootId = id.split("/")[0];
  let top: DocNode;
  try {
    const f = findNode(doc, rootId);
    top = f.ancestors[0] ?? f.node;
  } catch {
    throw new ToolError("not_found", `No node "${id}" in ${loaded.path}`, "Use lookup_nodes to find ids.");
  }
  const warnings: string[] = [];
  const expanded = expand(buildIndex(doc), top, warnings);
  const format = o.format ?? "png";
  warmRenderer();
  try {
    const [image] = screenshots([{ root: expanded, targetId: id }], { doc, file: loaded.path, theme: defaultTheme(doc), warnings }, { format, scale: o.scale, maxSide: o.maxSide });
    return { image, mime: `image/${format}`, id, warnings };
  } catch (e) {
    const m = (e as Error).message;
    if (/chrom|browser|executable|launch/i.test(m)) throw new ToolError("unsupported", `Rendering needs a Chromium-family browser: ${m}`, "Install Google Chrome, or run screenshot_view with the Canvas app open.");
    if (/nothing drawn/i.test(m)) throw new ToolError("not_found", m);
    throw new ToolError("failed", m);
  }
}
