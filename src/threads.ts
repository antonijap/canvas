// Talk to the selection: the threads that live on layers. A thread is the conversation someone had with a local
// agent (Claude Code or Codex) about one selection: the prompts, the steps each run took, its one-line summary, the
// harness and its session id (so a follow-up continues the same conversation). Threads are kept in the document's
// sidecar (widgets.json inside a .canvas, or foo.widgets.json) under the `threads` key, keyed by the selection's first
// layer id, never in the design file. Only the last RUNS_KEPT runs of a layer are kept, and at most THREADS_KEPT threads per
// document. The writes are not undo steps (no `record`): a thread is a log, not part of the design.

import { storeFor, storeForAsync } from "./widgets/store.ts";
import { docFileFor } from "./widgets.ts";

export const RUNS_KEPT = 5;
export const THREADS_KEPT = 200;
export const PROMPT_MAX = 4000;
/** The undo steps a run remembers (its Undo button checks them all; a long run makes many). */
export const SEQS_KEPT = 200;

export type Harness = "claude" | "codex";
export type StepState = "done" | "now" | "next";
export type Step = { label: string; state: StepState };
export type RunStatus = "running" | "done" | "stopped" | "failed";
export type Run = {
  id: string;
  prompt: string;
  at: number;
  endedAt?: number;
  status: RunStatus;
  steps: Step[];
  /** "Changed 6 properties on 4 layers", counted from the run's undo history entries. */
  summary?: string;
  /** What the agent said it changed (its final line, trimmed). */
  detail?: string;
  error?: string;
  /** What the person did with it afterwards. */
  outcome?: "kept" | "undone";
  /** The undo history entries the run made (history.ts seq), newest last. */
  seqs?: number[];
  /** Properties and structure changes it made (the pill's "6 changes"). */
  changes?: number;
};
export type Thread = {
  /** The selection's first layer id: where the thread lives. */
  key: string;
  ids: string[];
  /** The layer's name when the thread was last used (the palette shows the current one when it can). */
  name: string;
  page?: string;
  harness: Harness;
  /** Claude Code's session id or Codex's thread id: a follow-up resumes it. */
  session?: string;
  createdAt: number;
  updatedAt: number;
  runs: Run[];
};

const str = (v: unknown, max: number): string | undefined => (typeof v === "string" ? v.slice(0, max) : undefined);
const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
const STATUSES = new Set(["running", "done", "stopped", "failed"]);

function cleanRun(r: any): Run | null {
  if (!r || typeof r !== "object" || typeof r.id !== "string" || typeof r.prompt !== "string") return null;
  const steps = Array.isArray(r.steps)
    ? r.steps.filter((s: any) => s && typeof s.label === "string").slice(0, 40).map((s: any) => ({ label: s.label.slice(0, 200), state: s.state === "done" || s.state === "now" ? s.state : "next" }) as Step)
    : [];
  return {
    id: r.id.slice(0, 40),
    prompt: r.prompt.slice(0, PROMPT_MAX),
    at: num(r.at) ?? 0,
    ...(num(r.endedAt) !== undefined ? { endedAt: num(r.endedAt) } : {}),
    // A run still marked running in the file was cut off (the server quit): it is stopped now.
    status: STATUSES.has(r.status) && r.status !== "running" ? r.status : "stopped",
    steps,
    ...(str(r.summary, 200) ? { summary: str(r.summary, 200) } : {}),
    ...(str(r.detail, 400) ? { detail: str(r.detail, 400) } : {}),
    ...(str(r.error, 400) ? { error: str(r.error, 400) } : {}),
    ...(r.outcome === "kept" || r.outcome === "undone" ? { outcome: r.outcome } : {}),
    ...(Array.isArray(r.seqs) ? { seqs: r.seqs.filter((n: unknown) => typeof n === "number").slice(-SEQS_KEPT) } : {}),
    ...(num(r.changes) !== undefined ? { changes: num(r.changes) } : {}),
  };
}

function cleanThread(t: any): Thread | null {
  if (!t || typeof t !== "object" || typeof t.key !== "string" || !t.key) return null;
  const runs = (Array.isArray(t.runs) ? t.runs : []).map(cleanRun).filter(Boolean).slice(-RUNS_KEPT) as Run[];
  if (!runs.length) return null;
  const ids = Array.isArray(t.ids) ? t.ids.filter((x: unknown) => typeof x === "string").slice(0, 50) : [t.key];
  return {
    key: t.key.slice(0, 200),
    ids: ids.length ? ids : [t.key],
    name: str(t.name, 200) ?? t.key,
    ...(str(t.page, 40) ? { page: str(t.page, 40) } : {}),
    harness: t.harness === "codex" ? "codex" : "claude",
    ...(str(t.session, 100) ? { session: str(t.session, 100) } : {}),
    createdAt: num(t.createdAt) ?? runs[0].at,
    updatedAt: num(t.updatedAt) ?? runs[runs.length - 1].at,
    runs,
  };
}

/** The threads stored in a sidecar's envelope, cleaned; anything malformed is left out. */
export function cleanThreads(v: unknown): Thread[] {
  if (!Array.isArray(v)) return [];
  const out = new Map<string, Thread>();
  for (const t of v) {
    const c = cleanThread(t);
    if (c) out.set(c.key, c);
  }
  return [...out.values()];
}

