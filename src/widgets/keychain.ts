// Secrets live in the macOS Keychain; the server only ever reads them, to send upstream.
// Swift writes them (through `security -i` on stdin), nothing here writes and nothing travels over HTTP.

import { execFile } from "node:child_process";
import { WidgetError, type SecretRef } from "./types.ts";

const PART = /^[A-Za-z0-9._@:-]{1,80}$/;
const cache = new Map<string, string>();
// Every secret value this process has read, so error text and logs can be scrubbed.
const seen = new Set<string>();

const bin = () => process.env.CANVAS_SECURITY_BIN || "/usr/bin/security";
const keyOf = (r: SecretRef) => `${r.service}\0${r.account}`;

export function parseRef(v: unknown): SecretRef | undefined {
  if (!v || typeof v !== "object") return undefined;
  const { service, account } = v as Record<string, unknown>;
  if (typeof service !== "string" || typeof account !== "string" || !PART.test(service) || !PART.test(account)) return undefined;
  return { service, account };
}

function run(args: string[]): Promise<{ code: number; stdout: string; timedOut: boolean }> {
  return new Promise((resolve) => {
    execFile(bin(), args, { timeout: 5000, maxBuffer: 64 * 1024, windowsHide: true }, (err, stdout) => {
      if (!err) return resolve({ code: 0, stdout: String(stdout), timedOut: false });
      const e = err as NodeJS.ErrnoException & { killed?: boolean };
      resolve({ code: typeof e.code === "number" ? e.code : -1, stdout: "", timedOut: !!e.killed });
    });
  });
}

/** The secret's value. Exit 44 (item not found) is "needs-secret". Cached until the upstream says 401/403. */
export async function getSecret(ref: SecretRef): Promise<string> {
  const hit = cache.get(keyOf(ref));
  if (hit !== undefined) return hit;
  const r = await run(["find-generic-password", "-s", ref.service, "-a", ref.account, "-w"]);
  if (r.code === 0) {
    const value = r.stdout.replace(/\r?\n$/, "");
    if (value) {
      cache.set(keyOf(ref), value);
      if (value.length >= 3) seen.add(value);
      return value;
    }
  }
  if (r.code === 44 || r.code === 0) throw new WidgetError(0, "needs-secret", "No secret saved in the Keychain for this widget");
  if (r.timedOut) throw new WidgetError(0, "keychain-timeout", "The Keychain did not answer in time");
  throw new WidgetError(0, "keychain-error", "The Keychain lookup failed");
}

/** Is there an item at all? Asks without -w, so the value is never read. */
export async function hasSecret(ref: SecretRef): Promise<boolean> {
  return (await run(["find-generic-password", "-s", ref.service, "-a", ref.account])).code === 0;
}

export function clearSecret(ref?: SecretRef): void {
  if (ref) cache.delete(keyOf(ref));
  else cache.clear();
}

/** Scrub every secret value this process has seen, and anything shaped like a bearer token. */
export function redact(s: string): string {
  let out = String(s);
  for (const v of seen) if (out.includes(v)) out = out.split(v).join("•••");
  return out.replace(/Bearer\s+[A-Za-z0-9._~+/=-]{6,}/gi, "Bearer •••");
}
