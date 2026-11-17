// The pure parts of pnpm qa:swarm (qa/swarm.ts): flags, personas, the plan, the prompts, the findings contract,
// dedupe, ranking, the report and the scenario stubs. No processes, no network, no clock: test/qa-swarm.test.ts.
import type { Feature } from "./catalog.ts";

export const HARNESSES = ["claude", "codex"] as const;
export type HarnessId = (typeof HARNESSES)[number];
export const CLAUDE_MODELS = ["sonnet", "opus"] as const;
export const SEVERITIES = ["critical", "high", "medium", "low"] as const;
export type Severity = (typeof SEVERITIES)[number];
export const MAX_AGENTS = 20;

export type Fixture = "playground" | "big" | "sample";
export type Persona = { id: string; name: string; fixture: Fixture; brief: string; drive: string; covers: string[] };

/** Who the agents pretend to be. `covers`: the catalog cases a stub guesses first for this persona's findings. */
export const PERSONAS: Persona[] = [
  {
    id: "designer", name: "Designer on a big file", fixture: "big", covers: ["large", "5000-boards", "many", "mouse"],
    brief: "You are a product designer who lives in Canvas all day. Your file is big: 300 boards of phone screens. You work fast with the mouse and the common shortcuts, zoom far out and back in, select many layers at once, and undo a lot.",
    drive: "Mostly the page: mouse drags, clicks, scroll to pan, Cmd+scroll to zoom, the shortcuts in the developer guide. Check the file on disk and the picture after each step.",
  },
  {
    id: "keyboard", name: "Keyboard-only user", fixture: "playground", covers: ["keyboard"],
    brief: "You never touch the mouse after the page loads. Everything you do goes through keys: selection keys, nudges, shortcuts, typing into fields, Escape to back out.",
    drive: "The page with `key` and `type` only. One `click` on an empty part of the canvas is allowed to give it focus at the start.",
  },
  {
    id: "agent", name: "Agent-heavy user", fixture: "playground", covers: ["agent", "mcp"],
    brief: "You let AI agents do most of the editing. You drive Canvas through its MCP tools (and the HTTP API they use), then check what the person watching the page sees, mix in a few edits by hand, and undo across both.",
    drive: "The canvas MCP tools first (the server is attached as `canvas`), the HTTP API second, the page to look at the result and to interleave a hand edit.",
  },
  {
    id: "newcomer", name: "First-time user", fixture: "sample", covers: ["mouse", "one", "tiny"],
    brief: "You opened Canvas for the first time a minute ago, from the README. You try the obvious things, click what looks clickable, misread labels, press the wrong key, and judge every message, empty state and error by whether it tells you what to do next.",
    drive: "The page with the mouse, the way someone new would. Read README.md first, like a newcomer would.",
  },
  {
    id: "a11y", name: "Accessibility user", fixture: "playground", covers: ["keyboard", "dark", "light"],
    brief: "You rely on the keyboard and a screen reader, use the dark theme and need clear focus. You check that controls have names and roles, that focus is visible and lands somewhere sensible, that nothing needs a hover or a drag to reach, and that text has enough contrast.",
    drive: "The page with keys; `eval` to read roles, aria labels, focus (document.activeElement) and computed colours. Reduced Motion is already on.",
  },
];

// ---------------------------------------------------------------- flags

export type SwarmOpts = {
  go: boolean; dryRun: boolean; agents: number; area: string | null; persona: string | null;
  harness: HarnessId | "mix"; minutes: number; verifyMinutes: number; budgetUsd: number;
  claudeModel: (typeof CLAUDE_MODELS)[number]; codexModel: string | null; help: boolean;
};

export const USAGE = `pnpm qa:swarm [flags]

Starts exploratory QA agents (Claude Code and Codex) against scratch Canvas servers. Without --go it only
prints the plan and the exact prompts and spawns nothing, so a bare run spends no tokens.

  --go                   really spawn the agents (without it: dry run)
  --dry-run              print the plan and prompts only (the default; wins over --go)
  --agents N             how many finder agents (default 10, at most ${MAX_AGENTS})
  --area <area>          only this catalog area (qa/features.yaml)
  --persona <id>         only this persona: ${PERSONAS.map((p) => p.id).join(", ")}
  --harness <h>          claude, codex or mix (default mix: alternate)
  --minutes M            wall-clock time box per finder (default 20); the process is killed after it
  --verify-minutes M     time box per verifier (default the smaller of M and 10)
  --budget-usd D         Claude spend cap per finder (default 3; verifiers get half). Codex has no cap but the time box
  --claude-model <m>     sonnet or opus (default sonnet)
  --codex-model <m>      Codex model (default: Codex's own)
`;

