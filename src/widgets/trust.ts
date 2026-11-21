// Which origins may receive which secret. A secret is only sent where the user has said so; the
// two PostHog cloud origins are approved from the start. The file sits next to Canvas's other
// app data and holds origins and local widget hashes, never secret values.

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

type Trust = { approvals: Record<string, string[]>; localWidgets: Record<string, string>; sources: string[] };

function load(): Trust {
  try {
    const j = JSON.parse(fs.readFileSync(file(), "utf8")) as Partial<Trust>;
    return {
      approvals: j.approvals && typeof j.approvals === "object" ? j.approvals : {},
      localWidgets: j.localWidgets && typeof j.localWidgets === "object" ? j.localWidgets : {},
      sources: Array.isArray(j.sources) ? j.sources : [],
    };
  } catch {
    return { approvals: {}, localWidgets: {}, sources: [] };
  }
}

function save(trust: Trust): void {
  const p = file();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = `${p}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ version: 1, ...trust }, null, 2) + "\n", { mode: 0o600 });
  fs.renameSync(tmp, p);
}

export function isApproved(ref: SecretRef, origin: string): boolean {
  return builtin().has(origin) || (load().approvals[keyOf(ref)] ?? []).includes(origin);
}

export function approve(ref: SecretRef, origin: string): void {
  const trust = load();
  const key = keyOf(ref);
  trust.approvals[key] = [...new Set([...(trust.approvals[key] ?? []), origin])].sort();
  save(trust);
}

export function isLocalWidgetApproved(id: string, hash: string): boolean {
  return load().localWidgets[id] === hash;
}

export function approveLocalWidget(id: string, hash: string): void {
  const trust = load();
  trust.localWidgets[id] = hash;
  save(trust);
}

const sourceKey = (kind: string, target: string) => JSON.stringify([kind, target]);

export function isSourceApproved(kind: string, target: string): boolean {
  return load().sources.includes(sourceKey(kind, target));
}

export function approveSource(kind: string, target: string): void {
  const trust = load();
  const key = sourceKey(kind, target);
  if (trust.sources.includes(key)) return;
  trust.sources.push(key);
  save(trust);
}

/** Extract the origin from stored config, which may not have passed validation. */
export function webOrigin(raw: unknown): string | undefined {
  if (typeof raw !== "string") return;
  try {
    const url = new URL(raw.trim());
    if (["https:", "http:"].includes(url.protocol) && !url.username && !url.password) return url.origin;
  } catch {}
}
