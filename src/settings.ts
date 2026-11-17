// The app's settings the server needs (Canvas > Settings > Agents, apps/macos/SettingsLogic.swift): which local agent
// talk-to-the-selection runs first and how long a run may take. The shell sends them with its state
// (POST /api/state, src/bridge.ts); without the app (a browser) the defaults hold.

import { setCloudConfig } from "./cloud-config.ts";
import type { Harness } from "./threads.ts";

/**
 * model / effort per agent: the model and the reasoning level each run asks for (Settings > Agents). Empty: the
 * agent's own default. Model ids are free-form (an alias like "opus" or a full name) but only letters, digits and
 * . _ : - so nothing else reaches the command line.
 */
export type ModelChoice = { model: string; effort: string };
export type AgentSettings = { harness: Harness; runCapMin: number; claude: ModelChoice; codex: ModelChoice; commentName: string };
export const RUN_CAP_MIN = { min: 1, max: 60, default: 10 };
export const EFFORTS: Record<Harness, string[]> = {
  claude: ["low", "medium", "high", "xhigh", "max"],
  codex: ["minimal", "low", "medium", "high", "xhigh", "max", "ultra"],
};
const NO_CHOICE: ModelChoice = { model: "", effort: "" };
export const DEFAULT_SETTINGS: AgentSettings = { harness: "claude", runCapMin: RUN_CAP_MIN.default, claude: NO_CHOICE, codex: NO_CHOICE, commentName: "" };

/** A model and reasoning level as the shell sent them, made safe: anything unexpected is the agent's default. */
export function cleanChoice(raw: unknown, h: Harness): ModelChoice {
  const o = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const model = typeof o.model === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/.test(o.model) ? o.model : "";
  const effort = typeof o.effort === "string" && EFFORTS[h].includes(o.effort) ? o.effort : "";
  return { model, effort };
}

/** "Your name in comments" (Settings > General): plain text, no control characters, at most 60 characters. */
export function cleanName(raw: unknown): string {
  return typeof raw === "string" ? raw.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, 60) : "";
}

let current: AgentSettings = { ...DEFAULT_SETTINGS };

/** Whatever the shell sent, made safe: unknown harnesses and out-of-range caps fall back to the defaults. */
export function cleanSettings(raw: unknown): AgentSettings {
  const o = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const harness: Harness = o.harness === "codex" ? "codex" : "claude";
  const n = Number(o.runCapMin);
  const runCapMin = Number.isFinite(n) ? Math.min(RUN_CAP_MIN.max, Math.max(RUN_CAP_MIN.min, Math.round(n))) : RUN_CAP_MIN.default;
  return { harness, runCapMin, claude: cleanChoice(o.claude, "claude"), codex: cleanChoice(o.codex, "codex"), commentName: cleanName(o.commentName) };
}

export function setAgentSettings(raw: unknown): void {
  current = cleanSettings(raw);
  setCloudConfig(raw);
}
export const agentSettings = (): AgentSettings => current;
/** The run time cap in ms. */
export const runCapMs = (): number => current.runCapMin * 60_000;
