// pnpm qa:native: real macOS mouse and keyboard in the Canvas app, without computer use.
//
// Builds the QA app (QA=1 apps/macos/build.sh into a temp folder, cached by a hash of the Swift sources), starts
// QA_NATIVE_SHARDS instances (default 1, at most 3) next to whatever Canvas is already running, each with its own
// port, documents, preferences and window (qa/native/app.ts), and runs the scenarios (qa/native/scenarios.ts)
// across them. Each scenario gets a fresh copy of demos/playground.canvas; its end state is saved as a window
// screenshot to qa/out/native/. Exit code 1 when anything fails.
//
//   pnpm qa:native              every scenario
//   pnpm qa:native pages drag   only scenarios whose area or name holds one of the words
//   QA_NATIVE_SHARDS=3 pnpm qa:native
//   QA_NATIVE_KEEP=1            keep the instances' temp folders (logs) after the run
//
// Exit code: 1 when a scenario fails or the Swift does not compile. When this Mac cannot run it (not macOS, no
// swiftc, no engine build, no window server session, an instance that never starts), it says why and exits 0.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ROOT, copyDir, sleep } from "../lib.ts";
import { PLAYGROUND } from "../playground.ts";
import { QaApp, buildQaApp } from "./app.ts";
import { Fail, NT, Skip, nativeSlug, nativeFileStem, scenarios, type NativeScenario } from "./harness.ts";
import "./scenarios.ts";

const OUT = path.join(ROOT, "qa", "out", "native");

/** This Mac cannot run native QA (not a test failure): the run says why and exits 0. */
class CannotRun extends Error {}
const MACOS = path.join(ROOT, "apps", "macos");

/** The QA build for the current sources: reused while no Swift file changed. */
function qaBuild(): string {
  const files = [...fs.readdirSync(MACOS).filter((f) => /\.(swift|plist|sh)$/.test(f)).map((f) => path.join(MACOS, f)),
    ...fs.readdirSync(path.join(MACOS, "DesignSystem")).filter((f) => f.endsWith(".swift")).map((f) => path.join(MACOS, "DesignSystem", f))].sort();
  files.push(path.join(MACOS, "tools", "image-previews.swift"));
  const h = createHash("sha256");
  for (const f of files) h.update(f).update(fs.readFileSync(f));
  const key = h.digest("hex").slice(0, 16);
  const base = path.join(os.tmpdir(), "canvas-qa-native-build");
  const dir = path.join(base, key);
  const app = path.join(dir, "Canvas QA.app");
  if (fs.existsSync(path.join(app, "Contents/MacOS/Canvas"))) return app;
  // One build kept: older ones go.
  fs.rmSync(base, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const t0 = Date.now();
  process.stdout.write("building the QA app... ");
  process.env.SWIFT_OPT ??= "-Onone";
  try { execFileSync("xcrun", ["--find", "swiftc"], { stdio: "ignore" }); } catch { throw new CannotRun("no swiftc (install the Xcode command line tools)"); }
  try { buildQaApp(dir); } catch (e) {
    fs.rmSync(dir, { recursive: true, force: true });
    const err = String((e as { stderr?: Buffer }).stderr ?? (e as Error).message).split("\n").filter((l) => /error/.test(l)).slice(0, 12).join("\n");
    throw new Error(`the QA build does not compile:\n${err}`);
  }
  console.log(`${((Date.now() - t0) / 1000).toFixed(0)} s`);
  return app;
}

type Result = { slug: string; name: string; area: string; status: "PASS" | "FAIL" | "SKIP"; ms: number; msg: string; shard: number };


async function runOne(app: QaApp, s: NativeScenario, k: number): Promise<Result> {
  const file = path.join(app.docs, `${String(k).padStart(2, "0")}-${nativeFileStem(s)}.canvas`);
  if (!s.startEmpty) copyDir(PLAYGROUND, file);
  const t = new NT(app, file);
  const t0 = Date.now();
  let status: Result["status"] = "PASS", msg = "";
  try {
    await t.cmd("qa.cloud", { commentName: "Anna" });
    if (!s.startEmpty) {
      await app.openShown(file);
      await t.waitState((st) => st.file === file && st.pages.length > 0, "the file to open", 15_000);
      await t.settle();
      const st = await t.state();
      if (st.modal) throw new Fail(`a modal window is open: ${JSON.stringify(st.modal)}`);
      // A QA instance must never take focus from the person using the Mac.
      if (st.window.active) t.note("the QA app was the active app at the start");
    }
    await withTimeout(s.run(t), 120_000, s.name);
  } catch (e) {
    if (e instanceof Skip) { status = "SKIP"; msg = e.message; }
    else { status = "FAIL"; msg = (e as Error).message + (e instanceof Fail ? "" : `\n${(e as Error).stack?.split("\n").slice(1, 4).join("\n")}`); }
  }
  try {
    const png = path.join(OUT, `${nativeFileStem(s)}.png`);
    await t.shot(png);
    if (status === "FAIL") msg += `\n  shot: qa/out/native/${nativeFileStem(s)}.png`;
  } catch (e) { msg += `\n  no screenshot: ${(e as Error).message}`; }
  if (t.notes.length) msg += (msg ? "\n  " : "") + t.notes.join("; ");
  // Leave the instance clean for the next scenario: no menu, palette, popover or Settings window left open.
  try {
    await app.cmd({ op: "qa.reset", timeoutMs: 10_000 });
    await app.cmd({ op: "close", args: { file }, timeoutMs: 10_000 });
  } catch {}
  fs.rmSync(file, { recursive: true, force: true });
  return { slug: nativeSlug(s), name: s.name, area: s.area, status, ms: Date.now() - t0, msg, shard: app.shard };
}

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout;
  return Promise.race([p, new Promise<T>((_, rej) => { timer = setTimeout(() => rej(new Fail(`${what} took over ${ms / 1000} s`)), ms); })]).finally(() => clearTimeout(timer));
}

