// Window-server input belongs to the runner's process tree, whose Accessibility grant survives QA app rebuilds.
import childProcess from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { ROOT } from "../lib.ts";
import { Fail } from "../harness.ts";
import type { Mods, Pt } from "./harness.ts";

const SOURCE = path.join(ROOT, "qa/native/system-drag.swift");
const OUT = path.join(ROOT, "qa/out");

/** A source-addressed executable: never rebuilt under the same path while another runner uses it. */
export function systemDragHelper(source = SOURCE, out = OUT): string {
  const hash = createHash("sha256").update(fs.readFileSync(source)).digest("hex").slice(0, 16);
  const bin = path.join(out, `system-drag-${hash}`);
  if (fs.existsSync(bin)) return bin;
  fs.mkdirSync(out, { recursive: true });
  const tmp = `${bin}.${process.pid}.tmp`;
  try {
    childProcess.execFileSync("xcrun", ["swiftc", source, "-o", tmp], { stdio: ["ignore", "ignore", "pipe"], timeout: 30_000 });
    fs.renameSync(tmp, bin);
  } finally { fs.rmSync(tmp, { force: true }); }
  return bin;
}

/** Coordinates are screen points with AppKit's bottom-left origin; the helper flips to CGEvent's origin. */
export async function postSystemDrag(input: { pid: number; from: Pt; to: Pt; mods: Mods; steps: number; holdMs: number; dwellMs: number }) {
  return postSystemInput(input);
}

export async function postSystemClick(input: { pid: number; at: Pt; count: 1 | 2 }) {
  return postSystemInput({ mode: "click", ...input });
}

/** Keep the pointer on the QA window until the caller has inspected the hovered view. */
export async function withSystemHover<R>(input: { pid: number; at: Pt }, inspect: () => Promise<R>): Promise<R> {
  const child = childProcess.spawn(systemDragHelper(), [JSON.stringify({ mode: "hover", ...input })]);
  let stderr = "";
  child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
  child.stdin.on("error", () => {}); // The helper can exit before stdin closes, e.g. when input permission is missing.
  const closed = new Promise<void>((resolve) => child.once("close", () => resolve()));
  const timeout = setTimeout(() => child.kill("SIGKILL"), 30_000);
  try {
    const ready = await Promise.race([
      new Promise<boolean>((resolve) => child.stdout.once("data", () => resolve(true))),
      closed.then(() => false),
      new Promise<boolean>((resolve) => child.once("error", (error) => { stderr += error.message; resolve(false); })),
    ]);
    if (!ready) throw new Fail("System hover helper failed: " + stderr.trim());
    return await inspect();
  } finally {
    child.stdin.end();
    await closed;
    clearTimeout(timeout);
  }
}

async function postSystemInput(input: object) {
  const bin = systemDragHelper();
  await new Promise<void>((resolve, reject) => {
    childProcess.execFile(bin, [JSON.stringify(input)], { timeout: 30_000, encoding: "utf8" }, (err, _stdout, stderr) => {
      if (err) reject(new Fail(`System mouse helper failed: ${stderr.trim() || err.message}`));
      else resolve();
    });
  });
  return { system: true };
}
