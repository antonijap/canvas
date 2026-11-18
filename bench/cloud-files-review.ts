// Run with CANVAS_CHECK_ACTIONS=0. Optionally pass a docwriter module path for the main comparison.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { cowDoc } from "../src/docwriter.ts";
import { actionChecks, docEditAction, onAction } from "../src/cloud-files-ops.ts";
import { snapshotOfDoc } from "../src/boards.ts";
import type { CanvasDoc } from "../src/doc/docfile.ts";

actionChecks.enabled = false;
const median = (values: number[]) => values.sort((a, b) => a - b)[Math.floor(values.length / 2)];
async function measure(fn: () => unknown, count: number, warm = 10) {
  for (let i = 0; i < warm; i++) await fn();
  const samples: number[] = [];
  for (let batch = 0; batch < 7; batch++) {
    const start = performance.now();
    for (let i = 0; i < count; i++) await fn();
    samples.push((performance.now() - start) / count);
  }
  return Number(median(samples).toFixed(4));
}
const small = { children: [{ id: "node", type: "rectangle", x: 0 }] };
const tokens = { ...small, variables: Object.fromEntries(Array.from({ length: 100_000 }, (_, i) => [`v${i}`, { type: "number", value: i }])) };
const copySmall = await measure(() => { cowDoc(small, ["node"]).children[0].x = 1; }, 20);
const copyTokens = await measure(() => { cowDoc(tokens, ["node"]).children[0].x = 1; }, 20);
console.log(JSON.stringify({ metric: "cow ms/edit", variables: 100_000, small: copySmall, tokens: copyTokens, added: Number((copyTokens - copySmall).toFixed(4)) }));
const large = (): CanvasDoc => ({ children: [{ id: "board", type: "frame", children: Array.from({ length: 49_999 }, (_, i) => ({ id: `n${i}`, type: "rectangle", x: 0 })) }] });
let doc = large(), x = 0;
const off = onAction(() => {});
const action = await measure(() => {
  const next = { ...doc, children: [{ ...doc.children[0], children: (doc.children[0].children as any[]).slice() }] };
  (next.children[0].children as any[])[0] = { id: "n0", type: "rectangle", x: ++x };
  docEditAction("bench-file", doc, next, [{ t: "node", id: "n0", props: { x: { b: { v: x - 1 }, a: { v: x } } } }]);
  doc = next;
}, 30);
off();
console.log(JSON.stringify({ metric: "observed ms/action including snapshot preparation", nodes: 50_000, ms: action }));
const writer = await import(process.argv[2] ? pathToFileURL(path.resolve(process.argv[2])).href : "../src/docwriter.ts");
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "canvas-edit-bench-"));
const file = path.join(dir, "example.canvas.json");
process.env.CANVAS_STATE_DIR = path.join(dir, "state");
fs.writeFileSync(file, JSON.stringify(large()));
let snapshot = snapshotOfDoc(file, large(), "baseline", { indent: "", trailing: "", mode: 0o644, size: 2_000_000 });
writer.setDocHost({ peek: () => snapshot, get: () => snapshot, adopt: (_: string, next: typeof snapshot) => { snapshot = next; }, ensure: async () => snapshot, markOwn: () => {} });
writer.writeConfig.syncBytes = 0;
writer.writeConfig.debounceMs = 1_000_000;
writer.writeConfig.maxDelayMs = 1_000_000;
try {
  const local = await measure(() => writer.editDoc(file, { touches: ["n0"] }, (d: CanvasDoc) => { (d.children[0].children as any[])[0].x = ++x; }), 50);
  console.log(JSON.stringify({ metric: "local docwriter ms/edit, no Cloud or checks", nodes: 50_000, ms: local }));
} finally {
  await writer.flushWrites(file);
  writer.setDocHost(undefined);
  fs.rmSync(dir, { recursive: true, force: true });
}