export function parseSwarmArgs(argv: string[]): SwarmOpts {
  const o: SwarmOpts = { go: false, dryRun: false, agents: 10, area: null, persona: null, harness: "mix", minutes: 20, verifyMinutes: NaN, budgetUsd: 3, claudeModel: "sonnet", codexModel: null, help: false };
  const val = (i: number, flag: string) => {
    const v = argv[i + 1];
    if (v === undefined || v.startsWith("--")) throw new Error(`${flag} needs a value`);
    return v;
  };
  const num = (v: string, flag: string, min: number, max = Infinity) => {
    const n = Number(v);
    if (!Number.isFinite(n) || n < min || n > max) throw new Error(`${flag}: want a number from ${min}${max < Infinity ? ` to ${max}` : ""}, got ${v}`);
    return n;
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case "--go": o.go = true; break;
      case "--dry-run": o.dryRun = true; break;
      case "--help": case "-h": o.help = true; break;
      case "--agents": o.agents = num(val(i, a), a, 1, MAX_AGENTS); if (!Number.isInteger(o.agents)) throw new Error("--agents: want a whole number"); i++; break;
      case "--area": o.area = val(i, a); i++; break;
      case "--persona": o.persona = val(i, a); i++; break;
      case "--harness": {
        const h = val(i, a);
        if (h !== "mix" && !(HARNESSES as readonly string[]).includes(h)) throw new Error(`--harness: want claude, codex or mix, got ${h}`);
        o.harness = h as SwarmOpts["harness"]; i++; break;
      }
      case "--minutes": o.minutes = num(val(i, a), a, 1, 240); i++; break;
      case "--verify-minutes": o.verifyMinutes = num(val(i, a), a, 1, 240); i++; break;
      case "--budget-usd": o.budgetUsd = num(val(i, a), a, 0.1, 100); i++; break;
      case "--claude-model": {
        const m = val(i, a);
        if (!(CLAUDE_MODELS as readonly string[]).includes(m)) throw new Error(`--claude-model: want ${CLAUDE_MODELS.join(" or ")}, got ${m}`);
        o.claudeModel = m as SwarmOpts["claudeModel"]; i++; break;
      }
      case "--codex-model": o.codexModel = val(i, a); i++; break;
      default: throw new Error(`unknown flag ${a}\n\n${USAGE}`);
    }
  }
  if (o.persona && !PERSONAS.some((p) => p.id === o.persona)) throw new Error(`--persona: want one of ${PERSONAS.map((p) => p.id).join(", ")}, got ${o.persona}`);
  if (Number.isNaN(o.verifyMinutes)) o.verifyMinutes = Math.min(o.minutes, 10);
  // A dry run is the default: only --go without --dry-run spawns anything.
  if (o.dryRun) o.go = false;
  return o;
}

// ---------------------------------------------------------------- plan

export type AgentPlan = {
  id: string; index: number; persona: Persona; area: string; features: Feature[];
  harness: HarnessId; model: string | null; minutes: number; budgetUsd: number | null;
};

export const areasOf = (features: Feature[]) => [...new Set(features.map((f) => f.area))];
export const modelFor = (h: HarnessId, o: Pick<SwarmOpts, "claudeModel" | "codexModel">) => (h === "claude" ? o.claudeModel : o.codexModel);
export const otherHarness = (h: HarnessId, mode: SwarmOpts["harness"]): HarnessId => (mode === "mix" ? (h === "claude" ? "codex" : "claude") : h);

