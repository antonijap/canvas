// Writes fidelity/out/report.html from a summary. Run alone to rebuild it from fidelity/out/summary.json.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export type ScaleResult = { scale: number; width: number; height: number; mismatchPct?: number; mismatched?: number; antialiased?: number; ssim?: number; pass?: boolean; sizeMismatch?: boolean; truth: string; engine?: string; diff?: string; side?: string; note?: string };
export type BoardResult = { file: string; board: string; name: string; truthMs: number; engineMs?: number; engine: "ok" | "pending" | "error"; error?: string; skipped?: string; scales: ScaleResult[] };
export type Summary = {
  generatedAt: string;
  engine: { available: boolean; reason: string };
  thresholds: { maxMismatchPct: number; minSsim: number };
  chrome: string;
  totalMs: number;
  selfTest?: { ok: boolean; lines: string[] };
  counts: { boards: number; compared: number; failing: number; errors: number; skipped: number };
  boards: BoardResult[];
};

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
const worst = (b: BoardResult) => Math.max(-1, ...b.scales.map((s) => s.mismatchPct ?? -1));

export function writeReport(summary: Summary, outDir: string) {
  const rows = [...summary.boards].sort((a, b) => worst(b) - worst(a) || a.file.localeCompare(b.file) || a.board.localeCompare(b.board));
  const img = (rel?: string) => (rel ? `<a href="${esc(rel)}"><img loading="lazy" src="${esc(rel)}"></a>` : `<span class="na">${"pending"}</span>`);
  const skippedRows = rows.filter((b) => b.skipped).map((b) => `<tr><td>${esc(b.file)}</td><td>${esc(b.name || b.board)}<br><small>${esc(b.board)}</small></td><td colspan="7">skipped: ${esc(b.skipped!)}</td><td></td></tr>`).join("\n");
  const body = skippedRows + rows.flatMap((b) =>
    b.scales.map((s) => {
      const bad = s.pass === false || b.engine === "error";
      const status = b.engine === "error" ? "error" : s.pass === undefined ? "pending" : s.pass ? "pass" : "FAIL";
      return `<tr class="${bad ? "bad" : ""}"><td>${esc(b.file)}</td><td>${esc(b.name || b.board)}<br><small>${esc(b.board)}</small></td><td data-v="${s.scale}">${s.scale}x</td><td data-v="${s.width * s.height}">${s.width}x${s.height}</td>
<td data-v="${s.mismatchPct ?? -1}">${s.mismatchPct === undefined ? "n/a" : s.mismatchPct.toFixed(3) + "%"}</td><td data-v="${s.ssim ?? -1}">${s.ssim === undefined ? "n/a" : s.ssim.toFixed(4)}</td>
<td data-v="${b.engineMs ?? -1}">${b.truthMs}ms${b.engineMs ? ` / ${b.engineMs}ms` : ""}</td><td>${status}${b.error ? `<br><small>${esc(b.error)}</small>` : ""}${s.note ? `<br><small>${esc(s.note)}</small>` : ""}</td>
<td class="th">${img(s.truth)}${img(s.engine)}${img(s.diff)}</td></tr>`;
    }),
  ).join("\n");
  const t = summary.thresholds;
  const html = `<!doctype html><html lang="en"><meta charset="utf-8"><title>Canvas engine fidelity</title>
<style>
:root{color-scheme:light dark;--bg:#fff;--fg:#18181b;--mut:#71717a;--line:#e4e4e7;--bad:#fee2e2}
@media (prefers-color-scheme:dark){:root{--bg:#18181b;--fg:#fafafa;--mut:#a1a1aa;--line:#3f3f46;--bad:#450a0a}}
body{font:13px/1.4 -apple-system,system-ui,sans-serif;margin:24px;background:var(--bg);color:var(--fg)}
h1{font-size:18px;margin:0 0 4px}p{margin:2px 0;color:var(--mut)}
table{border-collapse:collapse;margin-top:16px;width:100%}th,td{border-bottom:1px solid var(--line);padding:6px 8px;text-align:left;vertical-align:top}
th{cursor:pointer;user-select:none;position:sticky;top:0;background:var(--bg)}th:hover{text-decoration:underline}
tr.bad{background:var(--bad)}small{color:var(--mut)}.na{color:var(--mut);font-style:italic}
.th{white-space:nowrap}.th img{height:120px;margin-right:6px;border:1px solid var(--line);background:#fff;image-rendering:auto}
pre{background:var(--line);padding:8px;border-radius:6px;overflow:auto}
</style>
<h1>Canvas engine fidelity</h1>
<p>${esc(summary.generatedAt)} · ${esc(summary.chrome)} · ${summary.totalMs} ms total</p>
<p>Engine: <b>${summary.engine.available ? "rendered" : "pending"}</b> (${esc(summary.engine.reason)}). Limits: mismatch &le; ${t.maxMismatchPct}%, SSIM &ge; ${t.minSsim}. ${summary.counts.boards} boards, ${summary.counts.compared} compared, ${summary.counts.failing} failing, ${summary.counts.errors} errors, ${summary.counts.skipped} skipped (too large).</p>
${summary.selfTest ? `<p>Self-test: <b>${summary.selfTest.ok ? "pass" : "FAIL"}</b></p><pre>${esc(summary.selfTest.lines.join("\n"))}</pre>` : ""}
<table id="t"><thead><tr><th>File</th><th>Board</th><th>Scale</th><th>Size</th><th>Mismatch</th><th>SSIM</th><th>Time truth / engine</th><th>Status</th><th>truth | engine | diff</th></tr></thead><tbody>
${body}
</tbody></table>
<script>
const t=document.getElementById("t"),tb=t.tBodies[0];let dir=1,last=-1;
t.tHead.querySelectorAll("th").forEach((th,i)=>th.onclick=()=>{dir=last===i?-dir:(i===4?-1:1);last=i;
const v=(r)=>{const c=r.cells[i];const d=c.dataset.v;return d!==undefined?parseFloat(d):c.textContent.toLowerCase()};
[...tb.rows].sort((a,b)=>{const x=v(a),y=v(b);return (x>y?1:x<y?-1:0)*dir}).forEach(r=>tb.appendChild(r))});
</script></html>`;
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, "report.html"), html);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const out = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "out");
  const summary = JSON.parse(fs.readFileSync(path.join(out, "summary.json"), "utf8")) as Summary;
  writeReport(summary, out);
  console.log(`wrote ${path.join(out, "report.html")}`);
}
