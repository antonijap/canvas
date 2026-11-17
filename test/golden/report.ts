// The HTML report: one row per view, Chrome | engine | diff, worst first.
import fs from "node:fs";
import path from "node:path";
import type { Blob, Seam } from "./metrics.ts";

export type ViewResult = {
  fixture: string; view: string; zoom: number; dpr: number; width: number; height: number;
  fidelity?: { mismatchPct: number; ssim: number; blob: number; blobAt?: Blob; blobs: number; antialiased: number; pass: boolean };
  regression?: { status: "same" | "changed" | "missing" | "updated"; mismatchPct?: number; ssim?: number; blob?: number };
  images?: { chrome: string; engine: string; diff: string; baselineDiff?: string };
  seam?: Seam; worst?: string; known?: string; note?: string; warnings?: string[]; error?: string;
};

const esc = (s: unknown) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export function writeReport(summary: { generatedAt: string; chrome: string; adapter: string; stalePkg: boolean; limits: any; totalMs: number; counts: Record<string, number>; results: ViewResult[] }, outDir: string) {
  const score = (r: ViewResult) => (r.error ? 1e9 : r.regression?.status === "changed" ? 1e8 : 0) + (r.fidelity && !r.fidelity.pass ? 1e6 : 0) + (r.fidelity ? r.fidelity.mismatchPct * 100 + (1 - r.fidelity.ssim) * 1e4 : 0);
  const rows = [...summary.results].sort((a, b) => score(b) - score(a)).map((r) => {
    const f = r.fidelity;
    const state = r.error ? "err" : r.regression?.status === "changed" ? "reg" : f && !f.pass ? (r.known ? "gap" : "fail") : "ok";
    const label = { err: "error", reg: "regression", gap: "known gap", fail: "differs from Chrome", ok: "pass" }[state];
    const img = (src?: string, cap = "") => (src ? `<figure><a href="${esc(src)}"><img loading="lazy" src="${esc(src)}"></a><figcaption>${cap}</figcaption></figure>` : "");
    return `<section class="${state}" id="${esc(r.fixture)}@${esc(r.view)}"><h2>${esc(r.fixture)} <small>@${esc(r.view)}</small> <span class="tag">${label}</span></h2>
<p class="m">${r.width}x${r.height} px, zoom ${r.zoom}, dpr ${r.dpr}${f ? ` · mismatch <b>${f.mismatchPct.toFixed(3)}%</b> · SSIM <b>${f.ssim.toFixed(4)}</b> · largest blob <b>${f.blob}</b> px${f.blobAt ? ` at ${f.blobAt.x},${f.blobAt.y} (${f.blobAt.w}x${f.blobAt.h})` : ""} · ${f.blobs} blobs · ${f.antialiased} AA px forgiven` : ""}${r.seam ? ` · tile edges: <b>${r.seam.seamPx}</b> px mismatched, ${r.seam.ratio.toFixed(1)}x the rest${r.seam.visible ? " (<b>seam</b>)" : ""}` : ""}${r.regression ? ` · baseline: <b>${r.regression.status}</b>${r.regression.mismatchPct !== undefined ? ` (${r.regression.mismatchPct.toFixed(3)}%, blob ${r.regression.blob})` : ""}` : ""}</p>
${r.error ? `<p class="e">${esc(r.error)}</p>` : ""}${r.known ? `<p class="k">Known gap: ${esc(r.known)}</p>` : ""}${r.note ? `<p class="n">${esc(r.note)}</p>` : ""}${r.warnings?.length ? `<p class="n">${r.warnings.slice(0, 6).map(esc).join("<br>")}</p>` : ""}
<div class="row">${img(r.images?.chrome, "Chrome")}${img(r.images?.engine, "engine")}${img(r.images?.diff, "diff (red = mismatch, yellow = anti-aliasing)")}</div>
${r.worst ? `<div class="row">${img(r.worst, "largest blob: Chrome | engine | diff")}</div>` : ""}${r.images?.baselineDiff ? `<div class="row">${img(r.images.baselineDiff, "baseline | engine now | diff")}</div>` : ""}</section>`;
  }).join("\n");
  const c = summary.counts;
  const html = `<!doctype html><meta charset="utf-8"><title>Canvas golden report</title>
<style>
:root{color-scheme:light dark;--bg:#fafafa;--fg:#18181b;--mut:#71717a;--line:#e4e4e7;--bad:#dc2626;--warn:#b45309;--ok:#15803d}
@media(prefers-color-scheme:dark){:root{--bg:#18181b;--fg:#fafafa;--mut:#a1a1aa;--line:#3f3f46;--bad:#f87171;--warn:#fbbf24;--ok:#4ade80}}
body{margin:0;padding:24px;background:var(--bg);color:var(--fg);font:13px/1.5 ui-sans-serif,system-ui,sans-serif}
h1{font-size:20px;margin:0 0 4px}h2{font-size:15px;margin:0 0 2px}small{color:var(--mut);font-weight:400}
section{border-top:1px solid var(--line);padding:16px 0}.m,.n{color:var(--mut);margin:2px 0}.e{color:var(--bad)}.k{color:var(--warn);margin:2px 0}
.tag{font-size:11px;font-weight:600;padding:1px 8px;border-radius:999px;border:1px solid currentColor;margin-left:6px;vertical-align:1px}
.ok .tag{color:var(--ok)}.gap .tag{color:var(--warn)}.fail .tag,.reg .tag,.err .tag{color:var(--bad)}
.row{display:flex;gap:12px;flex-wrap:wrap;margin-top:8px}figure{margin:0;min-width:0}figcaption{color:var(--mut);font-size:11px}
img{max-width:min(420px,100%);max-height:420px;border:1px solid var(--line);background:#fff;image-rendering:auto}
table{border-collapse:collapse;margin:12px 0}td,th{padding:2px 12px 2px 0;text-align:left}
</style>
<h1>Canvas golden report</h1>
<p class="m">${esc(summary.generatedAt)} · ${esc(summary.chrome)} · ${esc(summary.adapter)} · ${(summary.totalMs / 1000).toFixed(1)}s${summary.stalePkg ? " · <b>engine/pkg is older than engine/src</b>" : ""}</p>
<table><tr><th>fixtures</th><th>views</th><th>differ from Chrome</th><th>of those known</th><th>regressions</th><th>no baseline</th><th>errors</th></tr>
<tr><td>${c.fixtures}</td><td>${c.views}</td><td>${c.fidelityFail}</td><td>${c.knownGaps}</td><td>${c.regressions}</td><td>${c.missingBaselines}</td><td>${c.errors}</td></tr></table>
<p class="m">Fidelity limits: mismatch ≤ ${summary.limits.fidelity.mismatchPct}%, SSIM ≥ ${summary.limits.fidelity.ssim}, largest blob ≤ ${summary.limits.fidelity.blob} CSS px². Regression limits: mismatch ≤ ${summary.limits.regression.mismatchPct}%, SSIM ≥ ${summary.limits.regression.ssim}, blob ≤ ${summary.limits.regression.blob}.</p>
${rows}`;
  fs.writeFileSync(path.join(outDir, "report.html"), html);
}
