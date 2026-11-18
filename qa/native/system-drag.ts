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
    childProcess.execFileSync("xcrun", ["swiftc", source, "-o", tmp], { stdio: ["ignore", "ignore", "pipe"] });
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