/** Persona x area pairs, spread so that the first agents cover every area once and the personas take turns. */
export function buildPlan(o: SwarmOpts, features: Feature[]): AgentPlan[] {
  const areas = areasOf(features).filter((a) => !o.area || a === o.area);
  if (!areas.length) throw new Error(`--area: no area "${o.area}" in qa/features.yaml (areas: ${areasOf(features).join(", ")})`);
  const personas = PERSONAS.filter((p) => !o.persona || p.id === o.persona);
  const pairs: [Persona, string][] = [];
  const seen = new Set<string>();
  const total = areas.length * personas.length;
  for (let k = 0; pairs.length < Math.min(o.agents, total) && k < total * personas.length * 2; k++) {
    const area = areas[k % areas.length];
    const persona = personas[(k + Math.floor(k / areas.length)) % personas.length];
    const key = `${persona.id}/${area}`;
    if (seen.has(key)) continue;
    seen.add(key);
    pairs.push([persona, area]);
  }
  // More agents than pairs: the pairs again, in the same order (each on its own server, another harness when mixed).
  for (let k = 0; pairs.length < o.agents; k++) pairs.push(pairs[k]);
  return pairs.map(([persona, area], i) => {
    const harness: HarnessId = o.harness === "mix" ? HARNESSES[i % 2] : o.harness;
    return {
      id: `a${String(i + 1).padStart(2, "0")}-${persona.id}-${area}`, index: i, persona, area,
      features: features.filter((f) => f.area === area), harness, model: modelFor(harness, o),
      minutes: o.minutes, budgetUsd: harness === "claude" ? o.budgetUsd : null,
    };
  });
}

// ---------------------------------------------------------------- prompts

/** Where one agent's Canvas runs. The dry run prints placeholders for what only exists once spawned. */
export type Runtime = { repo: string; dir: string; file: string; base: string; tool: string; evidence: string; serverLog: string; deadline: string; mcp: boolean };

export function placeholderRuntime(repo: string, dir: string, fixtureName: string): Runtime {
  return { repo, dir, file: `${dir}/${fixtureName}`, base: "http://127.0.0.1:<server-port>", tool: `${dir}/canvas`, evidence: `${dir}/evidence`, serverLog: `${dir}/server.log`, deadline: "<start + minutes>", mcp: true };
}

export const FIXTURE_NAMES: Record<Fixture, string> = { playground: "Playground.canvas", big: "Big.canvas", sample: "Sample.canvas" };
const FIXTURE_TEXT: Record<Fixture, string> = {
  playground: "a copy of demos/playground.canvas: one board per feature on four pages (Layout, Components, Style, Cards); layer ids are fixed and listed in qa/playground.ts",
  big: "a generated file of 300 phone-screen boards with auto layout rows, text, a component and its instances (ids board0..board299, children b<N>t, b<N>h, b<N>r<K>...)",
  sample: "a copy of demos/learn.canvas, the course file the first launch opens",
};

const FINDING_FIELDS = `{"title": "...", "area": "<catalog area>", "feature": "<catalog feature id>", "case": "<optional catalog case>", "steps": ["exact step 1", "exact step 2"], "expected": "...", "actual": "...", "severity": "critical|high|medium|low", "evidence": "<file name in the evidence folder, optional>"}`;

const SEVERITY_TEXT = `Severity: critical = data loss, a corrupt or unopenable file, a crash or hang; high = a feature does the wrong thing with no workaround, or undo does not restore; medium = wrong but recoverable, a wrong picture, a misleading message; low = cosmetic or wording.`;

function toolHelp(rt: Runtime): string {
  return [
    `Below, \`canvas\` stands for \`${rt.tool}\`: always run it by that full path.`,
    "",
    "- `canvas help`: every command",
    "- `canvas info`: renderer, active page, pages, selection, camera",
    "- `canvas eval '<js>'`: run JavaScript in the page, print the JSON result",
    "- `canvas click X Y [meta shift alt ctrl]`, `dblclick X Y [...]`, `drag X0 Y0 X1 Y1 [...]`, `move X Y`, `scroll X Y DX DY [...]`",
    "- `canvas key <key> [meta shift alt ctrl]` (Enter, Escape, Tab, Backspace, ArrowLeft, a, 1, ...), `canvas type '<text>'`",
    "- `canvas rect <layer-id>`: where a layer is drawn, in window px (use it before clicking a layer)",
    "- `canvas shot <name>`: screenshot into the evidence folder",
    "- `canvas errors`: page exceptions and console errors since the page loaded",
    "- `canvas reload`, `canvas settle`: reload the page, wait for the engine to finish drawing",
    "- `canvas finding '<json>'`: record one finding (checked against the contract; fix it if it is refused)",
    "- `canvas verdict '<json>'`: record a verifier's verdict",
    "- `canvas time`: minutes left in your time box",
  ].join("\n");
}

