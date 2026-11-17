// In-process timing of the server's pure functions on one file, in a fresh process (so "cold" includes JIT).
// Usage: node --expose-gc bench/inproc.ts <file.canvas.json>   -> JSON on stdout
import fs from "node:fs";
import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import { boardHtml, boardsOf, componentsOf, snapshotOf, textStylesOf } from "../src/boards.ts";
import { loadDoc } from "../src/engine.ts";
import { stats } from "./lib.ts";

const file = process.argv[2];
const t = <T>(f: () => T): [number, T] => { const a = performance.now(); const r = f(); return [performance.now() - a, r]; };
const gcHeap = () => { (globalThis as any).gc?.(); return process.memoryUsage().heapUsed; };

const heap0 = gcHeap();
const out: any = { file, bytes: fs.statSync(file).size };

// cold = first call in this process
const [coldLoad, loaded] = t(() => loadDoc(file));
const [coldSnap, snap] = t(() => snapshotOf(loaded));
out.cold = { loadDocMs: coldLoad, snapshotOfMs: coldSnap, totalMs: coldLoad + coldSnap };

// loadDoc phases (what loadDoc does, separated)
const phases = { read: [] as number[], parse: [] as number[], sha256: [] as number[], trimEnd: [] as number[], loadDoc: [] as number[], boardsOf: [] as number[], componentsOf: [] as number[], textStylesOf: [] as number[], snapshotOf: [] as number[], docPayloadStringify: [] as number[] };
const N = Number(process.env.BENCH_INPROC_N ?? 12);
for (let i = 0; i < N; i++) {
  let [a, raw] = t(() => fs.readFileSync(file, "utf8")); phases.read.push(a);
  let [b] = t(() => JSON.parse(raw)); phases.parse.push(b);
  let [c] = t(() => createHash("sha256").update(raw).digest("hex")); phases.sha256.push(c);
  let [d] = t(() => raw.slice(raw.trimEnd().length)); phases.trimEnd.push(d);
  const [e, l] = t(() => loadDoc(file)); phases.loadDoc.push(e);
  phases.boardsOf.push(t(() => boardsOf(l.doc))[0]);
  phases.componentsOf.push(t(() => componentsOf(l.doc))[0]);
  phases.textStylesOf.push(t(() => textStylesOf(l.doc))[0]);
  const [f, s] = t(() => snapshotOf(l)); phases.snapshotOf.push(f);
  phases.docPayloadStringify.push(t(() => JSON.stringify({ name: s.name, revision: s.revision, boards: s.boards, components: s.components, styles: s.styles, variables: s.variables, themes: s.themes }))[0]);
}
out.warm = Object.fromEntries(Object.entries(phases).map(([k, v]) => [k, stats(v)]));
out.docPayloadBytes = JSON.stringify({ name: snap.name, revision: snap.revision, boards: snap.boards, components: snap.components, styles: snap.styles, variables: snap.variables, themes: snap.themes }).length;
out.counts = { boards: snap.boards.length, components: snap.components.length, styles: snap.styles.length };

// boardHtml per board: first call per board (cold) and 3 warm repeats
const cold: number[] = [], warm: number[] = [], sizes: number[] = [];
for (const b of snap.boards) { const [ms, r] = t(() => boardHtml(snap.doc, snap.path, b.id)); cold.push(ms); sizes.push(r.html.length); }
for (let k = 0; k < 3; k++) for (const b of snap.boards) warm.push(t(() => boardHtml(snap.doc, snap.path, b.id))[0]);
out.boardHtml = { firstCall: stats(cold), warm: stats(warm), htmlBytes: stats(sizes), totalHtmlBytes: sizes.reduce((a, b) => a + b, 0) };
const slow = snap.boards.map((b, i) => ({ id: b.id, name: b.name, ms: round1(warm[i]), htmlBytes: sizes[i] })).sort((a, b) => b.ms - a.ms).slice(0, 5);
out.slowestBoards = slow;
function round1(n: number) { return Math.round(n * 10) / 10; }

// the cost a request pays to find the board: one full loadDoc + (on revision change only) snapshotOf
out.heapRetainedMb = (gcHeap() - heap0) / 1048576;
out.rawStringMb = loaded.raw.length / 1048576;
console.log(JSON.stringify(out));