async function main() {
  const want = process.argv.slice(2).map((s) => s.toLowerCase());
  const list = want.length ? scenarios.filter((s) => want.some((w) => `${s.area} ${s.name}`.toLowerCase().includes(w))) : scenarios;
  if (process.platform !== "darwin") throw new CannotRun("it runs on macOS only");
  if (!fs.existsSync(path.join(PLAYGROUND, "document.json"))) throw new Error(`${PLAYGROUND} is missing: run node qa/playground.ts`);
  const pkg = process.env.CANVAS_ENGINE_PKG ?? path.join(ROOT, "engine", "pkg");
  if (!fs.existsSync(path.join(pkg, "canvas_engine.js"))) throw new CannotRun(`no engine build at ${pkg}: run engine/build.sh, or point CANVAS_ENGINE_PKG at one`);
  const shards = Math.max(1, Math.min(3, Number(process.env.QA_NATIVE_SHARDS ?? 1) || 1, list.length));
  fs.mkdirSync(OUT, { recursive: true });
  const built = qaBuild();
  // Real path: the app and server report files by it (os.tmpdir() is behind /var -> /private/var).
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "canvas-qa-native-")));
  const apps = Array.from({ length: shards }, (_, i) => new QaApp(root, i + 1));
  let stopping = false;
  const stopAll = async () => {
    if (stopping) return;
    stopping = true;
    await Promise.all(apps.map((a) => a.stop().catch(() => {})));
    if (!process.env.QA_NATIVE_KEEP) fs.rmSync(root, { recursive: true, force: true });
  };
  for (const sig of ["SIGINT", "SIGTERM"] as const) process.once(sig, async () => { await stopAll(); process.exit(130); });
  const results: Result[] = [];
  const t0 = Date.now();
  try {
    try { await Promise.all(apps.map((a) => a.start(built))); }
    catch (e) { throw new CannotRun(`a QA instance did not start (is there a logged-in window server session?): ${(e as Error).message.slice(0, 600)}`); }
    // Controls are found through the marks the SwiftUI views carry (qa.marks); text recognition is only a fallback,
    // loaded on its first use, one read at a time on this Mac (harness.ts withVisionLock).
    console.log(`${apps.length} QA instance${apps.length > 1 ? "s" : ""} (ports ${apps.map((a) => a.port).join(", ")}), ${list.length} scenarios`);
    let next = 0, k = 0;
    await Promise.all(apps.map(async (app) => {
      while (next < list.length) {
        const s = list[next++];
        const r = await runOne(app, s, ++k);
        results.push(r);
        console.log(`${r.status} ${r.area} / ${r.name} (${(r.ms / 1000).toFixed(1)} s${apps.length > 1 ? `, s${r.shard}` : ""})${r.msg ? `\n  ${r.msg}` : ""}`);
      }
    }));
  } finally {
    await stopAll();
  }
  // For pnpm qa:coverage: which catalog pairs passed natively in the last run.
  fs.writeFileSync(path.join(ROOT, "qa", "out", "native-last.json"), JSON.stringify({ at: new Date().toISOString(), filtered: want.length > 0, results }, null, 1));
  const fail = results.filter((r) => r.status === "FAIL").length, skip = results.filter((r) => r.status === "SKIP").length;
  console.log(`\n${results.length - fail - skip} passed, ${fail} failed, ${skip} skipped in ${((Date.now() - t0) / 1000).toFixed(0)} s, ${NT.ocrReads} text recognition read${NT.ocrReads === 1 ? "" : "s"}. Screenshots: qa/out/native/`);
  await sleep(10);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => {
  if (e instanceof CannotRun) { console.log(`qa:native skipped: ${e.message}`); process.exit(0); }
  console.error(e);
  process.exit(1);
});