function catalogLines(features: Feature[], gaps: Map<string, string[]>): string {
  return features.map((f) => {
    const g = gaps.get(f.id);
    return `- \`${f.id}\`: ${f.name}. Driven by ${f.driven.join(", ")}. Cases: ${f.cases.join(", ")}.${g?.length ? ` No test yet for: ${g.join(", ")}.` : ""}`;
  }).join("\n");
}

function driveSection(rt: Runtime): string {
  return `## How to drive Canvas

The page is already open in a headless Chrome at 1600 x 1000 with your file. Drive it with real mouse and key events through this command (run it from the shell; every call is a new process, the page stays):

${toolHelp(rt)}

Page state from \`eval\`: \`window.canvasHost.selection()\`, \`.setSelection([ids])\`, \`.page\`, \`.pages\`, \`.cam\`, \`.setCam({x, y, z})\`, \`.worldRectOf(id)\`, \`.pageOfBoard(id)\`; \`window.__canvas.renderer\`, \`.settled()\`. qa/harness.ts shows how the QA suite uses them.

HTTP API (the server behind the page and the MCP tools): \`curl -s -H 'x-canvas: 1' '${rt.base}/api/<route>?file=${encodeURIComponent(rt.file)}'\`. Writes are POST with a JSON body and the same header. The routes are in src/server.ts; GET /api/doc returns the document. The file on disk is ${rt.file}/document.json (pages and cards in widgets.json): read it to check what was saved, after \`curl -s -X POST -H 'x-canvas: 1' -H 'content-type: application/json' -d '{"file":"${rt.file}"}' ${rt.base}/api/flush\`.
${rt.mcp ? `
MCP: the Canvas MCP server is attached as \`canvas\` and talks to this server and page (get_selection, set_node_props, add_nodes, undo, render_node, screenshot_view, ...). The tool list and tiers are in docs/developer-guide.md under "Tools". \`launch_canvas\` and \`open_file\` of other files are off limits.
` : ""}
Server output: ${rt.serverLog}. What Canvas should do: ${rt.repo}/docs/developer-guide.md (shortcuts, tools, variations, settings), ${rt.repo}/README.md and the source in ${rt.repo}/src. In-app agent runs (Spark, Make variations) are switched off on this server: they report that no agent is installed.`;
}

function rulesSection(rt: Runtime): string {
  return `## Rules

- Work only on ${rt.file}, through ${rt.base}, the page and the MCP tools. Write files only inside ${rt.dir}.
- Never open, read or write anything under ~/Desktop or ~/Documents, and never edit the repository at ${rt.repo} (reading it is fine).
- Do not start servers, browsers or apps, and do not kill processes: everything you need is running.
- No network beyond 127.0.0.1.
- Your time box ends at ${rt.deadline}; then the process is killed. Record each finding with \`finding\` as soon as you are sure of it, so nothing is lost.`;
}

