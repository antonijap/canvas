// The checks every QA scenario ends with (docs/qa-plan.md section 2). Pure parts here, node-tested in
// test/qa-checks.test.ts; the page-driving parts are in qa/runner.ts.
import fs from "node:fs";
import path from "node:path";
import { diffImages, sideBySide } from "../fidelity/diff.ts";
import { decodePng, encodePng } from "../fidelity/png.ts";
import { validateNode, validateVariable, type DocNode } from "../src/doc/schema.ts";

/** A scenario can opt out of a shared check, with the reason. */
export const CHECKS = ["undo", "reopen", "file", "console", "selection", "overlay", "latency", "visual"] as const;
export type CheckName = (typeof CHECKS)[number];
export type OptOut = Partial<Record<CheckName, string>>;

/** Budgets from docs/perf/latency.md (p95, ms). */
export const BUDGET = { frame: 16.7, input: 16.7, write: 100 } as const;
export type LatencyKind = keyof typeof BUDGET;

export const WIDGET_KINDS = new Set(["todo", "note", "posthog", "shader", "video", "welcome"]);

// ---------------------------------------------------------------- file

type Doc = { children?: DocNode[]; variables?: Record<string, unknown>; [k: string]: unknown };

/** Everything wrong with a .canvas package: schema, duplicate ids, refs and overrides that name nothing, variables
 *  that do not exist, pages that list missing boards or miss some, cards on missing pages. Empty when sound. */
export function checkPackage(dir: string): string[] {
  const errs: string[] = [];
  let doc: Doc;
  try { doc = JSON.parse(fs.readFileSync(path.join(dir, "document.json"), "utf8")); } catch (e) { return [`document.json: ${(e as Error).message}`]; }
  let side: any = null;
  const sidePath = path.join(dir, "widgets.json");
  if (fs.existsSync(sidePath)) {
    try { side = JSON.parse(fs.readFileSync(sidePath, "utf8")); } catch (e) { errs.push(`widgets.json: ${(e as Error).message}`); }
  }
  return [...errs, ...checkDocument(doc, side)];
}

