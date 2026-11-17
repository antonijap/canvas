// Where a hosted Cloud's secrets live: the macOS Keychain (service cc.getcanvas.canvas.cloud). A joined Cloud's device
// token, tunnel address and tunnel key are one item (account `hosted:<host id>`); a hosting Mac's own tunnel keys are
// another (`host:keys`). Values are written through `security -i` on stdin, never as a command-line argument, and
// base64 so no quoting can break them. Nothing here logs a value.
//
// Tests set CANVAS_CLOUD_SECRETS_FILE: a 0600 JSON file stands in for the Keychain.

import { execFile, spawn } from "node:child_process";
import fs from "node:fs";

const SERVICE = () => process.env.CANVAS_CLOUD_KEYCHAIN_SERVICE || "cc.getcanvas.canvas.cloud";
const ACCOUNT = /^[A-Za-z0-9._@:-]{1,80}$/;
const bin = () => process.env.CANVAS_SECURITY_BIN || "/usr/bin/security";

function fileStore(): Record<string, string> {
  try { return JSON.parse(fs.readFileSync(process.env.CANVAS_CLOUD_SECRETS_FILE!, "utf8")); } catch { return {}; }
}

export async function readSecret(account: string): Promise<string | null> {
  if (!ACCOUNT.test(account)) return null;
  if (process.env.CANVAS_CLOUD_SECRETS_FILE) return fileStore()[account] ?? null;
  return new Promise((resolve) => {
    execFile(bin(), ["find-generic-password", "-s", SERVICE(), "-a", account, "-w"], { timeout: 5000, maxBuffer: 64 * 1024 }, (err, out) => {
      if (err) return resolve(null);
      try { resolve(Buffer.from(String(out).trim(), "base64").toString("utf8") || null); } catch { resolve(null); }
    });
  });
}

/** Writes (or replaces) a value. True when it is saved. */
export async function writeSecret(account: string, value: string): Promise<boolean> {
  if (!ACCOUNT.test(account)) return false;
  if (process.env.CANVAS_CLOUD_SECRETS_FILE) {
    const all = fileStore();
    all[account] = value;
    fs.writeFileSync(process.env.CANVAS_CLOUD_SECRETS_FILE, JSON.stringify(all), { mode: 0o600 });
    return true;
  }
  const b64 = Buffer.from(value, "utf8").toString("base64");
  return new Promise((resolve) => {
    const p = spawn(bin(), ["-i"], { stdio: ["pipe", "ignore", "ignore"] });
    const t = setTimeout(() => { p.kill("SIGKILL"); resolve(false); }, 5000);
    p.on("exit", (code) => { clearTimeout(t); resolve(code === 0); });
    p.on("error", () => { clearTimeout(t); resolve(false); });
    p.stdin.on("error", () => {});
    p.stdin.end(`add-generic-password -U -s ${SERVICE()} -a ${account} -w ${b64}\n`);
  });
}

export async function deleteSecret(account: string): Promise<void> {
  if (!ACCOUNT.test(account)) return;
  if (process.env.CANVAS_CLOUD_SECRETS_FILE) {
    const all = fileStore();
    delete all[account];
    fs.writeFileSync(process.env.CANVAS_CLOUD_SECRETS_FILE, JSON.stringify(all), { mode: 0o600 });
    return;
  }
  await new Promise<void>((resolve) => execFile(bin(), ["delete-generic-password", "-s", SERVICE(), "-a", account], { timeout: 5000 }, () => resolve()));
}

/** A joined Cloud's secrets: the device token, the member tunnel address and this Mac's tunnel key. */
export interface JoinedSecrets { token: string; addr: string; key: unknown }

export async function readJoined(hostId: string): Promise<JoinedSecrets | null> {
  const raw = await readSecret(`hosted:${hostId}`);
  if (!raw) return null;
  try {
    const j = JSON.parse(raw);
    return typeof j.token === "string" && typeof j.addr === "string" ? j : null;
  } catch { return null; }
}
export const writeJoined = (hostId: string, s: JoinedSecrets) => writeSecret(`hosted:${hostId}`, JSON.stringify(s));
export const deleteJoined = (hostId: string) => deleteSecret(`hosted:${hostId}`);

/**
 * Text with every Cloud secret shape blanked: invite links, join codes, device tokens, tunnel addresses, bearer values.
 * The server runs every line it writes to its log or stderr through this (src/server.ts).
 */
export function scrubSecrets(text: string): string {
  return String(text)
    .replace(/canvas:\/\/cloud\/join\?\S*/gi, "canvas://cloud/join?•••")
    .replace(/\bcc[dj]_[0-9a-f]{16}\.[A-Za-z0-9_-]{43}/g, "•••")
    .replace(/(?<![A-Za-z0-9_-])tc[A-Za-z0-9_-]{20,}/g, "tc•••")
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]{6,}/gi, "Bearer •••");
}