export function renderFinderPrompt(p: AgentPlan, rt: Runtime, gaps: Map<string, string[]> = new Map()): string {
  return `You are an exploratory QA tester for Canvas, a macOS design tool for designing with LLMs (a Node server, a Rust/WASM renderer in the page, Canvas MCP for agents). It goes open source soon, and nothing a new user tries should embarrass it. Your job: find real, reproducible bugs in one feature area, the way your persona would hit them.

## Persona: ${p.persona.name}

${p.persona.brief}

How you drive it: ${p.persona.drive}

## Your area: ${p.area}

Your file is ${FIXTURE_TEXT[p.persona.fixture]}. These catalog entries (qa/features.yaml) are your area; the cases are what each feature must survive:

${catalogLines(p.features, gaps)}

Try what a scripted test would not: odd orders (undo after switching pages, edit while a drag's write is in flight, the same edit from the page and from MCP), edges (empty selection, hidden or rotated layers, things inside instances or auto layout), repeats, and the picture after each step. Compare what you see with the file on disk and with what the docs promise.

${driveSection(rt)}

${rulesSection(rt)}

## What counts as a finding

A defect you saw happen and can make happen again from a fresh copy of the same file: wrong file contents, wrong picture, a lost or extra undo step, an error in the console or the server output, a hang, a misleading message, a control that cannot be reached. Not taste or wishes. Read the docs before calling something wrong.

Each finding is one JSON object:

${FINDING_FIELDS}

- steps: exact and replayable on a fresh copy, from the page as it opens. Name layers by id, give tool commands, curl calls or MCP calls with their arguments; give window coordinates only after a step that puts the camera somewhere known (\`eval 'window.canvasHost.setCam(...)'\` or a key such as Shift+1). Write \`<base>\` for ${rt.base} and \`<file>\` for the file's path: whoever replays the steps has their own.
- feature must be one of the ids above (or another id from qa/features.yaml if the bug is really there); case, when given, one of that feature's cases.
- ${SEVERITY_TEXT}
- evidence: a \`shot\` name, or a file you wrote into ${rt.evidence}.

Record each one with \`${rt.tool} finding '<json>'\`. When you are done or nearly out of time, end with a final message that lists every finding again, one JSON object per line, between a line FINDINGS and a line END_FINDINGS (or the single line NO_FINDINGS). Quality over count: three solid findings beat ten guesses.
`;
}

export function renderVerifierPrompt(f: Finding, rt: Runtime, minutes: number): string {
  return `You are a skeptical QA verifier for Canvas, a macOS design tool for designing with LLMs (a Node server, a Rust/WASM renderer in the page, Canvas MCP for agents). Another tester reported the bug below. Your job is to try to disprove it: replay the steps exactly on a fresh copy of the same file and decide whether the actual result happens. Do not explore other bugs.

## The report

Title: ${f.title}
Feature: ${f.feature}${f.case ? ` (case ${f.case})` : ""}, area ${f.area}, severity ${f.severity}
Steps:
${f.steps.map((s, i) => `${i + 1}. ${s}`).join("\n")}
Expected: ${f.expected}
Actual (reported): ${f.actual}

In the steps, \`<base>\` is ${rt.base}, \`<file>\` is ${rt.file}, \`<file-url>\` is that path URL-encoded, \`<dir>\` is ${rt.dir} and \`canvas\` is ${rt.tool}.

${driveSection(rt)}

${rulesSection(rt)}

## Your answer

Replay the steps up to three times. Steps that are vague count against the report: replay them the most literal way. If the reported behaviour happens, it is CONFIRMED; if it does not, or it is what the docs say Canvas should do, it is NOT_REPRODUCED. You have ${minutes} minutes.

Record your verdict with \`${rt.tool} verdict '{"verdict": "CONFIRMED" or "NOT_REPRODUCED", "evidence": "<shot name or file in ${rt.evidence}, optional>", "notes": "what you did and saw, two or three sentences"}'\`, and end with the same JSON object as the last line of your final message.
`;
}

// ---------------------------------------------------------------- findings

export type Finding = { title: string; area: string; feature: string; case?: string; steps: string[]; expected: string; actual: string; severity: Severity; evidence?: string };
export type CatalogLike = { byId: Map<string, Feature> };

const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");

/** One finding from a parsed object, checked against the contract (and the catalog when given). */
export function checkFinding(o: unknown, cat?: CatalogLike): { ok: true; finding: Finding } | { ok: false; error: string } {
  if (!o || typeof o !== "object" || Array.isArray(o)) return { ok: false, error: "want a JSON object" };
  const x = o as Record<string, unknown>;
  const errs: string[] = [];
  for (const k of ["title", "area", "feature", "expected", "actual"]) if (!str(x[k])) errs.push(`${k} is required`);
  const steps = Array.isArray(x.steps) ? x.steps.map(str).filter(Boolean) : typeof x.steps === "string" ? x.steps.split("\n").map((s) => s.replace(/^\s*\d+[.)]\s*/, "").trim()).filter(Boolean) : [];
  if (!steps.length) errs.push("steps: want a non-empty list of exact steps");
  const severity = str(x.severity).toLowerCase();
  if (!(SEVERITIES as readonly string[]).includes(severity)) errs.push(`severity: want ${SEVERITIES.join(", ")}`);
  const feature = str(x.feature), kase = str(x.case);
  if (cat && feature) {
    const f = cat.byId.get(feature);
    if (!f) errs.push(`feature "${feature}" is not in qa/features.yaml`);
    else if (kase && !f.cases.includes(kase)) errs.push(`case "${kase}" is not a case of ${feature} (${f.cases.join(", ")})`);
  }
  if (errs.length) return { ok: false, error: errs.join("; ") };
  const finding: Finding = { title: str(x.title), area: str(x.area), feature, steps, expected: str(x.expected), actual: str(x.actual), severity: severity as Severity };
  if (kase) finding.case = kase;
  if (str(x.evidence)) finding.evidence = str(x.evidence);
  return { ok: true, finding };
}