export function checkDocument(doc: Doc, side: any): string[] {
  const errs: string[] = [];
  if (!Array.isArray(doc.children)) return ["document has no children list"];
  for (const n of doc.children) errs.push(...validateNode(n));
  for (const [k, v] of Object.entries(doc.variables ?? {})) errs.push(...validateVariable(k, v as any).map((e) => `variable ${k}: ${e}`));
  const ids = new Map<string, DocNode>();
  const refs: DocNode[] = [];
  const vars = new Set(Object.keys(doc.variables ?? {}));
  const walk = (n: DocNode, depth: number) => {
    if (!n || typeof n !== "object") return;
    if (typeof n.id !== "string" || !n.id) errs.push(`a ${n.type} ${depth === 0 ? "at the top" : "inside"} has no id`);
    else if (ids.has(n.id)) errs.push(`duplicate id ${n.id}`);
    else ids.set(n.id, n);
    if (n.type === "ref") refs.push(n);
    for (const [k, v] of Object.entries(n)) {
      if (k === "children" || k === "descendants" || k === "metadata") continue;
      for (const name of varNames(v)) if (!vars.has(name)) errs.push(`${n.id}.${k} uses $${name}, which is not a variable`);
    }
    for (const c of n.children ?? []) walk(c, depth + 1);
  };
  for (const n of doc.children) walk(n, 0);
  for (const r of refs) {
    const target = typeof r.ref === "string" ? ids.get(r.ref) : undefined;
    if (!target) errs.push(`instance ${r.id} refers to ${JSON.stringify(r.ref)}, which is not in the file`);
    else if (target.reusable !== true) errs.push(`instance ${r.id} refers to ${r.ref}, which is not a component`);
    const desc = r.descendants;
    if (desc && typeof desc === "object" && !Array.isArray(desc)) {
      for (const key of Object.keys(desc)) for (const seg of key.split("/")) if (!ids.has(seg)) errs.push(`instance ${r.id} overrides ${key}, but ${seg} is not in the file`);
      // A nested instance's swap (src/overrides.ts): a ref without a type, to a component; what it carried names layers.
      for (const [key, o] of Object.entries(desc as Record<string, any>)) {
        if (!o || typeof o !== "object" || o.type || typeof o.ref !== "string") continue;
        const to = ids.get(o.ref);
        if (!to || to.reusable !== true) errs.push(`instance ${r.id} swaps ${key} to ${o.ref}, which is not a component in the file`);
        if (o.descendants && typeof o.descendants === "object" && !Array.isArray(o.descendants)) {
          for (const k of Object.keys(o.descendants)) for (const seg of k.split("/")) if (!ids.has(seg)) errs.push(`instance ${r.id} overrides ${key}/${k}, but ${seg} is not in the file`);
        }
      }
    }
  }
  if (side) {
    const top = new Set(doc.children.map((n) => n.id).filter(Boolean) as string[]);
    const pages: any[] = Array.isArray(side.pages) ? side.pages : [];
    const pageIds = new Set<string>();
    const seen = new Map<string, string>();
    for (const p of pages) {
      if (!p || typeof p.id !== "string") { errs.push("a page has no id"); continue; }
      if (pageIds.has(p.id)) errs.push(`duplicate page ${p.id}`);
      pageIds.add(p.id);
      for (const b of p.boards ?? []) {
        if (!top.has(b)) errs.push(`page ${p.id} lists ${b}, which is not a top-level layer`);
        if (seen.has(b)) errs.push(`${b} is on two pages (${seen.get(b)}, ${p.id})`);
        seen.set(b, p.id);
      }
    }
    // The hidden holder of deleted main components (structure.ts DELETED_KEY) is on no page by design.
    const holders = new Set(doc.children.filter((n) => (n.metadata as Record<string, unknown> | undefined)?.canvasDeletedComponents === true).map((n) => n.id));
    if (pages.length > 1) for (const b of top) if (!seen.has(b) && !holders.has(b)) errs.push(`top-level ${b} is on no page`);
    const wids = new Set<string>();
    for (const w of side.widgets ?? []) {
      if (!w || typeof w.id !== "string") { errs.push("a card has no id"); continue; }
      if (wids.has(w.id)) errs.push(`duplicate card ${w.id}`);
      wids.add(w.id);
      if (!WIDGET_KINDS.has(w.kind)) errs.push(`card ${w.id} has unknown kind ${w.kind}`);
      if (pages.length && w.page !== undefined && !pageIds.has(w.page)) errs.push(`card ${w.id} is on page ${w.page}, which does not exist`);
      for (const k of ["x", "y", "w", "h"]) if (!Number.isFinite(w[k])) errs.push(`card ${w.id}: ${k} is ${JSON.stringify(w[k])}`);
      if (w.w <= 0 || w.h <= 0) errs.push(`card ${w.id} has size ${w.w} x ${w.h}`);
    }
  }
  return errs;
}

function varNames(v: unknown): string[] {
  if (typeof v === "string") return /^\$[A-Za-z0-9_.-]+$/.test(v) ? [v.slice(1)] : [];
  if (Array.isArray(v)) return v.flatMap(varNames);
  if (v && typeof v === "object") return Object.entries(v).flatMap(([k, x]) => (k === "metadata" ? [] : varNames(x)));
  return [];
}

// ---------------------------------------------------------------- bytes

/** The package's own files (document.json, widgets.json), byte for byte. */
export function packageBytes(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const f of ["document.json", "widgets.json"]) {
    const p = path.join(dir, f);
    if (fs.existsSync(p)) out[f] = fs.readFileSync(p, "utf8");
  }
  return out;
}

/** Where two packages first differ: the file and the first JSON path whose value differs (or the byte offset when
 *  they parse the same but are written differently). null when every file is byte-identical. */
