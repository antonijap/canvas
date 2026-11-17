// The app's settings the server needs (Canvas > Settings > Agents, apps/macos/SettingsLogic.swift): which local agent
// talk-to-the-selection runs first and how long a run may take. The shell sends them with its state
// (POST /api/state, src/bridge.ts); without the app (a browser) the defaults hold.

import type { Harness } from "./threads.ts";

export type AgentSettings = { harness: Harness; runCapMin: number };
export const RUN_CAP_MIN = { min: 1, max: 60, default: 10 };
export const DEFAULT_SETTINGS: AgentSettings = { harness: "claude", runCapMin: RUN_CAP_MIN.default };

let current: AgentSettings = { ...DEFAULT_SETTINGS };

/** Whatever the shell sent, made safe: unknown harnesses and out-of-range caps fall back to the defaults. */
export function cleanSettings(raw: unknown): AgentSettings {
  const o = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const harness: Harness = o.harness === "codex" ? "codex" : "claude";
  const n = Number(o.runCapMin);
  const runCapMin = Number.isFinite(n) ? Math.min(RUN_CAP_MIN.max, Math.max(RUN_CAP_MIN.min, Math.round(n))) : RUN_CAP_MIN.default;
  return { harness, runCapMin };
}

export function setAgentSettings(raw: unknown): void {
  current = cleanSettings(raw);
}
export const agentSettings = (): AgentSettings => current;
/** The run time cap in ms. */
export const runCapMs = (): number => current.runCapMin * 60_000;
