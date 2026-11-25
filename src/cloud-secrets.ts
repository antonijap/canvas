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
  let raw: string;
  try { raw = fs.readFileSync(process.env.CANVAS_CLOUD_SECRETS_FILE!, "utf8"); }
  catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return {}; throw e; }
  const values = JSON.parse(raw);
  if (!values || typeof values !== "object" || Array.isArray(values) || Object.values(values).some((v) => typeof v !== "string")) {
    throw new Error("Invalid Cloud secrets file");
  }
  return values;
}

function updateFileStore(update: (values: Record<string, string>) => Record<string, string> | null): boolean {
  const file = process.env.CANVAS_CLOUD_SECRETS_FILE!;
  const lock = `${file}.lock`;
  try {
    // Serialize changes across processes, including the check for an existing account.
    fs.mkdirSync(lock, { mode: 0o700 });
    try {
      const values = update(fileStore());
      if (!values) return false;
      const next = `${lock}/next`;
      fs.writeFileSync(next, JSON.stringify(values), { mode: 0o600 });
      fs.renameSync(next, file);
      return true;
    } finally { fs.rmSync(lock, { recursive: true, force: true }); }
  } catch { return false; }
}

type SecretRead = { status: "found"; value: string } | { status: "missing" } | { status: "failed" };

export async function readSecretStrict(account: string): Promise<SecretRead> {
  if (!ACCOUNT.test(account)) return { status: "failed" };
  if (process.env.CANVAS_CLOUD_SECRETS_FILE) {
    try {
      const values = fileStore();
      return Object.hasOwn(values, account) ? { status: "found", value: values[account] } : { status: "missing" };
    } catch { return { status: "failed" }; }
  }
  return new Promise((resolve) => {
    execFile(bin(), ["find-generic-password", "-s", SERVICE(), "-a", account, "-w"], { timeout: 5000, maxBuffer: 64 * 1024 }, (err, out) => {
      if (err) return resolve({ status: err.code === 44 && !err.killed && !err.signal ? "missing" : "failed" });
      resolve({ status: "found", value: Buffer.from(String(out).trim(), "base64").toString("utf8") });
    });
  });
}

export async function readSecret(account: string): Promise<string | null> {
  const result = await readSecretStrict(account);
  return result.status === "found" ? result.value || null : null;
}

/** Writes (or replaces) a value. True when it is saved. */
export function writeSecret(account: string, value: string): Promise<boolean> {
  return saveSecret(account, value, true);
}

/** Adds a new item. An existing item makes the add fail. */
export function createSecret(account: string, value: string): Promise<boolean> {
  return saveSecret(account, value, false);
}

async function saveSecret(account: string, value: string, replace: boolean): Promise<boolean> {
  if (!ACCOUNT.test(account)) return false;
  if (process.env.CANVAS_CLOUD_SECRETS_FILE) {
    return updateFileStore((values) =>
      !replace && Object.hasOwn(values, account) ? null : { ...values, [account]: value });
  }
  const b64 = Buffer.from(value, "utf8").toString("base64");
  return new Promise((resolve) => {
    const p = spawn(bin(), ["-i"], { stdio: ["pipe", "ignore", "ignore"] });
    const t = setTimeout(() => { p.kill("SIGKILL"); resolve(false); }, 5000);
    p.on("exit", (code) => { clearTimeout(t); resolve(code === 0); });
    p.on("error", () => { clearTimeout(t); resolve(false); });
    p.stdin.on("error", () => {});
    // In interactive mode EOF returns the status of this single command.
    p.stdin.end(`add-generic-password${replace ? " -U" : ""} -s ${SERVICE()} -a ${account} -w ${b64}\n`);
  });
}

export async function deleteSecret(account: string): Promise<void> {
  if (!ACCOUNT.test(account)) return;
  if (process.env.CANVAS_CLOUD_SECRETS_FILE) {
    updateFileStore((values) => {
      if (!Object.hasOwn(values, account)) return null;
      delete values[account];
      return values;
    });
    return;
  }
  await new Promise<void>((resolve) => execFile(bin(), ["delete-generic-password", "-s", SERVICE(), "-a", account], { timeout: 5000 }, () => resolve()));
}

/**
 * A joined Cloud's secrets: the device token, the member tunnel address and this Mac's tunnel key, with the public
 * keys of the Cloud's two tunnels pinned at join time (hostKey: the enrolment tunnel the Cloud's id comes from;
 * memberKey: the tunnel used from then on).
 */
export interface JoinedSecrets { token: string; addr: string; key: unknown; hostKey?: string; memberKey?: string }

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
