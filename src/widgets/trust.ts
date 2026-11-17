// Which origins may receive which secret. A secret is only sent where the user has said so; the
// two PostHog cloud origins are approved from the start. The file sits next to Canvas's other
// app data and holds origins only, never values.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { SecretRef } from "./types.ts";

const file = () => process.env.CANVAS_TRUST_FILE || path.join(os.homedir(), "Library", "Application Support", "Canvas", "widget-trust.json");
const keyOf = (r: SecretRef) => `${r.service}\0${r.account}`;

function builtin(): Set<string> {
  const s = new Set(["https://us.posthog.com", "https://eu.posthog.com"]);
  // Tests point PostHog at a local fake; production never sets this.
  if (process.env.CANVAS_POSTHOG_BASE) s.add(new URL(process.env.CANVAS_POSTHOG_BASE).origin);
  return s;
}

function load(): Record<string, string[]> {
  try {
    const j = JSON.parse(fs.readFileSync(file(), "utf8")) as { approvals?: Record<string, string[]> };
    return j.approvals && typeof j.approvals === "object" ? j.approvals : {};
  } catch {
    return {};
  }
}

export function isApproved(ref: SecretRef, origin: string): boolean {
  return builtin().has(origin) || (load()[keyOf(ref)] ?? []).includes(origin);
}

export function approve(ref: SecretRef, origin: string): void {
  const approvals = load();
  const k = keyOf(ref);
  approvals[k] = [...new Set([...(approvals[k] ?? []), origin])].sort();
  const p = file();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = `${p}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ version: 1, approvals }, null, 2) + "\n", { mode: 0o600 });
  fs.renameSync(tmp, p);
}
