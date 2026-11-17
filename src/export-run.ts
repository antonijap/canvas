// One export (src/export.ts) or Copy as (src/copy-as.ts) in its own process: the headless renderer blocks its thread while Chrome works, which
// the server must never do. Usage: node src/export-run.ts <port> <document>, the request as JSON on stdin. Prints one JSON
// line: {files, warnings} and exits 0, or {status, code, error} and exits 1.

import fs from "node:fs";
import { codeFor, type CodeAnswer, type CodeFormat } from "./codegen.ts";
import { buildIndex, defaultTheme, expand, exportTargets, findNode, layoutBoxes, loadDoc, pdfFromSvgs, revisionOf, shutdownRenderer, stateHashOf, type LoadedDoc, type DocNode } from "./engine.ts";
import { embedImages, ExportError, exportPaths, exportPlan, finishPng, isVector, MAX_SIDE, shotFormat, type ExportedFile, type ExportRequest } from "./export.ts";

const [port, docFile] = process.argv.slice(2);

/** The document as Canvas shows it: Canvas writes edits in the background, so wait until they are on disk. */
async function settled(): Promise<LoadedDoc> {
  for (let attempt = 0; ; attempt++) {
    let want: string | null | undefined;
    try {
      const r = await fetch(`http://127.0.0.1:${port}/api/flush`, { method: "POST", headers: { "x-canvas": "1", "content-type": "application/json" }, body: JSON.stringify({ file: docFile }), signal: AbortSignal.timeout(20_000) });
      want = ((await r.json()) as { fileRevision?: string | null }).fileRevision;
    } catch {
      want = undefined; // no server: the file on disk is all there is
    }
    const loaded = loadDoc(docFile);
    if (!want || revisionOf(stateHashOf(loaded)) === want) return loaded;
    if (attempt >= 2) throw new ExportError(409, "stale_revision", `${docFile} keeps changing on disk; try again in a moment`);
  }
}

function findIn(n: DocNode, id: string, parent: DocNode | null): { node: DocNode; parent: DocNode | null } | null {
  if (String(n.id) === id) return { node: n, parent };
  for (const c of (n.children as DocNode[] | undefined) ?? []) {
    const hit = findIn(c, id, n);
    if (hit) return hit;
  }
  return null;
}

