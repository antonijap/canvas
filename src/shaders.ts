// Shader cards on disk. A shader card is a widget of kind "shader" (src/widgets/kinds/shader.ts); its
// WGSL lives in a file beside the widgets:
//   Name.canvas/shaders/<id>.wgsl                  inside a package
//   foo.shaders/<id>.wgsl                          beside a plain foo.canvas.json (a sidecar folder)
// and its poster (the frame at t = 2 s, rendered by an open page's engine) next to it as
// <id>.poster-<rev>.png, where rev is the source's hash. The widget's config.rev names the source
// revision: the source file is written (temp file, rename) before the widget that points at it, so a
// reader never sees a revision whose file is not there yet. The source file is the truth; rev tells
// open pages to fetch it again. These routes are the only writers.

import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import type http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { mediaAdded } from "./cloud-files-ops.ts";
import { inPackage, resolveDoc } from "./docpath.ts";
import { htmlSnippet, listPresets, packUniforms, PaperError, paperShader, presetsOf, reactSnippet, resolveParams, type PaperConfig } from "./paper.ts";
import { addWidget, getWidget, listWidgets, docFileFor, updateWidget, WidgetError } from "./widgets.ts";
import { SHADER_TEMPLATE } from "./widgets/kinds/shader.ts";
import { entries } from "./history.ts";
import { GROUP_MERGE_MS, isGroupMerge } from "./move.ts";
import type { Widget } from "./widgets/types.ts";

export { SHADER_TEMPLATE };

/** Largest source accepted (the engine refuses bigger ones too). */
export const MAX_SOURCE = 64 * 1024;
const MAX_POSTER = 8 * 1024 * 1024;

export const revOf = (source: string) => createHash("sha1").update(source).digest("hex").slice(0, 12);

/**
 * A card's revision: its source, and for a Paper preset card its packed params too, so a new param value
 * gets its own poster. Open pages refetch on a new rev; the engine skips a compile when the source is the same.
 */
export const cardRev = (source: string, uniforms?: unknown) => (Array.isArray(uniforms) && uniforms.length ? revOf(source + "\u0000" + uniforms.join(",")) : revOf(source));

/** The folder holding a document's shader files. */
export function shaderDir(docFile: string): string {
  let doc;
  try {
    doc = resolveDoc(docFile);
  } catch {
    return docFile.replace(/\.canvas\.json$/, "") + ".shaders";
  }
  if (doc.kind === "canvas") return inPackage(doc.displayPath, "shaders");
  return doc.docFilePath.replace(/\.canvas\.json$/, "") + ".shaders";
}

const ID_RE = /^[A-Za-z0-9_-]{1,40}$/;
const sourcePath = (docFile: string, id: string) => path.join(shaderDir(docFile), `${id}.wgsl`);
const posterPath = (docFile: string, id: string, rev: string) => path.join(shaderDir(docFile), `${id}.poster-${rev}.png`);

/** Write a file by renaming a temp file over it, so a reader sees the old bytes or the new ones. */
async function writeAtomic(file: string, bytes: string | Buffer): Promise<void> {
  await fs.promises.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  await fs.promises.writeFile(tmp, bytes);
  await fs.promises.rename(tmp, file);
}

const readText = async (file: string): Promise<string | null> => {
  try {
    return await fs.promises.readFile(file, "utf8");
  } catch {
    return null;
  }
};

