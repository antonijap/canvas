// pnpm qa:coverage: which feature x case pairs of the catalog (qa/features.yaml) a scenario covers, per area, from
// the covers lists of the scripted scenarios (qa/scenarios.ts), the generated ones (qa/matrix.ts) and the native ones
// (qa/native/scenarios.ts). With the last runs' results (qa/out/last-run.json, qa/out/matrix-last.json,
// qa/out/native-last.json) a covered pair is "passing" when every
// scenario that covers it passed in its last run, "failing" when one failed, "not run" otherwise.
// Writes qa/out/coverage.json. Exit 1 when a scenario names a pair the catalog does not have.
//
//   pnpm qa:coverage             summary per area, then the pairs nothing covers
//   pnpm qa:coverage --all       also list each covered pair and its scenarios
import fs from "node:fs";
import path from "node:path";
import { checkCovers, loadCatalog } from "./catalog.ts";
import { scenarios, slug } from "./harness.ts";
import { nativeSlug, scenarios as nativeScenarios } from "./native/harness.ts";
import { OUT } from "./runner.ts";

type Run = { results: { slug: string; status: string }[]; filtered?: boolean } | null;
const readRun = (f: string): Run => { try { return JSON.parse(fs.readFileSync(path.join(OUT, f), "utf8")); } catch { return null; } };

export async function coverage() {
  await import("./scenarios.ts");
  await import("./matrix.ts");
  await import("./native/scenarios.ts");
  const cat = loadCatalog();
  const status = new Map<string, string>();
  for (const r of [readRun("last-run.json"), readRun("matrix-last.json"), readRun("native-last.json")]) for (const x of r?.results ?? []) status.set(x.slug, x.status);
  const bad: string[] = [];
  const by = new Map<string, string[]>(); // "feature:case" -> scenario slugs
  const all = [...scenarios.map((s) => ({ ...s, id: slug(s) })), ...nativeScenarios.map((s) => ({ ...s, id: nativeSlug(s) }))];
  for (const s of all) {
    for (const e of checkCovers(cat, s.covers)) bad.push(`${s.kind} ${s.area} / ${s.name}: ${e}`);
    for (const c of s.covers) by.set(c, [...(by.get(c) ?? []), s.id]);
  }
  const areas = new Map<string, { total: number; covered: number; passing: number; missing: string[]; failing: string[] }>();
  const pairs: { pair: string; feature: string; area: string; case: string; dimension: string; scenarios: string[]; state: string }[] = [];
  for (const f of cat.features) {
    const a = areas.get(f.area) ?? { total: 0, covered: 0, passing: 0, missing: [], failing: [] };
    areas.set(f.area, a);
    for (const c of f.cases) {
      const pair = `${f.id}:${c}`;
      const ss = by.get(pair) ?? [];
      const sts = ss.map((s) => status.get(s));
      const state = !ss.length ? "missing" : sts.some((x) => x === "FAIL") ? "failing" : sts.length && sts.every((x) => x === "PASS") ? "passing" : sts.some((x) => x === "PASS") ? "passing" : "not run";
      a.total++;
      if (ss.length) a.covered++;
      if (state === "passing") a.passing++;
      if (state === "missing") a.missing.push(pair);
      if (state === "failing") a.failing.push(pair);
      pairs.push({ pair, feature: f.id, area: f.area, case: c, dimension: cat.dimensionOf(c), scenarios: ss, state });
    }
  }
  return { cat, areas, pairs, bad, scenarios: all.length };
}

async function main() {
  const { cat, areas, pairs, bad, scenarios: n } = await coverage();
  const pct = (a: number, b: number) => (b ? `${((100 * a) / b).toFixed(0)}%` : "-");
  const pad = (s: string, k: number) => (s.length >= k ? s : s + " ".repeat(k - s.length));
  const total = pairs.length, covered = pairs.filter((p) => p.state !== "missing").length, passing = pairs.filter((p) => p.state === "passing").length;
  console.log(`${cat.features.length} features, ${total} feature x case pairs, ${n} scenarios\n`);
  console.log(`${pad("AREA", 12)}  ${pad("PAIRS", 5)}  ${pad("COVERED", 13)}  PASSING`);
  for (const [area, a] of [...areas].sort()) console.log(`${pad(area, 12)}  ${pad(String(a.total), 5)}  ${pad(`${a.covered} (${pct(a.covered, a.total)})`, 13)}  ${a.passing} (${pct(a.passing, a.total)})`);
  console.log(`${pad("all", 12)}  ${pad(String(total), 5)}  ${pad(`${covered} (${pct(covered, total)})`, 13)}  ${passing} (${pct(passing, total)})`);
  const failing = pairs.filter((p) => p.state === "failing");
  if (failing.length) console.log(`\nfailing in the last run: ${failing.map((p) => p.pair).join(", ")}`);
  console.log("\nnot covered:");
  for (const f of cat.features) {
    const miss = pairs.filter((p) => p.feature === f.id && p.state === "missing").map((p) => p.case);
    if (miss.length) console.log(`  ${pad(f.area, 11)} ${f.id}: ${miss.length === f.cases.length ? "nothing" : miss.join(", ")}`);
  }
  if (process.argv.includes("--all")) {
    console.log("\ncovered:");
    for (const p of pairs.filter((x) => x.state !== "missing")) console.log(`  ${p.pair} [${p.state}] ${p.scenarios.slice(0, 3).join(", ")}${p.scenarios.length > 3 ? ` +${p.scenarios.length - 3}` : ""}`);
  }
  fs.mkdirSync(OUT, { recursive: true });
  const out = path.join(OUT, "coverage.json");
  fs.writeFileSync(out, JSON.stringify({ when: new Date().toISOString(), features: cat.features.length, pairs: total, covered, passing, areas: Object.fromEntries(areas), detail: pairs }, null, 1) + "\n");
  console.log(`\nwrote ${path.relative(process.cwd(), out)}`);
  if (bad.length) { console.log(`\nscenarios name pairs the catalog does not have:\n  ${bad.join("\n  ")}`); process.exitCode = 1; }
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