async function main(): Promise<{ files: ExportedFile[]; warnings: string[]; code?: CodeAnswer[] }> {
  const req = JSON.parse(fs.readFileSync(0, "utf8")) as ExportRequest & { code?: CodeFormat };
  const loaded = await settled();
  const doc = loaded.doc;
  const index = buildIndex(doc);
  const warnings: string[] = [];
  const roots = new Map<string, DocNode>();
  const tops: DocNode[] = [];
  const nodes: DocNode[] = [];
  const parents: (DocNode | null)[] = [];
  const names: string[] = [];
  const items = req.items ?? req.ids.map((id) => ({ id, format: req.format, scale: req.scale, preset: req.preset }));
  for (const { id } of items) {
    let top: DocNode;
    try {
      const f = findNode(doc, id.split("/")[0]);
      top = f.ancestors[0] ?? f.node;
    } catch {
      throw new ExportError(404, "not_found", `No layer "${id}" in this file`);
    }
    if (!roots.has(String(top.id))) roots.set(String(top.id), expand(index, top, warnings));
    const hit = findIn(roots.get(String(top.id))!, id, null);
    if (!hit) throw new ExportError(404, "not_found", `No layer "${id}" in this file`);
    tops.push(top);
    nodes.push(hit.node);
    parents.push(hit.parent);
    names.push(typeof hit.node.name === "string" && hit.node.name ? hit.node.name : String(hit.node.type ?? id));
  }
  const input = { doc, file: loaded.path, theme: defaultTheme(doc), warnings };
  // Copy as code: the layers' own styles, from the file and their laid-out boxes (src/codegen.ts).
  if (req.code) {
    const rects = layoutBoxes([...roots.values()], input);
    const code = nodes.map((n, i) => {
      const box = rects[items[i].id] ?? { x: 0, y: 0, width: 0, height: 0 };
      const parentBox = parents[i] ? rects[String(parents[i]!.id)] : undefined;
      return { id: items[i].id, name: names[i], text: codeFor(req.code!, { node: n, parent: parents[i], doc, theme: input.theme, warnings, box, parentBox }) };
    });
    return { files: [], warnings: [...new Set(warnings)].slice(0, 20), code };
  }
  const paths = req.inline ? items.map(() => "") : exportPaths(req, names);
  const plans: ReturnType<typeof exportPlan>[] = [];
  const shots = exportTargets([...roots.values()], input, items.map((it, i) => ({
    id: it.id,
    format: shotFormat(it.format),
    root: String(tops[i].id),
    scale: (r) => {
      const plan = exportPlan({ width: r.width, height: r.height }, isVector(it.format) ? {} : it);
      if (Math.max(plan.drawn.width, plan.drawn.height) > MAX_SIDE) throw new ExportError(422, "too_large", `"${names[i]}" would be ${plan.drawn.width}x${plan.drawn.height} px; the most is ${MAX_SIDE} px a side. Export it at a smaller scale.`);
      plans[i] = plan;
      return plan.scale;
    },
  })));
  // PDFs print the SVG drawings; Chrome loads a page of its own for them, so after every shot.
  const pdfAt = items.map((it, i) => (it.format === "pdf" ? i : -1)).filter((i) => i >= 0);
  const svgs = await Promise.all(shots.map((s) => (s.svg !== undefined ? embedImages(s.svg, warnings) : Promise.resolve(undefined))));
  const pdfs = pdfAt.length ? pdfFromSvgs(pdfAt.map((i) => ({ svg: svgs[i]!, width: shots[i].rect.width, height: shots[i].rect.height }))) : [];
  const files: ExportedFile[] = [];
  for (const [i, s] of shots.entries()) {
    const it = items[i];
    let bytes: Buffer, width: number, height: number;
    if (s.svg !== undefined) {
      bytes = it.format === "pdf" ? pdfs[pdfAt.indexOf(i)] : Buffer.from(svgs[i]!);
      width = Math.round(s.rect.width * 1000) / 1000;
      height = Math.round(s.rect.height * 1000) / 1000;
      for (const w of s.warnings ?? []) warnings.push(`${names[i]}: ${w}`);
    } else if (it.format === "png") {
      bytes = finishPng(s.png!, plans[i]);
      width = plans[i].width;
      height = plans[i].height;
    } else {
      // JPG and WebP: Chrome's own encoding at the plan's scale (a preset's exact size is a PNG step only).
      bytes = s.png!;
      width = plans[i].drawn.width;
      height = plans[i].drawn.height;
    }
    // Where the layer sits on the canvas: its root's position plus its offset in the laid-out root.
    const x = (typeof tops[i].x === "number" ? (tops[i].x as number) : 0) + (s.root ? s.rect.pageX - s.root.pageX : 0);
    const y = (typeof tops[i].y === "number" ? (tops[i].y as number) : 0) + (s.root ? s.rect.pageY - s.root.pageY : 0);
    if (req.inline) files.push({ id: it.id, name: names[i], path: "", width, height, bytes: bytes.length, data: bytes.toString("base64"), x, y });
    else {
      fs.writeFileSync(paths[i], bytes);
      files.push({ id: it.id, name: names[i], path: paths[i], width, height, bytes: bytes.length });
    }
  }
  return { files, warnings: [...new Set(warnings)].slice(0, 20) };
}

let code = 0;
try {
  process.stdout.write(JSON.stringify(await main()) + "\n");
} catch (e) {
  const err = e instanceof ExportError ? e : null;
  const m = (e as Error).message;
  const chrome = !err && /chrom|browser|executable|launch/i.test(m);
  process.stdout.write(JSON.stringify({ status: err?.status ?? (chrome ? 501 : 422), code: err?.code ?? (chrome ? "unsupported" : /nothing drawn/.test(m) ? "not_found" : "failed"), error: chrome ? `Exporting needs Google Chrome or another Chromium: ${m}` : m.replace(/^Rendering failed: /, "") }) + "\n");
  code = 1;
}
try { shutdownRenderer(); } catch {}
process.exit(code);