/** A thread with one run added or replaced (same id), keeping the last RUNS_KEPT runs. Pure. */
export function withRun(list: Thread[], t: Omit<Thread, "runs" | "createdAt" | "updatedAt">, run: Run, now = Date.now()): Thread[] {
  const out = list.filter((x) => x.key !== t.key);
  const old = list.find((x) => x.key === t.key);
  const runs = (old?.runs ?? []).filter((r) => r.id !== run.id);
  const at = old?.runs.findIndex((r) => r.id === run.id) ?? -1;
  if (at >= 0) runs.splice(at, 0, run);
  else runs.push(run);
  // The old session only carries over on the same harness: Codex cannot resume a Claude Code session, nor the reverse.
  const session = t.session ?? (old && old.harness === t.harness ? old.session : undefined);
  const { session: _drop, ...rest } = t;
  out.push({ ...rest, ...(session ? { session } : {}), createdAt: old?.createdAt ?? now, updatedAt: now, runs: runs.slice(-RUNS_KEPT) });
  // The oldest threads go first when a document holds too many.
  out.sort((a, b) => a.updatedAt - b.updatedAt);
  return out.slice(-THREADS_KEPT);
}

/** One run's outcome changed (Keep, Undo). Pure; the list is unchanged when the run is not there. */
export function withOutcome(list: Thread[], key: string, runId: string, outcome: "kept" | "undone"): Thread[] {
  return list.map((t) => (t.key !== key ? t : { ...t, runs: t.runs.map((r) => (r.id === runId ? { ...r, outcome } : r)) }));
}

export type RecentAsk = { key: string; ids: string[]; run: string; prompt: string; name: string; page: string | null; pageName: string | null; board: string | null; at: number; status: RunStatus; summary?: string };

/**
 * The palette's Recent asks: every thread's newest run, newest first. `nameOf` gives a layer's current name and board
 * (null when the layer is gone: the ask is left out), `pageOf` the page a board is on.
 */
export function recentAsks(list: Thread[], nameOf: (id: string) => { name: string; board: string } | null, pageOf: (board: string) => { id: string; name: string } | null, limit = 20): RecentAsk[] {
  const out: RecentAsk[] = [];
  for (const t of list) {
    const r = t.runs[t.runs.length - 1];
    if (!r) continue;
    const hit = nameOf(t.key);
    if (!hit) continue;
    const pg = pageOf(hit.board);
    out.push({ key: t.key, ids: t.ids, run: r.id, prompt: r.prompt.split("\n")[0].slice(0, 200), name: hit.name || t.name, page: pg?.id ?? t.page ?? null, pageName: pg?.name ?? null, board: hit.board, at: r.endedAt ?? r.at, status: r.status, ...(r.summary ? { summary: r.summary } : {}) });
  }
  out.sort((a, b) => b.at - a.at);
  return out.slice(0, limit);
}

export type Conversation = { key: string; ids: string[]; run: string; prompt: string; name: string; page: string | null; pageName: string | null; board: string | null; at: number; status: RunStatus; running: boolean; gone: boolean; harness: Harness; summary?: string; error?: string };

/**
 * The conversations sidebar: every run of every thread, newest first. `nameOf` gives a layer's current name and board
 * (null when the layer is gone: the row stays, marked gone, under the name it had), `pageOf` the page a board is on,
 * `running` the ids of runs going now (their stored status may be stale).
 */
export function conversations(list: Thread[], nameOf: (id: string) => { name: string; board: string } | null, pageOf: (board: string) => { id: string; name: string } | null, running: Set<string> = new Set(), limit = 200): Conversation[] {
  const out: Conversation[] = [];
  for (const t of list) {
    const hit = nameOf(t.key);
    const pg = hit ? pageOf(hit.board) : null;
    for (const r of t.runs) {
      const live = running.has(r.id);
      out.push({
        key: t.key, ids: t.ids, run: r.id, prompt: r.prompt.split("\n")[0].slice(0, 200), name: hit?.name || t.name, page: pg?.id ?? t.page ?? null, pageName: pg?.name ?? null,
        board: hit?.board ?? null, at: live ? r.at : r.endedAt ?? r.at, status: live ? "running" : r.status, running: live, gone: !hit, harness: t.harness,
        ...(r.summary ? { summary: r.summary } : {}), ...(r.error ? { error: r.error } : {}),
      });
    }
  }
  out.sort((a, b) => b.at - a.at);
  return out.slice(0, limit);
}

// ---------- the sidecar ----------

/** The threads of a document as stored now. */
export async function readThreads(file: string): Promise<Thread[]> {
  const s = await storeForAsync(docFileFor(file));
  return cleanThreads(s.snapshot().extra.threads);
}
/** From memory, without touching the disk (the store keeps the envelope it last read). */
export function threadsNow(file: string): Thread[] {
  try {
    return cleanThreads(storeFor(docFileFor(file)).snapshot().extra.threads);
  } catch {
    return [];
  }
}

/** Change the stored threads under the sidecar's lock. Not an undo step. */
export async function changeThreads(file: string, fn: (list: Thread[]) => Thread[]): Promise<Thread[]> {
  const docFile = docFileFor(file);
  await storeForAsync(docFile);
  const { state } = await storeFor(docFile).mutateEnvelope((widgets, extra) => ({ widgets, extra: { ...extra, threads: fn(cleanThreads(extra.threads)) } }));
  return cleanThreads(state.extra.threads);
}