// Every source a card had is also kept as <id>.src-<rev>.wgsl (content-addressed, the newest SNAPSHOTS per card):
// Undo and Redo put the card's config (its rev) back, and the source that rev names is found again here. Without
// them Undo of a source change restored the old rev over the new source, which then stayed for good.
const SNAPSHOTS = 64;
const snapPath = (docFile: string, id: string, srcRev: string) => path.join(shaderDir(docFile), `${id}.src-${srcRev}.wgsl`);
async function snapshot(docFile: string, id: string, source: string): Promise<void> {
  const file = snapPath(docFile, id, revOf(source));
  if (await fs.promises.stat(file).catch(() => null)) {
    const t = new Date();
    await fs.promises.utimes(file, t, t).catch(() => {});
  } else await writeAtomic(file, source);
  const dir = shaderDir(docFile);
  const mine = (await fs.promises.readdir(dir).catch(() => [] as string[])).filter((f) => f.startsWith(`${id}.src-`) && f.endsWith(".wgsl"));
  if (mine.length <= SNAPSHOTS) return;
  // A source a step in Undo or Redo still names is kept, however old: pruning it would make that step restore the
  // config without its source.
  const named: { rev: string; uniforms?: unknown }[] = [];
  const h = entries(docFile);
  for (const e of [...h.undo, ...h.redo]) for (const o of e.ops) {
    if (o.t !== "widget" || o.id !== id) continue;
    for (const w of [o.b, o.a]) { const c = w?.config as { rev?: unknown; uniforms?: unknown } | undefined; if (typeof c?.rev === "string") named.push({ rev: c.rev, uniforms: c.uniforms }); }
  }
  const aged = await Promise.all(mine.map(async (f) => ({ f, t: (await fs.promises.stat(path.join(dir, f)).catch(() => null))?.mtimeMs ?? 0 })));
  aged.sort((a, b) => b.t - a.t);
  for (const { f } of aged.slice(SNAPSHOTS)) {
    const text = named.length ? await readText(path.join(dir, f)) : null;
    if (text !== null && named.some((n) => cardRev(text, n.uniforms) === n.rev)) continue;
    await fs.promises.rm(path.join(dir, f), { force: true });
  }
}

/** Every shader card's file as its config names it (after an Undo or Redo): what Save As copies must be right. */
export async function settleShaderSources(file: string): Promise<void> {
  let ws: Widget[] = [];
  try {
    ws = listWidgets(file).widgets as Widget[];
  } catch {
    return;
  }
  for (const w of ws) if (w.kind === "shader") await readShaderSource(file, w.id).catch(() => {});
}
/** Write a card's source file, keeping the old and the new source as snapshots. */
async function writeSource(docFile: string, id: string, source: string, old: string | null): Promise<void> {
  // Both snapshots before the file changes: a failure leaves the file as it was (the caller's restore never runs then).
  if (old !== null) await snapshot(docFile, id, old);
  await snapshot(docFile, id, source);
  await writeAtomic(sourcePath(docFile, id), source);
  // A media add: the source's content-addressed copy is the file a Cloud file keeps (the card's own <id>.wgsl
  // changes in place, a blob never does).
  mediaAdded(docFile, snapPath(docFile, id, revOf(source)));
}

/** A pasted shader card's source, written under its new id before the card that names it (src/clipcards.ts). */
export async function writePastedSource(docFile: string, id: string, source: string): Promise<string> {
  if (!ID_RE.test(id)) throw new WidgetError(422, "invalid-widget", "id must be 1-40 letters, digits, - or _");
  await writeSource(docFile, id, checkSource(source), null);
  return sourcePath(docFile, id);
}

export type LintError ={ line: number; col: number; message: string };

/**
 * The same checks the engine runs before it compiles (engine/src/shaders.rs check_source), here so an
 * agent hears about them with no page open. Fragment code only: no entry points, bindings, storage,
 * workgroup memory, atomics, textures, samplers or extensions; `fn shade` must exist. The loop check is
 * best effort (loop without break, while true, for without a condition); a huge or data-dependent bound
 * still passes.
 */