export function parseFindingLine(line: string, cat?: CatalogLike) {
  let o: unknown;
  try { o = JSON.parse(line); } catch (e) { return { ok: false as const, error: `not JSON: ${(e as Error).message}` }; }
  return checkFinding(o, cat);
}

/** Findings in an agent's output: every line that is a JSON object with a title (the findings file, or the final
 *  message, where they sit between FINDINGS and END_FINDINGS, possibly in a code fence). */
export function parseFindings(text: string, cat?: CatalogLike): { findings: Finding[]; errors: string[] } {
  const findings: Finding[] = [], errors: string[] = [];
  for (const raw of text.split("\n")) {
    const line = raw.trim().replace(/^[-*]\s+/, "");
    if (!line.startsWith("{") || !line.includes('"title"')) continue;
    const r = parseFindingLine(line, cat);
    if (r.ok) findings.push(r.finding);
    else errors.push(`${r.error}: ${line.slice(0, 160)}`);
  }
  return { findings, errors };
}

/** A finding with its agent's scratch server, file and folder written as <base>, <file>, <file-url> and <dir>, so its
 *  steps replay on any other scratch copy (the verifier's, a scenario's). */
export function scrubFinding<F extends Finding>(f: F, where: { base: string; file: string; dir: string }): F {
  const pairs: [string, string][] = [[where.base, "<base>"], [encodeURIComponent(where.file), "<file-url>"], [where.file, "<file>"], [where.dir, "<dir>"]];
  // The temp folder also shows up under its real path (/private/var/... for /var/... on macOS).
  for (const [from, to] of [...pairs]) if (from.startsWith("/var/")) pairs.push([`/private${from}`, to]);
  pairs.sort((a, b) => b[0].length - a[0].length);
  const s = (x: string) => pairs.reduce((acc, [from, to]) => (from ? acc.split(from).join(to) : acc), x);
  return { ...f, title: s(f.title), steps: f.steps.map(s), expected: s(f.expected), actual: s(f.actual) };
}

export type Verdict ={ verdict: "CONFIRMED" | "NOT_REPRODUCED"; evidence?: string; notes: string };

export function checkVerdict(o: unknown): Verdict | null {
  if (!o || typeof o !== "object") return null;
  const x = o as Record<string, unknown>;
  const v = str(x.verdict).toUpperCase();
  if (v !== "CONFIRMED" && v !== "NOT_REPRODUCED") return null;
  return { verdict: v, notes: str(x.notes), ...(str(x.evidence) ? { evidence: str(x.evidence) } : {}) };
}

/** The last verdict object in a verifier's output. */
export function parseVerdict(text: string): Verdict | null {
  let last: Verdict | null = null;
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line.startsWith("{") || !line.includes("verdict")) continue;
    try { last = checkVerdict(JSON.parse(line)) ?? last; } catch {}
  }
  return last;
}

// ---------------------------------------------------------------- dedupe and rank

export type Tagged = Finding & { agent: string; harness: HarnessId; persona: string; fixture: Fixture };
export type Group = { key: string; finding: Tagged; all: Tagged[]; verdict?: Verdict & { by: HarnessId; agent: string } ; verifyError?: string };

const STOP = new Set(["a", "an", "the", "is", "are", "was", "be", "it", "its", "of", "on", "in", "to", "and", "or", "with", "when", "after", "while", "for", "from", "by", "at", "does", "do", "not", "no", "but", "then", "this", "that"]);

/** A title reduced to its words: lower case, no punctuation or filler words, sorted, so rewordings match. */
export function normalizeTitle(s: string): string {
  const words = s.toLowerCase().replace(/[^a-z0-9+]+/g, " ").split(" ").filter((w) => w && !STOP.has(w));
  return [...new Set(words)].sort().join(" ");
}