export function firstDifference(a: Record<string, string>, b: Record<string, string>): string | null {
  for (const f of new Set([...Object.keys(a), ...Object.keys(b)])) {
    if (a[f] === b[f]) continue;
    if (a[f] === undefined || b[f] === undefined) return `${f} ${a[f] === undefined ? "appeared" : "is gone"}`;
    let ja: unknown, jb: unknown;
    try { ja = JSON.parse(a[f]); jb = JSON.parse(b[f]); } catch { return `${f} differs`; }
    const p = jsonDiff(ja, jb, "");
    if (p) return `${f} ${p}`;
    let i = 0;
    while (i < a[f].length && a[f][i] === b[f][i]) i++;
    return `${f} has the same JSON but other bytes from offset ${i}: ${JSON.stringify(a[f].slice(i, i + 40))} vs ${JSON.stringify(b[f].slice(i, i + 40))}`;
  }
  return null;
}

function jsonDiff(a: unknown, b: unknown, at: string): string | null {
  const show = (v: unknown) => (v === undefined ? "(none)" : JSON.stringify(v).slice(0, 80));
  if (a === b) return null;
  if (typeof a !== typeof b || a === null || b === null || typeof a !== "object" || Array.isArray(a) !== Array.isArray(b)) return `${at || "/"}: ${show(a)} -> ${show(b)}`;
  if (Array.isArray(a)) {
    const bb = b as unknown[];
    // Name nodes by id where there is one, so "children[3]" reads as the layer it is.
    for (let i = 0; i < Math.max(a.length, bb.length); i++) {
      const name = (x: any) => (x && typeof x === "object" && typeof x.id === "string" ? `[${x.id}]` : `[${i}]`);
      const d = jsonDiff(a[i], bb[i], `${at}${name(a[i] ?? bb[i])}`);
      if (d) return a.length !== bb.length && i >= Math.min(a.length, bb.length) ? `${at}: length ${a.length} -> ${bb.length} (${d})` : d;
    }
    return null;
  }
  const ao = a as Record<string, unknown>, bo = b as Record<string, unknown>;
  for (const k of new Set([...Object.keys(ao), ...Object.keys(bo)])) {
    const d = jsonDiff(ao[k], bo[k], `${at}.${k}`);
    if (d) return d;
  }
  // Same keys and values in another order.
  const ka = Object.keys(ao).join(","), kb = Object.keys(bo).join(",");
  return ka === kb ? null : `${at || "/"}: key order ${ka} -> ${kb}`;
}

// ---------------------------------------------------------------- pixels

export type PixelResult = { ok: boolean; mismatched: number; pct: number; sizeMismatch: boolean; diffPng?: Buffer };

/** Two PNGs compared with the fidelity diff (anti-aliased edges forgiven). `maxPct`: share of pixels allowed to
 *  differ, in percent. The diff image (expected | actual | diff) comes back when they differ at all. */
export function comparePng(expected: Buffer, actual: Buffer, maxPct = 0.05): PixelResult {
  const a = decodePng(expected), b = decodePng(actual);
  if (a.width !== b.width || a.height !== b.height) {
    return { ok: false, mismatched: Infinity, pct: 100, sizeMismatch: true, diffPng: encodePng(sideBySide(a, b, null)) };
  }
  const d = diffImages(a, b, { threshold: 0.1, ignoreAA: true });
  const pct = (100 * d.mismatched) / (a.width * a.height);
  return { ok: pct <= maxPct, mismatched: d.mismatched, pct, sizeMismatch: false, diffPng: d.mismatched ? encodePng(sideBySide(a, b, d.diff)) : undefined };
}

// ---------------------------------------------------------------- overlay UI (runs in the page)

/** Floating UI that must never overlap another piece of floating UI. */
export const OVERLAY_SELECTORS = ["#msg", "#wtoast", ".vx-line", ".vx-caption", ".sk-spark", ".sk-comp", ".sk-tip", ".ac-tag", "#labels > *"];