export function lintWgsl(src: string): LintError[] {
  if (Buffer.byteLength(src) > MAX_SOURCE) return [{ line: 1, col: 1, message: `The shader is ${Math.round(Buffer.byteLength(src) / 1024)} KB; the limit is ${MAX_SOURCE / 1024} KB` }];
  // Comments blanked, positions kept.
  let b = "";
  for (let i = 0, depth = 0; i < src.length; ) {
    if (!depth && src.startsWith("//", i)) {
      while (i < src.length && src[i] !== "\n") { b += " "; i++; }
    } else if (src.startsWith("/*", i)) { depth++; b += "  "; i += 2; }
    else if (depth && src.startsWith("*/", i)) { depth--; b += "  "; i += 2; }
    else { b += depth && src[i] !== "\n" ? " " : src[i]; i++; }
  }
  const out: LintError[] = [];
  const at = (i: number, message: string) => {
    const before = b.slice(0, i);
    const line = before.split("\n").length;
    out.push({ line, col: i - before.lastIndexOf("\n"), message });
  };
  const words = (w: string) => {
    const re = new RegExp((w.startsWith("@") ? "" : "(?<![A-Za-z0-9_])") + w.replace(/[@]/g, "@") + "(?![A-Za-z0-9_])", "g");
    return [...b.matchAll(re)].map((m) => m.index!);
  };
  const BANNED: [string, string][] = [
    ["@compute", "compute shaders are not allowed; write fn shade(p) instead"],
    ["@vertex", "Canvas provides the vertex stage; write fn shade(p) instead"],
    ["@fragment", "Canvas provides the entry point; write fn shade(p) instead"],
    ["@group", "bindings are not allowed; read the uniforms through u"],
    ["@binding", "bindings are not allowed; read the uniforms through u"],
    ["@workgroup_size", "compute shaders are not allowed"],
    ["enable", "extensions are not allowed"],
    ["requires", "language extensions are not allowed"],
    ["storage", "storage memory is not allowed"],
    ["workgroup", "workgroup memory is not allowed"],
    ["atomic", "atomics are not allowed"],
    ["sampler", "samplers are not allowed: Canvas binds no textures in this version"],
    ["sampler_comparison", "samplers are not allowed"],
  ];
  for (const [w, why] of BANNED) for (const i of words(w)) at(i, `${w}: ${why}`);
  for (const m of b.matchAll(/(?<![A-Za-z0-9_])texture_/g)) at(m.index!, "textures are not allowed: Canvas binds no textures in this version");
  const hasBreak = words("break").length > 0;
  if (!hasBreak) for (const i of words("loop")) at(i, "loop without break never ends; use a for loop with a fixed bound");
  for (const m of b.matchAll(/(?<![A-Za-z0-9_])while\s*\(?\s*true(?![A-Za-z0-9_])/g)) at(m.index!, "while true never ends; use a for loop with a fixed bound");
  for (const m of b.matchAll(/(?<![A-Za-z0-9_])for\s*\([^;]*;\s*;/g)) at(m.index!, "a for loop without a condition never ends");
  if (!/(?<![A-Za-z0-9_])fn\s+shade(?![A-Za-z0-9_])/.test(b)) out.push({ line: 1, col: 1, message: "Define fn shade(p: vec2<f32>) -> vec4<f32>; it returns the premultiplied colour of the pixel at p (card px)" });
  return out.sort((x, y) => x.line - y.line || x.col - y.col);
}

/** One write at a time per shader, so two saves of the same card cannot interleave file and widget. */
const chains = new Map<string, Promise<unknown>>();
function serial<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const p = (chains.get(key) ?? Promise.resolve()).then(fn, fn);
  const tail = p.catch(() => undefined);
  chains.set(key, tail);
  tail.then(() => { if (chains.get(key) === tail) chains.delete(key); });
  return p;
}

/** preset: a Paper shader id ("mesh-gradient") or id/variant ("mesh-gradient/Ink"); variant: one of its presets; params: overrides. */
export type ShaderInput = { source?: string; name?: string; x?: number; y?: number; w?: number; h?: number; autoplay?: boolean; page?: string; preset?: string; variant?: string; params?: Record<string, unknown>; /** id of a shader card to copy: its source, uniforms and settings */ copyFrom?: string };
export type ShaderPatch = { source?: string; name?: string; x?: number; y?: number; w?: number; h?: number; autoplay?: boolean; quarantined?: boolean; preset?: string; variant?: string; params?: Record<string, unknown> };
type Who = { source?: "user" | "mcp"; session?: string; mergeKey?: string; mergeMs?: number; label?: string };

function checkSource(source: unknown): string {
  if (typeof source !== "string") throw new WidgetError(422, "invalid-widget", "source must be WGSL text");
  if (Buffer.byteLength(source) > MAX_SOURCE) throw new WidgetError(413, "too-large", `The shader is larger than ${MAX_SOURCE / 1024} KB`);
  return source;
}

/** packed u.params without trailing zeros (the engine pads with zeros). */
const trimZeros = (a: number[]) => { let n = a.length; while (n && a[n - 1] === 0) n--; return a.slice(0, n).map((x) => Math.round(x * 1e6) / 1e6); };

/**
 * A Paper preset card's source, config and packed params. `preset` is a shader id, optionally with a
 * variant ("mesh-gradient/Ink"); `base` keeps the card's current params when only some change.
 */
export function paperCard(preset: string, variant: string | undefined, params: Record<string, unknown> | undefined, base?: PaperConfig) {
  if (typeof preset !== "string") throw new WidgetError(422, "invalid-widget", "preset must be a Paper shader id");
  const [id, v] = preset.includes("/") ? preset.split("/", 2) : [preset, variant];
  const s = paperShader(id);
  if (!s) throw new WidgetError(422, "invalid-widget", `No Paper shader "${id}"; shaders: ${listPresets().shaders.map((x) => x.id).join(", ")}`);
  if (params !== undefined && (!params || typeof params !== "object" || Array.isArray(params))) throw new WidgetError(422, "invalid-widget", "params must be an object");
  try {
    const keep = base && base.shader === id && !v ? base.params : undefined;
    const r = resolveParams(s, v || undefined, params ?? {}, keep);
    const paper: PaperConfig = { shader: id, preset: keep && params && Object.keys(params).length ? "Custom" : keep ? base!.preset : r.preset, params: r.params };
    return { source: s.wgsl, paper, uniforms: trimZeros(packUniforms(s, r.params).packed), animated: s.animated && Number(r.params.speed ?? 0) !== 0 };
  } catch (e) {
    if (e instanceof PaperError) throw new WidgetError(422, "invalid-widget", e.message);
    throw e;
  }
}

/** A new shader card: its source file first, then the widget that points at it. */
export async function createShader(file: string, input: ShaderInput, who: Who = {}) {
  const docFile = docFileFor(file);
  // A copy (Option-drag) takes the original card's source and settings; the new id has no source file of its own yet.
  let from: { source: string; config: Record<string, unknown>; name?: string } | undefined;
  if (input.copyFrom !== undefined) {
    if (!ID_RE.test(input.copyFrom)) throw new WidgetError(404, "no-widget", `No widget "${input.copyFrom}"`);
    const w = getWidget(file, input.copyFrom).widget as Widget;
    if (w.kind !== "shader") throw new WidgetError(422, "invalid-widget", "Only a shader card can be copied here");
    from = { source: (await readShaderSource(file, input.copyFrom)).source, config: { ...(w.config as Record<string, unknown>) }, name: w.name };
  }
  const made = !from && input.preset !== undefined ? paperCard(input.preset, input.variant, input.params) : undefined;
  const source = from ? from.source : made ? made.source : checkSource(input.source ?? SHADER_TEMPLATE);
  const id = "sh_" + [...randomBytes(8)].map((b) => (b % 36).toString(36)).join("");
  const rev = cardRev(source, from ? (from.config.uniforms as number[] | undefined) : made?.uniforms);
  const src = sourcePath(docFile, id);
  await writeSource(docFile, id, source, null);
  try {
    const { widget } = await addWidget(file, {
      kind: "shader", id, name: input.name ?? from?.name ?? (made ? `${paperShader(made.paper.shader)!.name}${made.paper.preset !== "Default" ? ` (${made.paper.preset})` : ""}` : undefined), x: input.x, y: input.y, w: input.w, h: input.h, page: input.page,
      config: from ? { ...from.config, rev } : { rev, autoplay: input.autoplay ?? (made ? made.animated : true), quarantined: false, ...(made ? { paper: made.paper, uniforms: made.uniforms } : {}) },
    }, { record: { label: "Add Shader", ...who } });
    return { widget, rev, problems: lintWgsl(source) };
  } catch (e) {
    await fs.promises.rm(src, { force: true });
    throw e;
  }
}

/** Change a shader card: the new source file (if any) first, then the widget; the old source comes back if the widget write fails. */
export async function updateShader(file: string, id: string, patch: ShaderPatch, who: Who = {}) {
  const docFile = docFileFor(file);
  if (!ID_RE.test(id)) throw new WidgetError(404, "no-widget", `No widget "${id}"`);
  const kindOf = () => {
    const w = getWidget(file, id).widget;
    if (w.kind !== "shader") throw new WidgetError(422, "invalid-widget", `Widget "${id}" is a ${w.kind}, not a shader`);
    return w;
  };
  kindOf();
  return serial(`${docFile}\u0000${id}`, async () => {
    // Read inside the queue: a patch that waited behind another builds on what that one wrote, not on the card as
    // it was when both arrived (two param changes at once would otherwise lose the first).
    const current = kindOf();
    const config: Record<string, unknown> = {};
    let problems: LintError[] | undefined;
    let restore: (() => Promise<void>) | undefined;
    const cur = (current.config as { paper?: PaperConfig }).paper;
    if (patch.source === undefined && (patch.preset !== undefined || patch.variant !== undefined || patch.params !== undefined)) {
      if (!cur && patch.preset === undefined) throw new WidgetError(422, "invalid-widget", "This shader card is not a Paper preset: pass preset to make it one, or change its source");
      const made = paperCard(patch.preset ?? cur!.shader, patch.variant, patch.params, cur);
      const src = sourcePath(docFile, id);
      const old = (await currentSource(docFile, id, current)).text;
      if (old !== made.source) {
        await writeSource(docFile, id, made.source, old);
        restore = old === null ? () => fs.promises.rm(src, { force: true }) : () => writeAtomic(src, old);
        config.quarantined = false;
      }
      // The widget write deep-merges config: params the new set lacks (another shader's) are cleared with null.
      const params: Record<string, unknown> = { ...made.paper.params };
      for (const k of Object.keys(cur?.params ?? {})) if (!(k in params)) params[k] = null;
      config.paper = { ...made.paper, params };
      config.uniforms = made.uniforms;
      config.rev = cardRev(made.source, made.uniforms);
      problems = lintWgsl(made.source);
    } else if (patch.source !== undefined) {
      const source = checkSource(patch.source);
      const src = sourcePath(docFile, id);
      const old = (await currentSource(docFile, id, current)).text;
      if (old !== source) {
        await writeSource(docFile, id, source, old);
        restore = old === null ? () => fs.promises.rm(src, { force: true }) : () => writeAtomic(src, old);
      }
      config.rev = revOf(source);
      // A new source runs again: the quarantine was for the old one.
      config.quarantined = false;
      problems = lintWgsl(source);
      // Hand-written WGSL: no longer a Paper preset.
      if (cur) { config.paper = null; config.uniforms = null; }
    }
    if (patch.autoplay !== undefined) config.autoplay = patch.autoplay === true;
    if (patch.quarantined !== undefined) config.quarantined = patch.quarantined === true;
    const wp: Record<string, unknown> = {};
    for (const k of ["name", "x", "y", "w", "h"] as const) if (patch[k] !== undefined) wp[k] = patch[k];
    if (Object.keys(config).length) wp.config = config;
    const label = patch.source !== undefined ? "Edit Shader" : patch.params !== undefined || patch.variant !== undefined || patch.preset !== undefined ? "Shader Params" : patch.quarantined !== undefined ? "Shader Quarantine" : "Shader Change";
    try {
      const mergeKey = `shader:${id}:${Object.keys(wp).sort().join(",")}${patch.params ? ":" + Object.keys(patch.params).sort().join(",") : ""}`;
      const { widget } = await updateWidget(file, id, wp, { record: { label, mergeKey, ...who } });
      return { widget, rev: (widget.config as { rev?: string }).rev ?? "", ...(problems ? { problems } : {}) };
    } catch (e) {
      if (restore) await restore().catch(() => {});
      throw e;
    }
  });
}

/** The card's source: the file, or the template for a card added without one. */
export async function readShaderSource(file: string, id: string): Promise<{ source: string; rev: string; template: boolean }> {
  const docFile = docFileFor(file);
  if (!ID_RE.test(id)) throw new WidgetError(404, "no-widget", `No widget "${id}"`);
  // In the card's queue: putting the file back must not cross an update writing a new source.
  const { text, w } = await serial(`${docFile}\u0000${id}`, async () => {
    let w: Widget | undefined;
    try {
      w = getWidget(file, id).widget as Widget;
    } catch {}
    return { ...(await currentSource(docFile, id, w)), w };
  });
  const source = text ?? SHADER_TEMPLATE;
  const uniforms = (w?.config as { uniforms?: unknown } | undefined)?.uniforms;
  return { source, rev: cardRev(source, uniforms), template: text === null };
}

/**
 * The source the card's rev names. After an Undo or Redo the config holds another rev than the file: the snapshot
 * with that rev is the card's source, and the file is put back to it. A file nobody wrote through Canvas (edited by
 * hand: no snapshot holds it) is left as it is.
 */
async function currentSource(docFile: string, id: string, w: Widget | undefined): Promise<{ text: string | null }> {
  const file = sourcePath(docFile, id);
  const text = await readText(file);
  const cfg = (w?.config ?? {}) as { rev?: unknown; uniforms?: unknown };
  if (typeof cfg.rev !== "string" || (text !== null && cardRev(text, cfg.uniforms) === cfg.rev)) return { text };
  if (text !== null && !(await fs.promises.stat(snapPath(docFile, id, revOf(text))).catch(() => null))) return { text };
  const dir = shaderDir(docFile);
  for (const f of await fs.promises.readdir(dir).catch(() => [] as string[])) {
    if (!f.startsWith(`${id}.src-`) || !f.endsWith(".wgsl")) continue;
    const snap = await readText(path.join(dir, f));
    if (snap === null || cardRev(snap, cfg.uniforms) !== cfg.rev) continue;
    await writeAtomic(file, snap).catch(() => {});
    return { text: snap };
  }
  return { text };
}

export async function listShaders(file: string) {
  const docFile = docFileFor(file);
  const all = listWidgets(file).widgets as Widget[];
  const out = [];
  for (const w of all.filter((x) => x.kind === "shader")) {
    const { source, rev, template } = await readShaderSource(file, w.id);
    const c = w.config as { rev?: string; autoplay?: boolean; quarantined?: boolean; paper?: PaperConfig };
    out.push({
      id: w.id, name: w.name, x: w.x, y: w.y, w: w.w, h: w.h, ...(w.page ? { page: w.page } : {}),
      rev, autoplay: c.autoplay !== false, quarantined: c.quarantined === true, template,
      ...(c.paper ? { paper: { shader: c.paper.shader, preset: c.paper.preset, params: c.paper.params } } : {}),
      lines: source.split("\n").length, bytes: Buffer.byteLength(source),
      poster: fs.existsSync(posterPath(docFile, w.id, rev)),
      problems: lintWgsl(source),
    });
  }
  return { shaders: out, dir: shaderDir(docFile) };
}

async function savePoster(file: string, id: string, rev: string, png: Buffer) {
  const docFile = docFileFor(file);
  if (!ID_RE.test(id) || !/^[0-9a-f]{12}$/.test(rev)) throw new WidgetError(400, "bad-body", "id and a 12-digit rev are required");
  if (png.length < 8 || png.readUInt32BE(0) !== 0x89504e47) throw new WidgetError(400, "bad-body", "The body must be a PNG");
  // Only a poster of the current source is kept.
  const { rev: now } = await readShaderSource(file, id);
  if (now !== rev) return { saved: false, reason: "the source changed" };
  await writeAtomic(posterPath(docFile, id, rev), png);
  const dir = shaderDir(docFile);
  for (const f of await fs.promises.readdir(dir).catch(() => [] as string[])) {
    if (f.startsWith(`${id}.poster-`) && f !== `${id}.poster-${rev}.png`) await fs.promises.rm(path.join(dir, f), { force: true });
  }
  return { saved: true };
}

// ---------- HTTP ----------

const PAGE_JS = path.join(path.dirname(fileURLToPath(import.meta.url)), "page", "shaders.js");
const THUMBS = path.join(path.dirname(fileURLToPath(import.meta.url)), "paper", "thumbs");

function reply(res: http.ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store", "x-content-type-options": "nosniff" });
  res.end(JSON.stringify(body));
}

async function readBytes(req: http.IncomingMessage, max: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > max) throw new WidgetError(413, "too-large", `The request body is larger than ${Math.round(max / 1024)} KB`);
    chunks.push(c as Buffer);
  }
  return Buffer.concat(chunks);
}