export const sevRank = (s: Severity) => SEVERITIES.indexOf(s);

/** Findings with the same feature and normalized title are one; the most severe report speaks for the group. */
export function dedupe(fs: Tagged[]): Group[] {
  const by = new Map<string, Group>();
  for (const f of fs) {
    const key = `${f.feature}|${normalizeTitle(f.title)}`;
    const g = by.get(key);
    if (!g) { by.set(key, { key, finding: f, all: [f] }); continue; }
    g.all.push(f);
    if (sevRank(f.severity) < sevRank(g.finding.severity)) g.finding = f;
  }
  return [...by.values()];
}

const verdictRank = (g: Group) => (g.verdict?.verdict === "CONFIRMED" ? 0 : g.verdict ? 2 : 1);

/** Most severe first; then confirmed before unverified before not reproduced; then the most reporters. */
export function rank(gs: Group[]): Group[] {
  return [...gs].sort((a, b) => sevRank(a.finding.severity) - sevRank(b.finding.severity) || verdictRank(a) - verdictRank(b) || b.all.length - a.all.length || a.finding.title.localeCompare(b.finding.title));
}

// ---------------------------------------------------------------- report and stubs

export type AgentRun = { id: string; role: "finder" | "verifier"; persona: string; area: string; harness: HarnessId; model: string | null; exit: number | null; timedOut: boolean; ms: number; costUsd: number | null; tokens: number | null; findings: number; error?: string };

const oneLine = (s: string) => s.replace(/\s+/g, " ").trim();

function groupBlock(g: Group, n: number): string {
  const f = g.finding;
  const others = [...new Set(g.all.map((x) => x.agent))].filter((a) => a !== f.agent);
  return [
    `### ${n}. [${f.severity}] ${oneLine(f.title)}`,
    "",
    `- Feature: \`${f.feature}\`${f.case ? ` (case ${f.case})` : ""}, area ${f.area}`,
    `- Found by: ${f.agent} (${f.harness}, ${f.persona})${others.length ? `; also ${others.join(", ")}` : ""}`,
    g.verdict ? `- Verifier (${g.verdict.by}, ${g.verdict.agent}): ${g.verdict.verdict}. ${oneLine(g.verdict.notes)}${g.verdict.evidence ? ` Evidence: ${g.verdict.evidence}` : ""}` : `- Verifier: no verdict${g.verifyError ? ` (${oneLine(g.verifyError)})` : ""}`,
    "- Steps:",
    ...f.steps.map((s, i) => `  ${i + 1}. ${oneLine(s)}`),
    `- Expected: ${oneLine(f.expected)}`,
    `- Actual: ${oneLine(f.actual)}`,
    ...(f.evidence ? [`- Evidence: ${f.evidence}`] : []),
    "",
  ].join("\n");
}