/**
 * Page-side check (an expression for Runtime.evaluate): visible floating UI that overlaps other floating UI (pairs
 * that are not inside one another), and one-line labels in it whose text is cut without an ellipsis or whose glyphs
 * are cut at the top or bottom. Answers a list of problems.
 */
export function overlayProblemsJs(): string {
  return `(() => {
  const sels = ${JSON.stringify(OVERLAY_SELECTORS)};
  const shown = (e) => { const s = getComputedStyle(e); if (s.display === "none" || s.visibility === "hidden" || +s.opacity === 0) return false; const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 && r.right > 0 && r.bottom > 0 && r.left < innerWidth && r.top < innerHeight; };
  const visible = (e) => { for (let x = e; x && x !== document.documentElement; x = x.parentElement) { const s = getComputedStyle(x); if (s.display === "none" || s.visibility === "hidden" || +s.opacity === 0) return false; } return true; };
  const els = [];
  for (const s of sels) for (const e of document.querySelectorAll(s)) if (shown(e) && visible(e) && !els.some((x) => x.e === e)) els.push({ s, e, r: e.getBoundingClientRect() });
  const name = (x) => x.s + (x.e.textContent ? ' "' + x.e.textContent.trim().slice(0, 30) + '"' : "");
  const out = [];
  for (let i = 0; i < els.length; i++) for (let j = i + 1; j < els.length; j++) {
    const a = els[i], b = els[j];
    if (a.e.contains(b.e) || b.e.contains(a.e)) continue;
    const w = Math.min(a.r.right, b.r.right) - Math.max(a.r.left, b.r.left), h = Math.min(a.r.bottom, b.r.bottom) - Math.max(a.r.top, b.r.top);
    if (w > 1 && h > 1) out.push("overlap: " + name(a) + " and " + name(b) + " (" + Math.round(w) + " x " + Math.round(h) + " px)");
  }
  for (const x of els) for (const e of [x.e, ...x.e.querySelectorAll("*")]) {
    if (!e.childNodes.length || ![...e.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim())) continue;
    if (!visible(e)) continue;
    const s = getComputedStyle(e);
    const clips = s.overflowX !== "visible" || s.overflowY !== "visible";
    if (!clips) continue;
    const one = s.whiteSpace === "nowrap" || s.whiteSpace === "pre";
    if (one && e.scrollWidth > e.clientWidth + 1 && s.textOverflow !== "ellipsis") out.push("clipped text (width " + e.clientWidth + " < " + e.scrollWidth + "): " + name({ s: x.s, e }));
    if (one && e.scrollHeight > e.clientHeight + 1) out.push("clipped glyphs (height " + e.clientHeight + " < " + e.scrollHeight + "): " + name({ s: x.s, e }));
  }
  return out;
})()`;
}

// ---------------------------------------------------------------- latency

/** Samples over budget, as problems: p95 per kind when there are 5 or more samples; a single sample only when it is
 *  over twice the budget (one sample on a loaded machine is noise; the run reports every kind's p95, qa/run.ts). */
export function latencyProblems(samples: { kind: LatencyKind; ms: number; what: string }[]): string[] {
  const out: string[] = [];
  const by = new Map<LatencyKind, { ms: number; what: string }[]>();
  for (const s of samples) by.set(s.kind, [...(by.get(s.kind) ?? []), s]);
  for (const [kind, xs] of by) {
    const budget = BUDGET[kind];
    if (xs.length >= 5) {
      const sorted = xs.map((x) => x.ms).sort((a, b) => a - b);
      const p95 = sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)];
      if (p95 > budget) out.push(`${kind} p95 ${p95.toFixed(1)} ms over ${budget} ms (n = ${xs.length})`);
    } else for (const x of xs) if (x.ms > 2 * budget) out.push(`${kind} ${x.what} ${x.ms.toFixed(1)} ms, over twice the ${budget} ms budget`);
  }
  return out;
}