async function readJson(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  const raw = await readBytes(req, MAX_SOURCE * 2 + 16 * 1024);
  if (!raw.length) return {};
  let j: unknown;
  try {
    j = JSON.parse(raw.toString("utf8"));
  } catch {
    throw new WidgetError(400, "bad-json", "The request body is not valid JSON");
  }
  if (!j || typeof j !== "object" || Array.isArray(j)) throw new WidgetError(400, "bad-body", "The request body must be a JSON object");
  return j as Record<string, unknown>;
}

/** /api/shaders* and /page/shaders.js. Returns false for anything else. `onAgentEdit` feeds finish_work. */
export async function handleShaderRoute(req: http.IncomingMessage, res: http.ServerResponse, url: URL, onAgentEdit?: (file: string, id: string) => void): Promise<boolean> {
  if (url.pathname === "/page/shaders.js") {
    try {
      const body = await fs.promises.readFile(PAGE_JS);
      res.writeHead(200, { "content-type": "text/javascript; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" });
      res.end(body);
    } catch {
      reply(res, 404, { error: "not found" });
    }
    return true;
  }
  if (url.pathname !== "/api/shaders" && !url.pathname.startsWith("/api/shaders/")) return false;
  try {
    const m = req.method ?? "GET";
    if (m !== "GET" && req.headers["x-canvas"] !== "1") return reply(res, 403, { error: "forbidden", code: "forbidden" }), true;
    const file = url.searchParams.get("file") ?? "";
    const [id, what, more] = url.pathname.split("/").slice(3).map(decodeURIComponent);
    if (id === "presets" && m === "GET") {
      if (!what) return reply(res, 200, listPresets()), true;
      const s = paperShader(what);
      if (!s) return reply(res, 404, { error: `No Paper shader "${what}"`, code: "not-found" }), true;
      if (!more) return reply(res, 200, { id: s.id, name: s.name, description: s.description, animated: s.animated, params: s.params, presets: presetsOf(s.id) }), true;
      if (more === "thumb") {
        const slug = (url.searchParams.get("preset") ?? "Default").toLowerCase().replace(/[^a-z0-9]+/g, "-");
        const img = await fs.promises.readFile(path.join(THUMBS, `${s.id}--${slug}.webp`)).catch(() => null);
        if (!img) return reply(res, 404, { error: "no thumbnail", code: "not-found" }), true;
        res.writeHead(200, { "content-type": "image/webp", "cache-control": "max-age=3600", "x-content-type-options": "nosniff" });
        res.end(img);
        return true;
      }
    }
    const mcp = req.headers["x-canvas-source"] === "mcp";
    const who: Who = { source: mcp ? "mcp" : "user", session: String(req.headers["x-canvas-session"] ?? "").slice(0, 80) || undefined };
    // A card Option-dragged with layers (x-canvas-merge): its copy joins their duplicate as one undo step.
    const groupKey = req.headers["x-canvas-merge"];
    const dupWho: Who = isGroupMerge(groupKey) ? { ...who, label: "Duplicate", mergeKey: groupKey, mergeMs: GROUP_MERGE_MS } : who;
    const edited = (wid: string) => { if (mcp && file && onAgentEdit) onAgentEdit(file, wid); };
    if (!id) {
      if (m === "GET") return reply(res, 200, await listShaders(file)), true;
      if (m === "POST") {
        const body = await readJson(req);
        const made = await createShader(file, body as ShaderInput, (body as ShaderInput).copyFrom !== undefined ? dupWho : who);
        edited(made.widget.id);
        return reply(res, 201, made), true;
      }
    } else if (!what) {
      if (m === "PUT" || m === "PATCH") {
        const body = await readJson(req);
        const done = await updateShader(file, id, body as ShaderPatch, who);
        edited(id);
        return reply(res, 200, done), true;
      }
    } else if (what === "export" && m === "GET") {
      const w = getWidget(file, id).widget;
      const p = (w.config as { paper?: PaperConfig }).paper;
      if (w.kind !== "shader" || !p) throw new WidgetError(422, "invalid-widget", "Only Paper preset cards export as React or HTML");
      const format = url.searchParams.get("format") ?? "react";
      if (format !== "react" && format !== "html") throw new WidgetError(400, "bad-body", "format must be react or html");
      const code = format === "react" ? reactSnippet(p, w) : htmlSnippet(p, w);
      return reply(res, 200, { format, shader: p.shader, preset: p.preset, code }), true;
    } else if (what === "source" && m === "GET") {
      const s = await readShaderSource(file, id);
      res.writeHead(200, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff", "x-shader-rev": s.rev, "x-shader-template": s.template ? "1" : "0" });
      res.end(s.source);
      return true;
    } else if (what === "poster") {
      const rev = url.searchParams.get("rev") ?? "";
      if (m === "GET") {
        const docFile = docFileFor(file);
        if (!ID_RE.test(id) || !/^[0-9a-f]{12}$/.test(rev)) return reply(res, 404, { error: "not found" }), true;
        const png = await fs.promises.readFile(posterPath(docFile, id, rev)).catch(() => null);
        if (!png) return reply(res, 404, { error: "no poster for this revision", code: "not-found" }), true;
        res.writeHead(200, { "content-type": "image/png", "cache-control": "no-store", "x-content-type-options": "nosniff" });
        res.end(png);
        return true;
      }
      if (m === "PUT") return reply(res, 200, await savePoster(file, id, rev, await readBytes(req, MAX_POSTER))), true;
    }
    reply(res, 404, { error: "not found", code: "not-found" });
  } catch (e) {
    if (e instanceof WidgetError) reply(res, e.status || 500, { error: e.message, code: e.code });
    else reply(res, 500, { error: (e as Error).message });
  }
  return true;
}