export function renderReport(r: { stamp: string; opts: SwarmOpts; groups: Group[]; rejected: string[]; runs: AgentRun[]; rawCount: number }): string {
  const gs = rank(r.groups);
  const confirmed = gs.filter((g) => g.verdict?.verdict === "CONFIRMED");
  const unverified = gs.filter((g) => !g.verdict);
  const notRepro = gs.filter((g) => g.verdict?.verdict === "NOT_REPRODUCED");
  const finders = r.runs.filter((x) => x.role === "finder");
  const cost = r.runs.reduce((a, x) => a + (x.costUsd ?? 0), 0);
  const tokens = r.runs.reduce((a, x) => a + (x.tokens ?? 0), 0);
  const out = [
    `# Swarm report ${r.stamp}`,
    "",
    `${finders.length} finders (harness ${r.opts.harness}, ${r.opts.minutes} min each${r.opts.area ? `, area ${r.opts.area}` : ""}${r.opts.persona ? `, persona ${r.opts.persona}` : ""}), ${r.runs.length - finders.length} verifiers (${r.opts.verifyMinutes} min each).`,
    `${r.rawCount} findings reported, ${gs.length} after dedupe: ${confirmed.length} confirmed, ${notRepro.length} not reproduced, ${unverified.length} without a verdict. ${r.rejected.length} lines refused by the contract.`,
    `Claude spend: $${cost.toFixed(2)}. Codex tokens: ${tokens ? tokens.toLocaleString("en-US") : "n/a"}.`,
    "",
    "## Confirmed",
    "",
    ...(confirmed.length ? confirmed.map((g, i) => groupBlock(g, i + 1)) : ["None.", ""]),
    "## Without a verdict",
    "",
    ...(unverified.length ? unverified.map((g, i) => groupBlock(g, i + 1)) : ["None.", ""]),
    "## Not reproduced",
    "",
    ...(notRepro.length ? notRepro.map((g) => `- [${g.finding.severity}] ${oneLine(g.finding.title)} (\`${g.finding.feature}\`, ${g.finding.agent}): ${oneLine(g.verdict!.notes)}`) : ["None."]),
    "",
  ];
  if (r.rejected.length) out.push("## Refused lines", "", ...r.rejected.map((x) => `- ${oneLine(x)}`), "");
  out.push(
    "## Agents",
    "",
    "| Agent | Role | Persona | Area | Harness | Exit | Time | Cost | Findings |",
    "|---|---|---|---|---|---|---|---|---|",
    ...r.runs.map((x) => `| ${x.id} | ${x.role} | ${x.persona} | ${x.area} | ${x.harness}${x.model ? ` (${x.model})` : ""} | ${x.timedOut ? "time box" : x.exit ?? "?"}${x.error ? `: ${oneLine(x.error).slice(0, 80)}` : ""} | ${(x.ms / 60000).toFixed(1)} min | ${x.costUsd != null ? `$${x.costUsd.toFixed(2)}` : x.tokens != null ? `${x.tokens.toLocaleString("en-US")} tok` : "n/a"} | ${x.findings} |`),
    "",
  );
  return out.join("\n");
}

/** The catalog pair a stub covers: the finding's case, else the first of the persona's cases the feature has. */
export function guessCover(f: Tagged, cat: CatalogLike): { pair: string; guessed: boolean } {
  const feat = cat.byId.get(f.feature);
  if (!feat) return { pair: `${f.feature}:${f.case ?? "TODO"}`, guessed: true };
  if (f.case && feat.cases.includes(f.case)) return { pair: `${f.feature}:${f.case}`, guessed: false };
  const prefs = PERSONAS.find((p) => p.id === f.persona)?.covers ?? [];
  const c = prefs.find((x) => feat.cases.includes(x)) ?? feat.cases[0];
  return { pair: `${f.feature}:${c}`, guessed: true };
}

/** qa/scenarios.ts-shaped stubs, one per confirmed finding, that skip until someone writes the steps. */
export function renderScenarioStubs(stamp: string, groups: Group[], cat: CatalogLike): string {
  const confirmed = rank(groups).filter((g) => g.verdict?.verdict === "CONFIRMED");
  const head = [
    `// Scenario stubs from swarm run ${stamp}: one per confirmed finding, most severe first.`,
    "// Paste each sc(...) block into qa/scenarios.ts, write the steps with t.io, t.a and t.ev, assert the expected",
    "// state in place of the skip, and watch it fail before fixing the bug.",
    'import { sc, type T } from "../../../harness.ts";',
    "",
  ];
  if (!confirmed.length) return [...head, "// No confirmed findings in this run.", ""].join("\n");
  const blocks = confirmed.map((g) => {
    const f = g.finding;
    const { pair, guessed } = guessCover(f, cat);
    return [
      `sc(${JSON.stringify(f.area)}, ${JSON.stringify(oneLine(f.title))}, { covers: [${JSON.stringify(pair)}] }, async (t: T) => {`,
      `  // [${f.severity}] found by ${f.agent} (${f.harness}, ${f.persona}), confirmed by ${g.verdict!.by}.${guessed ? " The covers pair is a guess: check it." : ""}`,
      "  // Steps:",
      ...f.steps.map((s, i) => `  //   ${i + 1}. ${oneLine(s)}`),
      `  // Expected: ${oneLine(f.expected)}`,
      `  // Actual: ${oneLine(f.actual)}`,
      `  t.skip(${JSON.stringify(`swarm stub, not written yet: ${oneLine(f.title)}`)});`,
      "});",
      "",
    ].join("\n");
  });
  return [...head, ...blocks].join("\n");
}
