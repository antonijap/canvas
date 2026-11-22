// pnpm qa:release: the release checklist (docs/qa-plan.md section 8). Runs each check, prints one line per item
// (PASS, FAIL, NEEDS-MAINTAINER for a decision only the maintainer can make, MANUAL for a step a person has to do) and
// writes qa/out/release/report.md. Exit code 1 on failure, 2 when perf needs the maintainer.
//
//   pnpm qa:release                  the checklist, then pnpm test, qa, qa:matrix, qa:coverage, qa:native and bench (those defined)
//   pnpm qa:release --quick          the checklist only, with shorter fuzz and crash runs
//   pnpm qa:release --only scrub     one check (several: --only scrub,docs). Ids: see CHECKS below
//
// Nothing here rewrites history, picks a licence or touches the running app: it reports.
import { execFileSync, spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { freePort, ROOT, sleep, startServer, type Scratch } from "./lib.ts";
import { crashCheck } from "./release-crash.ts";
import { WEB_METRICS } from "../bench/perf-budgets.ts";

type Status = "PASS" | "FAIL" | "NEEDS-MAINTAINER" | "MANUAL" | "SKIP";
type Item = { status: Status; text: string; details?: string[] };
type Ctx = { quick: boolean; out: string };
type Check = { id: string; title: string; run: (c: Ctx) => Promise<Item[]> | Item[] };

const OUT = path.join(ROOT, "qa", "out", "release");
const RANK: Record<Status, number> = { FAIL: 4, "NEEDS-MAINTAINER": 3, MANUAL: 2, SKIP: 1, PASS: 0 };
const item = (status: Status, text: string, details?: string[]): Item => ({ status, text, ...(details?.length ? { details } : {}) });
const rel = (p: string) => path.relative(ROOT, p);

/** Run a command; its exit code and output (both streams). Never throws. */
function run(cmd: string, args: string[], opts: { cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number; maxBuffer?: number } = {}) {
  const r = spawnSync(cmd, args, { cwd: opts.cwd ?? ROOT, env: opts.env ?? process.env, encoding: "utf8", timeout: opts.timeoutMs ?? 600_000, maxBuffer: opts.maxBuffer ?? 512 * 1024 * 1024 });
  return { code: r.status ?? (r.error ? -1 : 1), out: `${r.stdout ?? ""}${r.stderr ?? ""}`, stdout: r.stdout ?? "", error: r.error?.message };
}
const git = (...args: string[]) => execFileSync("git", args, { cwd: ROOT, encoding: "utf8", maxBuffer: 1024 * 1024 * 1024 });

/** node --test on some files (TAP): each test's result, and the first line of each failure's error. */
function nodeTests(files: string[], env: Record<string, string> = {}, timeoutMs = 900_000) {
  const r = run(process.execPath, ["--test", "--test-reporter=tap", ...files], { env: { ...process.env, ...env }, timeoutMs });
  const tests: { ok: boolean; name: string; error?: string; depth: number }[] = [];
  const lines = r.stdout.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^(\s*)(not )?ok \d+ - (.*)$/);
    if (!m) continue;
    const t: (typeof tests)[number] = { ok: !m[2], name: m[3].replace(/ # .*$/, ""), depth: m[1].length / 4 };
    if (!t.ok) {
      for (let j = i + 1; j < Math.min(lines.length, i + 40); j++) {
        const e = lines[j].match(/^\s*error: (.*)$/);
        if (e) { t.error = e[1].replace(/^\|-?$/, "").replace(/^'|'$/g, "") || lines[j + 1]?.trim(); break; }
      }
    }
    tests.push(t);
  }
  return { code: r.code, tests, out: r.out };
}

// ---------------------------------------------------------------- 1. repo scrub

type Pattern = { id: string; what: string; re: RegExp; secret?: boolean; status: Status };

/** Words that must not ship, kept out of the repo itself: qa/release-private.txt (ignored by git), one per line. */
function privateTerms(): string[] {
  const f = process.env.CANVAS_PRIVATE_TERMS ?? path.join(ROOT, "qa", "release-private.txt");
  if (!fs.existsSync(f)) return [];
  return fs.readFileSync(f, "utf8").split("\n").map((l) => l.replace(/#.*/, "").trim()).filter(Boolean);
}
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function scrubPatterns(): Pattern[] {
  const emails = new Set<string>();
  try { emails.add(git("config", "user.email").trim()); } catch {}
  for (const e of git("log", "--all", "--format=%ae%n%ce").split("\n")) if (e.trim() && !/noreply/.test(e)) emails.add(e.trim());
  const names = privateTerms();
  return [
    { id: "anthropic-key", what: "Anthropic API key", re: /sk-ant-[A-Za-z0-9_-]{20,}/g, secret: true, status: "FAIL" },
    { id: "openai-key", what: "OpenAI API key", re: /\bsk-(?:proj-)?[A-Za-z0-9_-]{32,}/g, secret: true, status: "FAIL" },
    { id: "stripe-key", what: "Stripe live key", re: /\b[sr]k_live_[A-Za-z0-9]{10,}/g, secret: true, status: "FAIL" },
    { id: "posthog-key", what: "PostHog key", re: /\bph[cx]_[A-Za-z0-9]{20,}/g, secret: true, status: "FAIL" },
    { id: "github-token", what: "GitHub token", re: /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,})/g, secret: true, status: "FAIL" },
    { id: "slack-token", what: "Slack token", re: /\bxox[abprs]-[A-Za-z0-9-]{10,}/g, secret: true, status: "FAIL" },
    { id: "aws-key", what: "AWS access key", re: /\bAKIA[0-9A-Z]{16}\b/g, secret: true, status: "FAIL" },
    { id: "google-key", what: "Google API key", re: /\bAIza[0-9A-Za-z_-]{35}\b/g, secret: true, status: "FAIL" },
    { id: "fal-key", what: "fal.ai key", re: /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}:[0-9a-f]{32}\b/g, secret: true, status: "FAIL" },
    { id: "private-key", what: "private key", re: /-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----/g, secret: true, status: "FAIL" },
    // A hosted Cloud's secrets (cloud/adapters/mac/host.ts, src/cloud-tunnel.ts): an invite link, a join code, a device token,
    // a tunnel address (it carries keys), a bearer header with a real value.
    { id: "cloud-invite", what: "Cloud invite link", re: /canvas:\/\/cloud\/join\?[^\s"'`<>)]*(?:code|tc)=[A-Za-z0-9_.-]{20,}/g, secret: true, status: "FAIL" },
    { id: "cloud-secret", what: "Cloud device token or join code", re: /\bcc[dj]_[0-9a-f]{16}\.[A-Za-z0-9_-]{43}/g, secret: true, status: "FAIL" },
    { id: "tunnel-address", what: "tunnel address", re: /(?<![A-Za-z0-9_-])tc[A-Za-z0-9_-]{50,}/g, secret: true, status: "FAIL" },
    { id: "bearer-value", what: "bearer token", re: /\bBearer [A-Za-z0-9._~+/-]{30,}/g, secret: true, status: "FAIL" },
    { id: "token-param", what: "token in a URL", re: /[?&]token=[A-Za-z0-9._~+/-]{20,}/g, secret: true, status: "FAIL" },
    { id: "assigned-secret", what: "a secret assigned in code", re: /\b(?:api[_-]?key|secret|token|password|passwd)["']?\s*[:=]\s*["'][A-Za-z0-9_\-+/=]{20,}["']/gi, secret: true, status: "FAIL" },
    { id: "personal-path", what: "personal path", re: /\/Users\/(?!Shared\/)[A-Za-z0-9._-]+|\/home\/[a-z][a-z0-9._-]+/g, status: "FAIL" },
    ...(emails.size ? [{ id: "maintainer-email", what: "the maintainer's email", re: new RegExp([...emails].map(escapeRe).join("|"), "gi"), status: "FAIL" as Status }] : []),
    ...(names.length ? [{ id: "private-name", what: "private or customer name", re: new RegExp(`\\b(?:${names.map(escapeRe).join("|")})`, "gi"), status: "FAIL" as Status }] : []),
  ];
}
// Files that must never be in the repo, by name.
const SECRET_FILES = /(^|\/)(\.env(\.[^/]*)?|[^/]*\.(p8|p12|pem|key|keystore|jks|mobileprovision)|id_(rsa|ed25519|ecdsa)|credentials\.json|service-account[^/]*\.json|\.npmrc|\.netrc)$/;
const SECRET_FILE_OK = /(^|\/)\.env\.example$/;

type Allow = { id: string; glob: RegExp; text?: RegExp; reason: string; line: number; used: number };
/** qa/release-allow.txt: `<pattern id or *> <path glob> [text regex]  # reason`. A rule without a reason is ignored. */
function readAllow(): { rules: Allow[]; problems: string[] } {
  const f = path.join(ROOT, "qa", "release-allow.txt");
  const rules: Allow[] = [], problems: string[] = [];
  if (!fs.existsSync(f)) return { rules, problems: ["qa/release-allow.txt is missing"] };
  fs.readFileSync(f, "utf8").split("\n").forEach((l, i) => {
    if (!l.trim() || l.trim().startsWith("#")) return;
    const [spec, ...why] = l.split(" # ");
    const reason = why.join(" # ").trim();
    const [id, glob, ...rest] = spec.trim().split(/\s+/);
    if (!reason || !glob) return void problems.push(`qa/release-allow.txt:${i + 1} needs "<id> <glob> [regex] # reason"`);
    const g = new RegExp("^" + glob.split("**").map((s) => s.split("*").map(escapeRe).join("[^/]*")).join(".*") + "$");
    rules.push({ id, glob: g, text: rest.length ? new RegExp(rest.join(" "), "i") : undefined, reason, line: i + 1, used: 0 });
  });
  return { rules, problems };
}

/** Every blob's bytes, streamed through one git cat-file --batch (one process, not one per blob). */
function catBlobs(shas: string[], each: (sha: string, buf: Buffer) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const p = spawn("git", ["cat-file", "--batch"], { cwd: ROOT, stdio: ["pipe", "pipe", "ignore"] });
    let buf: Buffer = Buffer.alloc(0);
    let want: { sha: string; size: number } | null = null;
    p.stdout.on("data", (chunk: Buffer) => {
      buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
      for (;;) {
        if (!want) {
          const nl = buf.indexOf(10);
          if (nl < 0) return;
          const [sha, , size] = buf.subarray(0, nl).toString().split(" ");
          buf = buf.subarray(nl + 1);
          want = { sha, size: Number(size) || 0 };
        }
        if (buf.length < want.size + 1) return;
        each(want.sha, buf.subarray(0, want.size));
        buf = buf.subarray(want.size + 1);
        want = null;
      }
    });
    p.on("error", reject);
    p.on("close", () => resolve());
    p.stdin.end(shas.join("\n") + "\n");
  });
}

type Hit = { p: Pattern; file: string; line?: number; where: string; match: string };
const shown = (h: Hit) => (h.p.secret ? `${h.match.slice(0, 4)}***` : h.match.length > 60 ? h.match.slice(0, 60) + "..." : h.match);

function scanText(text: string, file: string, pats: Pattern[], lineOf: (i: number) => number | undefined, where: (line?: number) => string): Hit[] {
  const hits: Hit[] = [];
  for (const p of pats) {
    p.re.lastIndex = 0;
    for (const m of text.matchAll(p.re)) {
      const line = lineOf(m.index!);
      hits.push({ p, file, line, where: where(line), match: m[0] });
    }
  }
  return hits;
}
/**
 * Screenshots carry text a byte scan cannot see: the scrub reads every tracked image under docs/ (evidence, perf)
 * with macOS Vision (qa/ocr.swift) and looks for the same personal paths, emails and private names, plus the
 * committer's name and this Mac's user name. design/, qa/baselines/ and test/golden/ are mockups and test pictures:
 * not read (too many to be cheap). Not macOS, or Vision fails: NEEDS-MAINTAINER (look at the pictures yourself).
 */
function scrubImages(pats: Pattern[], files: string[], allowed: (h: Hit) => boolean): Item[] {
  const imgs = files.filter((f) => f.startsWith("docs/") && /\.(png|jpe?g)$/i.test(f));
  if (!imgs.length) return [item("PASS", "images under docs/: none tracked")];
  if (process.platform !== "darwin") return [item("NEEDS-MAINTAINER", `images under docs/: ${imgs.length} not read (text recognition needs macOS); check them for paths and names`, imgs)];
  const who: string[] = [];
  try { const n = git("config", "user.name").trim(); if (n) who.push(n); } catch {}
  const user = os.userInfo().username;
  if (user && user.length > 2) who.push(user);
  const extra: Pattern[] = who.length ? [{ id: "person-name", what: "the committer's name or this Mac's user name", re: new RegExp(who.map(escapeRe).join("|"), "gi"), status: "FAIL" }] : [];
  const all = [...pats, ...extra];
  const r = spawnSync("xcrun", ["swift", path.join(ROOT, "qa", "ocr.swift"), ...imgs.map((f) => path.join(ROOT, f))], { cwd: ROOT, encoding: "utf8", timeout: 300_000, maxBuffer: 64 * 1024 * 1024 });
  const lines = (r.stdout ?? "").split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l) as { file: string; text?: string; error?: string }; } catch { return null; } }).filter(Boolean) as { file: string; text?: string; error?: string }[];
  const unread = imgs.filter((f) => !lines.some((l) => l.file === path.join(ROOT, f) && typeof l.text === "string"));
  const hits: Hit[] = [];
  for (const l of lines) {
    if (typeof l.text !== "string") continue;
    const f = path.relative(ROOT, l.file);
    hits.push(...scanText(l.text, f, all, () => undefined, () => `${f} (text in the image)`).filter((h) => !allowed(h)));
  }
  const items: Item[] = [];
  items.push(hits.length ? item("FAIL", `images under docs/: ${hits.length} personal path, email or name hit${hits.length === 1 ? "" : "s"} in their text`, hits.map((h) => `${h.where}  ${shown(h)}`)) : item("PASS", `images under docs/: ${imgs.length - unread.length} read, no personal paths, emails or names in their text`));
  if (unread.length) items.push(item("NEEDS-MAINTAINER", `images under docs/: ${unread.length} could not be read (${(r.stderr || lines.find((l) => l.error)?.error || "Vision failed").split("\n")[0].slice(0, 120)}); check them yourself`, unread));
  return items;
}

function lineIndex(text: string) {
  const starts = [0];
  for (let i = text.indexOf("\n"); i >= 0; i = text.indexOf("\n", i + 1)) starts.push(i + 1);
  return (pos: number) => {
    let lo = 0, hi = starts.length - 1;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (starts[mid] <= pos) lo = mid; else hi = mid - 1; }
    return lo + 1;
  };
}

async function scrub(): Promise<Item[]> {
  const pats = scrubPatterns();
  const { rules, problems } = readAllow();
  const allowed = (h: { p: Pattern; file: string; match: string }) => {
    const r = rules.find((r) => (r.id === "*" || r.id === h.p.id) && r.glob.test(h.file) && (!r.text || r.text.test(h.match)));
    if (r) r.used++;
    return !!r;
  };
  const items: Item[] = problems.map((p) => item("FAIL", p));

  // The tracked tree, every file (binaries too: a compiled app can carry the build machine's paths).
  const files = git("ls-files", "-z").split("\0").filter(Boolean);
  const tree: Hit[] = [];
  const binaries = new Set<string>();
  for (const f of files) {
    let buf: Buffer;
    try { buf = fs.readFileSync(path.join(ROOT, f)); } catch { continue; }
    const binary = buf.subarray(0, 8000).includes(0);
    const text = buf.toString(binary ? "latin1" : "utf8");
    if (binary) binaries.add(f);
    const at = binary ? () => undefined : lineIndex(text);
    tree.push(...scanText(text, f, pats, at, (l) => (l ? `${f}:${l}` : `${f} (binary)`)));
  }
  const treeHits = tree.filter((h) => !allowed(h));
  items.push(...scrubImages(pats, files, allowed));
  const secretFiles = files.filter((f) => SECRET_FILES.test(f) && !SECRET_FILE_OK.test(f));

  // History: every added line of every commit on every ref (text), and every blob ever stored (binaries).
  const inTree = new Set(tree.map((h) => `${h.file}\n${h.match}`));
  const hist: Hit[] = [];
  const log = git("log", "--all", "-p", "--no-color", "--no-ext-diff", "--no-renames", "--format=COMMIT %h");
  let commit = "", file = "", line = 0;
  for (const l of log.split("\n")) {
    if (l.startsWith("COMMIT ")) { commit = l.slice(7); continue; }
    if (l.startsWith("+++ ")) { file = l.slice(4).replace(/^b\//, ""); continue; }
    if (l.startsWith("@@")) { line = Number(l.match(/\+(\d+)/)?.[1] ?? 0); continue; }
    if (l.startsWith("+")) {
      for (const h of scanText(l.slice(1), file, pats, () => line, () => `${commit} ${file}:${line}`)) hist.push(h);
      line++;
    } else if (l.startsWith(" ")) line++;
  }
  const blobs = git("rev-list", "--all", "--objects").split("\n").map((l) => l.split(" ")).filter((p) => p.length === 2);
  const blobInfo = git("cat-file", "--batch-check=%(objectname) %(objecttype) %(objectsize)", "--batch-all-objects").split("\n");
  const kind = new Map(blobInfo.map((l) => l.split(" ")).map(([sha, t, s]) => [sha, { t, s: Number(s) }]));
  const wanted = new Map(blobs.filter(([sha]) => kind.get(sha)?.t === "blob").map(([sha, f]) => [sha, f]));
  await catBlobs([...wanted.keys()], (sha, buf) => {
    if (!buf.subarray(0, 8000).includes(0)) return; // text: the log above covered it
    const f = wanted.get(sha)!;
    hist.push(...scanText(buf.toString("latin1"), f, pats, () => undefined, () => `blob ${sha.slice(0, 9)} ${f} (binary)`));
  });
  const histOnly = new Map<string, Hit>();
  for (const h of hist) {
    if (inTree.has(`${h.file}\n${h.match}`) || allowed(h)) continue;
    const key = `${h.p.id}\n${h.file}\n${h.match}`;
    if (!histOnly.has(key)) histOnly.set(key, h);
  }
  const everFiles = [...new Set(git("log", "--all", "--format=", "--name-only").split("\n").filter(Boolean))];
  const histSecretFiles = everFiles.filter((f) => SECRET_FILES.test(f) && !SECRET_FILE_OK.test(f) && !files.includes(f));
  const authors = [...new Set(git("log", "--all", "--format=%ae").split("\n").filter(Boolean))].filter((e) => !/noreply/.test(e));

  // One item per pattern, for the tree (FAIL) and for history (NEEDS-MAINTAINER: only a rewrite removes those).
  const fmt = (h: Hit) => `${h.where}  ${shown(h)}`;
  for (const p of pats) {
    const t = treeHits.filter((h) => h.p === p);
    items.push(t.length ? item(p.status, `tracked files: ${t.length} ${p.what} hit${t.length === 1 ? "" : "s"}`, t.map(fmt)) : item("PASS", `tracked files: no ${p.what}`));
    const hh = [...histOnly.values()].filter((h) => h.p === p);
    if (hh.length) items.push(item("NEEDS-MAINTAINER", `history only (gone from the tree, still in git history): ${hh.length} ${p.what} hit${hh.length === 1 ? "" : "s"}; removing them needs a history rewrite`, hh.map(fmt)));
  }
  items.push(secretFiles.length ? item("FAIL", `secret-looking files tracked: ${secretFiles.length}`, secretFiles) : item("PASS", "no .env, key, keystore or certificate files tracked"));
  if (histSecretFiles.length) items.push(item("NEEDS-MAINTAINER", `secret-looking files in history: ${histSecretFiles.length}`, histSecretFiles));
  if (authors.length) items.push(item("NEEDS-MAINTAINER", `commit metadata carries ${authors.length} personal email address${authors.length === 1 ? "" : "es"} on every commit (author/committer); publishing the history publishes ${authors.length === 1 ? "it" : "them"}`, authors.map((a) => `${a.slice(0, 4)}***@${a.split("@")[1] ?? ""}`)));
  if (!privateTerms().length) items.push(item("NEEDS-MAINTAINER", "no private names list: put customer and client names, one per line, in qa/release-private.txt (ignored by git) so the scrub looks for them"));
  const stale = rules.filter((r) => !r.used);
  if (stale.length) items.push(item("PASS", `${stale.length} allowlist rule${stale.length === 1 ? "" : "s"} matched nothing (can go)`, stale.map((r) => `qa/release-allow.txt:${r.line}`)));
  return items;
}

// ---------------------------------------------------------------- 2. licence

const COPYLEFT = /\b(A?GPL|LGPL|SSPL|EUPL|CC-BY-SA|OSL|MPL)\b/i;

function licence(c: Ctx): Item[] {
  const items: Item[] = [];
  const lic = ["LICENSE", "LICENSE.md", "LICENSE.txt", "COPYING"].find((f) => fs.existsSync(path.join(ROOT, f)));
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
  items.push(lic ? item("PASS", `licence file: ${lic}`) : item("NEEDS-MAINTAINER", "no LICENSE file: choose a licence (the checklist does not pick one)"));
  items.push(pkg.license ? item("PASS", `package.json license: ${pkg.license}`) : item("NEEDS-MAINTAINER", 'package.json has no "license" field (set it with the licence choice)'));
  const cargoToml = ["engine/Cargo.toml", "engine/glsl/Cargo.toml"].filter((f) => fs.existsSync(path.join(ROOT, f)));
  for (const f of cargoToml) {
    const own = fs.readFileSync(path.join(ROOT, f), "utf8").match(/^license\s*=\s*"([^"]+)"/m)?.[1];
    if (!own) items.push(item("NEEDS-MAINTAINER", `${f} has no license field (set it with the licence choice)`));
  }

  // npm packages
  // What ships: the npm packages the server and MCP run on, and the crates compiled into the engine's WASM.
  const shipped: string[] = [];
  const notices: string[] = ["# Third-party notices (draft)", "", `Generated by pnpm qa:release on ${new Date().toISOString().slice(0, 10)}. Review before publishing.`, ""];
  const npm = run("pnpm", ["licenses", "list", "--json"]);
  if (npm.code !== 0) items.push(item("FAIL", "pnpm licenses list failed", [npm.out.slice(0, 500)]));
  else {
    const byLic = JSON.parse(npm.stdout) as Record<string, { name: string; versions: string[]; license?: string; homepage?: string; author?: string }[]>;
    const all = Object.entries(byLic).flatMap(([l, ps]) => ps.map((p) => ({ ...p, license: p.license ?? l })));
    const unknown = all.filter((p) => !p.license || /unknown|unlicensed/i.test(p.license));
    const copyleft = all.filter((p) => COPYLEFT.test(p.license));
    items.push(item(unknown.length ? "FAIL" : "PASS", `npm: ${all.length} packages, ${Object.keys(byLic).length} licences (${Object.keys(byLic).join(", ")})${unknown.length ? `, ${unknown.length} without a licence` : ""}`, unknown.map((p) => `${p.name}@${p.versions.join(",")}`)));
    if (copyleft.length) items.push(item("NEEDS-MAINTAINER", `npm: ${copyleft.length} copyleft or weak-copyleft packages`, copyleft.map((p) => `${p.name}@${p.versions.join(",")}: ${p.license}`)));
    const prod = run("pnpm", ["licenses", "list", "--json", "--prod"]);
    if (prod.code === 0) shipped.push(...Object.values(JSON.parse(prod.stdout) as Record<string, { name: string }[]>).flat().map((p) => p.name));
    notices.push("## npm packages", "", "| Package | Version | Licence |", "|---|---|---|", ...all.sort((a, b) => a.name.localeCompare(b.name)).map((p) => `| ${p.name} | ${p.versions.join(", ")} | ${p.license} |`), "");
  }

  // Rust crates
  for (const f of cargoToml) {
    const m = run("cargo", ["metadata", "--format-version", "1", "--manifest-path", f, "--locked"], { timeoutMs: 600_000 });
    if (m.code !== 0) { items.push(item(m.error ? "SKIP" : "FAIL", `cargo metadata for ${f} failed${m.error ? " (cargo not installed?)" : ""}`, [m.out.split("\n").slice(-3).join(" ")])); continue; }
    const meta = JSON.parse(m.stdout) as { packages: { name: string; version: string; license: string | null; license_file: string | null; source: string | null }[] };
    const deps = meta.packages.filter((p) => p.source); // registry and git crates, not the workspace's own
    const none = deps.filter((p) => !p.license && !p.license_file);
    const copyleft = deps.filter((p) => p.license && COPYLEFT.test(p.license) && !/\bOR\b/.test(p.license));
    items.push(item(none.length ? "FAIL" : "PASS", `Rust (${f}): ${deps.length} crates${none.length ? `, ${none.length} without a licence` : ", every one with a licence"}`, none.map((p) => `${p.name} ${p.version}`)));
    if (copyleft.length) items.push(item("NEEDS-MAINTAINER", `Rust (${f}): ${copyleft.length} copyleft crates (no permissive alternative in their licence expression)`, copyleft.map((p) => `${p.name} ${p.version}: ${p.license}`)));
    if (f === "engine/Cargo.toml") shipped.push(...deps.map((p) => p.name));
    notices.push(`## Rust crates (${f})`, "", "| Crate | Version | Licence |", "|---|---|---|", ...deps.sort((a, b) => a.name.localeCompare(b.name)).map((p) => `| ${p.name} | ${p.version} | ${p.license ?? `see ${p.license_file}`} |`), "");
  }

  // Vendored sources and bundled fonts
  const vendored = fs.existsSync(path.join(ROOT, "vendor")) ? fs.readdirSync(path.join(ROOT, "vendor")) : [];
  for (const v of vendored) {
    const has = ["LICENSE", "LICENSE.md", "LICENSE.txt", "COPYING"].some((f) => fs.existsSync(path.join(ROOT, "vendor", v, f)));
    items.push(item(has ? "PASS" : "FAIL", `vendor/${v}: ${has ? "carries its licence" : "no licence file"}`));
  }
  const fonts = git("ls-files", "*.ttf", "*.otf", "*.woff", "*.woff2").split("\n").filter(Boolean);
  if (fonts.length) items.push(item("NEEDS-MAINTAINER", `${fonts.length} font files are tracked: each needs a licence that allows redistribution, named in the notices`, fonts));
  const notice = ["THIRD_PARTY_NOTICES.md", "NOTICE", "NOTICE.md"].find((f) => fs.existsSync(path.join(ROOT, f)));
  const draft = path.join(c.out, "THIRD_PARTY_NOTICES.draft.md");
  fs.writeFileSync(draft, notices.join("\n"));
  if (!notice) items.push(item("FAIL", `no third-party notices file (README links THIRD_PARTY_NOTICES.md); a generated draft is at ${rel(draft)}`));
  else {
    const text = fs.readFileSync(path.join(ROOT, notice), "utf8");
    const missing = [...new Set(shipped)].filter((n) => !new RegExp(`(^|[^A-Za-z0-9_-])${escapeRe(n)}([^A-Za-z0-9_-]|$)`).test(text)).sort();
    items.push(missing.length ? item("FAIL", `${notice} leaves out ${missing.length} of the ${new Set(shipped).size} shipped packages (npm runtime and the engine's crates); a generated list to start from is at ${rel(draft)}`, missing) : item("PASS", `${notice} names every shipped package`));
  }
  return items;
}

// ---------------------------------------------------------------- 3, 4, 5. tests that carry the promises

function testCheck(files: string[], env: Record<string, string> = {}, opts: { summarize?: boolean } = {}): Item[] {
  const r = nodeTests(files, env);
  if (!r.tests.length) return [item("FAIL", `${files.join(", ")} did not run`, [r.out.slice(-800)])];
  // A describe() prints its own ok line after its tests' (deeper) lines: those are suites, not tests.
  const tests = r.tests.filter((t, i) => !(i > 0 && r.tests[i - 1].depth > t.depth));
  const failed = tests.filter((t) => !t.ok);
  if (opts.summarize) {
    return [item(failed.length || r.code ? "FAIL" : "PASS", `${tests.length - failed.length}/${tests.length} cases pass (${files.join(", ")})`, failed.map((t) => `${t.name}: ${t.error ?? "failed"}`))];
  }
  const items = tests.map((t) => item(t.ok ? "PASS" : "FAIL", t.name, t.ok ? undefined : [t.error ?? "failed"]));
  if (r.code !== 0 && !failed.length) items.push(item("FAIL", `node --test exited ${r.code}`, [r.out.slice(-800)]));
  return items;
}

function security(): Item[] {
  const items: Item[] = [];
  const src = fs.readFileSync(path.join(ROOT, "src", "server.ts"), "utf8");
  const listens = [...src.matchAll(/\.listen\(([^)]*)\)/g)].map((m) => m[1]);
  items.push(listens.length && listens.every((a) => a.includes(`"127.0.0.1"`)) ? item("PASS", `every listen() in src/server.ts binds 127.0.0.1 (${listens.length})`) : item("FAIL", "a listen() in src/server.ts does not bind 127.0.0.1", listens));
  return [...items, ...testCheck(["test/release-security.test.ts"])];
}

function agentLimits(): Item[] {
  const items: Item[] = [];
  const ar = fs.readFileSync(path.join(ROOT, "src", "agent-run.ts"), "utf8");
  const va = fs.readFileSync(path.join(ROOT, "src", "variations.ts"), "utf8");
  const has = (s: string, re: RegExp) => re.test(s);
  items.push(has(ar, /OUTPUT_MAX = 20 \* 1024 \* 1024/) && has(va, /total > OUTPUT_MAX/) ? item("PASS", "output cap (20 MB) in talk-to-the-selection and variations runs") : item("FAIL", "output cap missing in src/agent-run.ts or src/variations.ts"));
  items.push(has(ar, /kill\(a, "timeout"\), Math\.max\(1000, runCapMs\(\)/) && has(va, /kill\(a, "timeout"\), Math\.max\(1000, runCapMs\(\)/) ? item("PASS", "time cap (Settings > Agents, 1 to 60 min, 10 by default) in both kinds of run") : item("FAIL", "time cap missing in src/agent-run.ts or src/variations.ts"));
  items.push(has(ar, /--tools", w \? "Skill,WebSearch" : ""/) && has(ar, /--strict-mcp-config/) && has(ar, /sandbox_mode="read-only"/) ? item("PASS", "tool allowlist: Canvas MCP only (variations: plus Skill and WebSearch), read-only Codex sandbox") : item("FAIL", "tool allowlist flags changed in src/agent-run.ts"));
  return [...items, ...testCheck(["test/release-agent-limits.test.ts", "test/agent-run.test.ts", "test/agent-run-hunt.test.ts"], {}, { summarize: false }).filter((i) => i.status !== "PASS" || /limit|cap|allowlist|runs at once|only Canvas|read-only|Codex:|Claude Code:/i.test(i.text))];
}

// ---------------------------------------------------------------- 7. document formats

async function migration(): Promise<Item[]> {
  const items = testCheck(["test/docfile-canvas.test.ts", "test/canvas-doc.test.ts"], {}, { summarize: true });
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "canvas-release-migrate-")));
  let srv: Scratch | undefined;
  const doc = (name: string) => JSON.stringify({ version: "2.21", children: [{ type: "frame", id: "B1", name, x: 0, y: 0, width: 10, height: 10, children: [] }] }, null, 2);
  const get = async (file: string) => { const r = await fetch(`${srv!.base}/api/doc?file=${encodeURIComponent(file)}`); return { status: r.status, body: await r.json().catch(() => null) as { boards?: { name?: string }[] } | null }; };
  const rename = (file: string, name: string) => fetch(`${srv!.base}/api/update`, { method: "POST", headers: { "x-canvas": "1", "content-type": "application/json" }, body: JSON.stringify({ file, id: "B1", props: { name } }) });
  const flush = (file: string) => fetch(`${srv!.base}/api/flush`, { method: "POST", headers: { "x-canvas": "1", "content-type": "application/json" }, body: JSON.stringify({ file }) });
  try {
    srv = await startServer(dir);
    // A package: document.json and widgets.json inside.
    const pkg = path.join(dir, "Doc.canvas");
    fs.mkdirSync(pkg);
    fs.writeFileSync(path.join(pkg, "document.json"), doc("Package"));
    fs.writeFileSync(path.join(pkg, "widgets.json"), JSON.stringify({ version: 1, widgets: [] }));
    const a = await get(pkg);
    items.push(a.status === 200 && a.body?.boards?.[0]?.name === "Package" ? item("PASS", "a .canvas package opens") : item("FAIL", `package: status ${a.status}`));
    await rename(pkg, "Edited");
    await flush(pkg);
    const after = JSON.parse(fs.readFileSync(path.join(pkg, "document.json"), "utf8"));
    items.push(after.children[0].name === "Edited" ? item("PASS", "an edit to the package lands in document.json") : item("FAIL", "the edit did not land in document.json"));
    // A single-file document with its sidecar.
    const single = path.join(dir, "Single.canvas.json");
    fs.writeFileSync(single, doc("Single"));
    fs.writeFileSync(path.join(dir, "Single.widgets.json"), JSON.stringify({ version: 1, widgets: [{ id: "n1", kind: "note", x: 0, y: 0, w: 100, h: 100, config: { text: "hi" } }] }));
    const b = await get(single);
    const w = await fetch(`${srv.base}/api/widgets?file=${encodeURIComponent(single)}`).then((r) => r.json()).catch(() => null) as { widgets?: unknown[] } | null;
    items.push(b.status === 200 && b.body?.boards?.[0]?.name === "Single" ? item("PASS", "a single-file .canvas.json opens") : item("FAIL", `single-file .canvas.json: status ${b.status}`));
    items.push(Array.isArray(w?.widgets) && w!.widgets!.length === 1 ? item("PASS", "its sidecar widgets (foo.widgets.json) come along") : item("FAIL", "the single file's sidecar widgets did not load", [JSON.stringify(w).slice(0, 200)]));
    // Save As turns it into a package.
    const target = path.join(dir, "Converted.canvas");
    const sa = await fetch(`${srv.base}/api/canvas/save-as`, { method: "POST", headers: { "x-canvas": "1", "content-type": "application/json" }, body: JSON.stringify({ file: single, target }) });
    items.push(sa.status === 200 && fs.existsSync(path.join(target, "document.json")) && fs.existsSync(path.join(target, "widgets.json")) ? item("PASS", "Save as Canvas makes a package from a single .canvas.json (design and widgets)") : item("FAIL", `Save As from .canvas.json: ${sa.status}`));
  } catch (e) {
    items.push(item("FAIL", `migration check failed: ${(e as Error).message}`));
  } finally {
    await srv?.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
  return items;
}

// ---------------------------------------------------------------- 8. accessibility

type RGBA = [number, number, number, number];
function parseColor(v: string, vars: Record<string, string>, depth = 0): RGBA {
  v = v.trim();
  if (depth > 8) throw new Error(`colour loop at ${v}`);
  const ref = v.match(/^var\(--c-([a-z-]+)\)$/);
  if (ref) {
    const key = ref[1].replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    return parseColor(vars[key], vars, depth + 1);
  }
  if (v === "transparent") return [0, 0, 0, 0];
  const hex = v.match(/^#([0-9a-f]{3,8})$/i);
  if (hex) {
    let h = hex[1];
    if (h.length <= 4) h = [...h].map((c) => c + c).join("");
    const n = (i: number) => parseInt(h.slice(i, i + 2), 16) / 255;
    return [n(0), n(2), n(4), h.length === 8 ? n(6) : 1];
  }
  const mix = v.match(/^color-mix\(in srgb,\s*(.+?)(?:\s+(\d+)%)?,\s*(.+?)(?:\s+(\d+)%)?\)$/);
  if (mix) {
    const a = parseColor(mix[1], vars, depth + 1), b = parseColor(mix[3], vars, depth + 1);
    const pb = mix[4] ? Number(mix[4]) / 100 : mix[2] ? 1 - Number(mix[2]) / 100 : 0.5;
    const pa = 1 - pb;
    const alpha = a[3] * pa + b[3] * pb;
    const ch = (i: number) => (alpha ? (a[i] * a[3] * pa + b[i] * b[3] * pb) / alpha : 0);
    return [ch(0), ch(1), ch(2), alpha];
  }
  throw new Error(`cannot read colour ${v}`);
}
const over = (top: RGBA, bottom: RGBA): RGBA => [0, 1, 2].map((i) => top[i] * top[3] + bottom[i] * (1 - top[3])).concat(1) as RGBA;
const lum = (c: RGBA) => {
  const f = (x: number) => (x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4);
  return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]);
};
const contrast = (a: RGBA, b: RGBA) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };

async function accessibility(): Promise<Item[]> {
  const { TOKENS } = await import("../src/tokens.ts");
  const items: Item[] = [];
  // [text or mark, on (stacked bottom to top), minimum, what]
  const PAIRS: [string, string[], number, string][] = [
    ["fg", ["canvasBg"], 4.5, "text on the canvas"],
    ["fg", ["sidebar"], 4.5, "text in the sidebar"],
    ["sidebarFg", ["sidebar"], 4.5, "sidebar text"],
    ["fg", ["popover"], 4.5, "text on popovers"],
    ["fg", ["popover", "island"], 4.5, "text on islands"],
    ["fg", ["sidebar", "rowSelected"], 4.5, "a selected row's text"],
    ["fg", ["sidebar", "hover"], 4.5, "a hovered row's text"],
    ["fg", ["popover", "field"], 4.5, "text in a field"],
    ["mutedFg", ["canvasBg"], 4.5, "secondary text on the canvas"],
    ["mutedFg", ["sidebar"], 4.5, "secondary text in the sidebar"],
    ["mutedFg", ["popover"], 4.5, "secondary text on popovers"],
    ["mutedFg", ["popover", "island"], 4.5, "secondary text on islands"],
    ["mutedFg", ["muted"], 4.5, "secondary text on muted fills"],
    ["placeholder", ["popover", "field"], 4.5, "placeholder text in a field"],
    ["primaryFg", ["primary"], 4.5, "text on a primary button"],
    ["danger", ["popover"], 4.5, "error text on popovers"],
    ["#ffffff", ["dangerFill"], 4.5, "white text on a danger fill (note errors)"],
    ["#ffffff", ["canvasBg", "tooltip"], 4.5, "tooltip text"],
    ["sel", ["canvasBg"], 3, "selection outline on the canvas (non-text)"],
    ["component", ["canvasBg"], 3, "component outline on the canvas (non-text)"],
  ];
  for (const theme of ["light", "dark"] as const) {
    const vars = TOKENS[theme] as Record<string, string>;
    const col = (k: string) => parseColor(k.startsWith("#") ? k : vars[k], vars);
    const failed: string[] = [], passed: string[] = [];
    for (const [fg, stack, min, what] of PAIRS) {
      let bg: RGBA = [1, 1, 1, 1];
      for (const layer of stack) bg = over(col(layer), bg);
      const ratio = contrast(over(col(fg), bg), bg);
      const line = `${what}: ${fg} on ${stack.join(" + ")} = ${ratio.toFixed(2)}:1 (needs ${min})`;
      (ratio + 1e-9 >= min ? passed : failed).push(line);
    }
    items.push(item(failed.length ? "FAIL" : "PASS", `${theme} theme: ${passed.length}/${PAIRS.length} colour pairs pass WCAG AA`, failed.length ? failed : undefined));
  }
  // The Swift tokens are generated from src/tokens.ts: the hex values must match.
  const swift = fs.readFileSync(path.join(ROOT, "apps/macos/DesignSystem/Tokens.generated.swift"), "utf8").toUpperCase();
  const missing: string[] = [];
  for (const theme of ["light", "dark"] as const) for (const [k, v] of Object.entries(TOKENS[theme] as Record<string, string>)) {
    const m = v.match(/^#([0-9a-f]{6})/i);
    if (m && !swift.includes(`0X${m[1].toUpperCase()}`)) missing.push(`${theme}.${k} ${v}`);
  }
  items.push(missing.length ? item("FAIL", "apps/macos/DesignSystem/Tokens.generated.swift is out of step with src/tokens.ts: run pnpm tokens", missing) : item("PASS", "the native shell's colour tokens match src/tokens.ts"));
  items.push(item("MANUAL", "VoiceOver reaches every control in the chrome (cannot run without the app and a person)", [
    "Open Canvas.app with demos/learn.canvas. Turn on VoiceOver: Cmd+F5.",
    "Press VO+U (Control+Option+U) and open the Window Spots and Form Controls rotors: every toolbar island, the rail, the Layers panel, the inspector and the Pages list must be listed by a name that says what it is (no 'button', 'image' or a raw SF Symbol name).",
    "From the window's top, press VO+Right Arrow repeatedly through the whole window: every button, field, list row and tab in the chrome is reached and read with its label and value; nothing is skipped and focus never gets stuck in the web view.",
    "In the inspector, VO+Space on a numeric field, type a value, Return: VoiceOver reads the new value.",
    "Open Cmd+K (Quick Actions), type a word: the result count is announced and arrows read each row; Esc closes it and focus returns to where it was.",
    "Open Settings (Cmd+,): every tab and control is reachable and labelled.",
    "Talk to the selection: select a layer, Cmd+Return opens the composer; VoiceOver reads its field and the Send control.",
    "Note every control that is not reached or reads badly; each becomes a test in apps/macos/Tests or the native QA bridge.",
  ]));
  return items;
}

// ---------------------------------------------------------------- 9. fresh install

async function freshInstall(c: Ctx): Promise<Item[]> {
  const items: Item[] = [];
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "canvas-release-clone-")));
  const clone = path.join(tmp, "canvas");
  const head = git("rev-parse", "HEAD").trim();
  const dirty = git("status", "--porcelain", "--untracked-files=no").trim();
  if (dirty) items.push(item("NEEDS-MAINTAINER", "the working tree has uncommitted changes: the clone tests HEAD only, not them"));
  let proc: ReturnType<typeof spawn> | undefined;
  try {
    const cl = run("git", ["clone", "--quiet", "--no-hardlinks", ROOT, clone]);
    const co = cl.code === 0 ? run("git", ["-C", clone, "checkout", "--quiet", head]) : cl;
    if (co.code !== 0) return [item("FAIL", "git clone of HEAD failed", [co.out.slice(-400)])];
    items.push(item("PASS", `cloned HEAD ${head.slice(0, 9)} into a temp folder (${fs.readdirSync(clone).length} entries)`));
    const [maj, min] = process.versions.node.split(".").map(Number);
    items.push(maj > 22 || (maj === 22 && min >= 18) ? item("PASS", `README "Node 22.18 or later": this Node is ${process.versions.node}`) : item("FAIL", `Node ${process.versions.node} is older than the README asks for`));
    const pnpmV = run("pnpm", ["--version"]);
    items.push(pnpmV.code === 0 ? item("PASS", `README "pnpm": ${pnpmV.stdout.trim()}`) : item("FAIL", "pnpm is not installed"));
    const inst = run("pnpm", ["install", "--frozen-lockfile"], { cwd: clone, timeoutMs: 600_000 });
    items.push(inst.code === 0 ? item("PASS", "README step: pnpm install --frozen-lockfile") : item("FAIL", "README step: pnpm install --frozen-lockfile failed", inst.out.split("\n").slice(-8)));
    if (inst.code !== 0) return items;
    // pnpm start "$PWD/demos/learn.canvas", word for word, on a free port.
    const sample = path.join(clone, "demos", "learn.canvas");
    const port = await freePort();
    const log: string[] = [];
    proc = spawn("pnpm", ["start", sample], { cwd: clone, env: { ...process.env, CANVAS_PORT: String(port), CANVAS_ROOTS: tmp, CANVAS_WEB_FONTS: "0", CANVAS_MCP_NO_SPAWN: "1", CANVAS_STATE_DIR: path.join(tmp, ".canvas-state"), CANVAS_TRUST_FILE: path.join(tmp, ".trust.json") }, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    proc.stdout!.on("data", (d) => log.push(String(d)));
    proc.stderr!.on("data", (d) => log.push(String(d)));
    let up = false;
    for (let t = Date.now(); Date.now() - t < 30_000 && !up; await sleep(200)) up = await fetch(`http://127.0.0.1:${port}/health`).then((r) => r.ok, () => false);
    const docOk = up && (await fetch(`http://127.0.0.1:${port}/api/doc?file=${encodeURIComponent(sample)}`).then((r) => r.ok, () => false));
    const page = up && (await fetch(`http://127.0.0.1:${port}/`).then((r) => r.ok, () => false));
    const printed = log.join("").match(/https?:\/\/127\.0\.0\.1:\d+\S*/)?.[0];
    items.push(up && docOk && page ? item("PASS", `README step: pnpm start "$PWD/demos/learn.canvas" serves the page and the course${printed ? ` (printed ${printed})` : ""}`) : item("FAIL", "README step: pnpm start with the sample did not serve it", log.join("").split("\n").slice(-8)));
    const wasm = up && (await fetch(`http://127.0.0.1:${port}/engine/canvas_engine_bg.wasm`).then((r) => r.ok, () => false));
    // A fresh clone has no engine/pkg (git ignores it): fine when the README says so, and how to build it.
    const cloneReadme = fs.readFileSync(path.join(clone, "README.md"), "utf8");
    const buildScript = JSON.parse(fs.readFileSync(path.join(clone, "package.json"), "utf8")).scripts?.["build:engine"] as string | undefined;
    const readmeSays = /engine\/pkg/.test(cloneReadme) && /DOM\) renderer|DOM renderer/.test(cloneReadme) && /pnpm build:engine/.test(cloneReadme) && /engine\/build\.sh/.test(buildScript ?? "");
    items.push(wasm ? item("PASS", "the clone serves the WASM engine")
      : readmeSays ? item("PASS", "a fresh clone has no engine/pkg (ignored by git) and draws with the DOM renderer; the README says so and how to build it (pnpm build:engine runs engine/build.sh)")
      : item("FAIL", "a fresh clone has no engine/pkg (it is ignored by git), so the browser falls back to the DOM renderer until engine/build.sh runs; the README's browser step does not say so, or package.json has no build:engine script"));
    try { process.kill(-proc.pid!, "SIGTERM"); } catch {}
    await sleep(500);
    try { process.kill(-proc.pid!, "SIGKILL"); } catch {}
    proc = undefined;
    // Engine toolchain (README: Rust, the wasm32-unknown-unknown target and wasm-bindgen-cli).
    const pin = fs.readFileSync(path.join(clone, "engine", "Cargo.toml"), "utf8").match(/wasm-bindgen = "=([\d.]+)"/)?.[1];
    const cargo = run("cargo", ["--version"]), target = run("rustup", ["target", "list", "--installed"]), wb = run("wasm-bindgen", ["--version"]);
    const ok = cargo.code === 0 && target.stdout.includes("wasm32-unknown-unknown") && wb.stdout.includes(pin ?? "?");
    items.push(ok ? item("PASS", `engine toolchain present: ${cargo.stdout.trim()}, wasm32 target, wasm-bindgen ${pin}`) : item("FAIL", "engine toolchain incomplete", [cargo.stdout.trim() || "no cargo", target.stdout.includes("wasm32") ? "wasm32 target ok" : "no wasm32 target", wb.stdout.trim() || "no wasm-bindgen"]));
    if (ok && !c.quick) {
      const b = run(path.join(clone, "engine", "build.sh"), [], { cwd: clone, timeoutMs: 1_800_000 });
      items.push(b.code === 0 && fs.existsSync(path.join(clone, "engine", "pkg", "canvas_engine_bg.wasm")) ? item("PASS", "README step: engine/build.sh builds engine/pkg in the clone") : item("FAIL", "README step: engine/build.sh failed in the clone", b.out.split("\n").slice(-8)));
    } else if (ok) items.push(item("SKIP", "engine/build.sh not run with --quick (several minutes)"));
    const t = run("pnpm", ["test"], { cwd: clone, timeoutMs: 900_000 });
    const sum = (k: string) => t.out.match(new RegExp(`ℹ ${k} (\\d+)`))?.[1];
    items.push(t.code === 0 ? item("PASS", `pnpm test in the clone: ${sum("pass")} pass`) : item("FAIL", `pnpm test in the clone: ${sum("fail") ?? "?"} fail of ${sum("tests") ?? "?"}`, t.out.split("\n").filter((l) => /^not ok|# Subtest|✖/.test(l)).slice(0, 20)));
    items.push(item("MANUAL", "README step: apps/macos/build.sh, then open apps/macos/Canvas.app (needs Xcode Command Line Tools and a signing identity; not run here so the maintainer's app is never touched)", [
      "On a fresh macOS user account: git clone the public repo, cd into it.",
      "pnpm install --frozen-lockfile; apps/macos/build.sh; open apps/macos/Canvas.app.",
      "The app should start its server and open; File > Open demos/learn.canvas shows the course boards.",
    ]));
  } finally {
    if (proc?.pid) { try { process.kill(-proc.pid, "SIGKILL"); } catch {} }
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  return items;
}

// ---------------------------------------------------------------- 10. docs claims

async function listMcpTools(): Promise<string[]> {
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { StdioClientTransport } = await import("@modelcontextprotocol/sdk/client/stdio.js");
  const t = new StdioClientTransport({ command: process.execPath, args: [path.join(ROOT, "mcp", "server.ts")], env: { ...process.env, CANVAS_MCP_NO_SPAWN: "1", CANVAS_MCP_NO_APP: "1", CANVAS_PORT: "1" } as Record<string, string>, stderr: "ignore" });
  const c = new Client({ name: "qa-release", version: "1" });
  await c.connect(t);
  try {
    return (await c.listTools()).tools.map((x) => x.name);
  } finally {
    await c.close();
  }
}

const slug = (h: string) => h.trim().toLowerCase().replace(/[^\p{L}\p{N} _-]/gu, "").replace(/ /g, "-");

async function docsClaims(): Promise<Item[]> {
  const items: Item[] = [];
  const readme = fs.readFileSync(path.join(ROOT, "README.md"), "utf8");
  const guide = fs.readFileSync(path.join(ROOT, "docs", "developer-guide.md"), "utf8");
  const read = (f: string) => fs.readFileSync(path.join(ROOT, f), "utf8");
  const claim = (ok: boolean, text: string, why?: string) => items.push(item(ok ? "PASS" : "FAIL", text, ok || !why ? undefined : [why]));

  // Links and the files they name.
  for (const [, target] of readme.matchAll(/\]\(([^)\s]+)\)/g)) {
    if (/^https?:/.test(target)) continue;
    const [file, anchor] = target.split("#");
    const f = path.join(ROOT, file);
    if (!fs.existsSync(f)) { claim(false, `README link ${target}`, `${file} does not exist`); continue; }
    if (fs.statSync(f).isDirectory()) { claim(true, `README link ${target}`); continue; }
    if (anchor) {
      const heads = fs.readFileSync(f, "utf8").split("\n").filter((l) => /^#{1,6} /.test(l)).map((l) => slug(l.replace(/^#+ /, "")));
      claim(heads.includes(anchor), `README link ${target}`, `no heading #${anchor} in ${file}`);
    } else claim(true, `README link ${target}`);
  }
  for (const f of ["demos/learn.canvas/document.json", "engine/build.sh", "apps/macos/build.sh"]) claim(fs.existsSync(path.join(ROOT, f)), `README names ${f.replace("/document.json", "")}: it exists`, "missing");

  // Numbers.
  // The tools as an agent sees them: canvas-mcp started over stdio and asked (tools/list).
  const toolNames = new Set(await listMcpTools());
  const said = Number(readme.match(/gives agents (\d+) tools/)?.[1]);
  claim(said === toolNames.size, `README "Canvas MCP gives agents ${said} tools": tools/list answers ${toolNames.size}`, `canvas-mcp lists ${toolNames.size}`);
  const listed = new Set([...(guide.split("### Tools")[1] ?? "").split("\n## ")[0].matchAll(/`([a-z_]+)`/g)].map((m) => m[1]));
  const unlisted = [...toolNames].filter((t) => !listed.has(t)), ghost = [...listed].filter((t) => !toolNames.has(t) && /_/.test(t) && !/^(no|stale|not|client|invalid)_/.test(t));
  claim(!unlisted.length && !ghost.length, "developer guide's tool table lists exactly the registered tools", [...unlisted.map((t) => `not in the table: ${t}`), ...ghost.map((t) => `in the table, not registered: ${t}`)].join("; "));
  const engines = JSON.parse(read("package.json")).engines?.node as string | undefined;
  claim(!!engines && readme.includes(`Node ${engines.replace(">=", "")} or later`), `README "Node 22.18 or later" matches package.json engines (${engines})`, `package.json engines: ${engines}`);
  const count = read("src/variations.ts").match(/export const COUNT = (\d+)/)?.[1];
  claim(count === "3" && /three variations/i.test(readme), "README: Shift+Cmd+Return makes three variations", `src/variations.ts COUNT = ${count}`);

  // Shortcuts named in the README.
  const page = (f: string) => read(`src/page/${f}`);
  claim(/e\.key !== "Enter" \|\| !\(e\.metaKey \|\| e\.ctrlKey\) \|\| !e\.shiftKey/.test(page("variations.js")), "README: Shift+Cmd+Return starts variations (src/page/variations.js)");
  claim(/Digit2: "fitSelection"/.test(page("shortcuts-logic.js")), "README: Shift+2 zooms to the selection (src/page/shortcuts-logic.js)");
  claim(/e\.code === "KeyK" && !e\.shiftKey\) \{ e\.preventDefault\(\); setScaleMode/.test(page("live.js")), "README: K scales a layer with its contents (src/page/live.js)");
  claim(/function movePointer\(e, copy = host\.optionForDrag\(e\)\)/.test(read("src/server.ts")), "README: Option-drag duplicates (src/server.ts page script)");

  // Architecture claims.
  const cargo = read("engine/Cargo.toml");
  claim(["taffy", "parley", "vello"].every((c) => new RegExp(`^${c}\\s*=`, "m").test(cargo)), "README: the engine uses Taffy, Parley and Vello (engine/Cargo.toml)");
  claim(/using the DOM renderer/.test(read("src/page/engine-view.js") + read("src/server.ts")), 'README: "Without WebGPU, Canvas falls back to an HTML renderer"');
  claim([...read("src/server.ts").matchAll(/\.listen\(([^)]*)\)/g)].every((m) => m[1].includes(`"127.0.0.1"`)), 'README: "It listens on your machine only"');
  claim(fs.readdirSync(path.join(ROOT, "src", "widgets")).some((f) => /keychain/i.test(f)) && /security/.test(fs.readdirSync(path.join(ROOT, "src", "widgets")).filter((f) => /keychain/i.test(f)).map((f) => read(`src/widgets/${f}`)).join("")), 'README: "Secrets stay in the macOS Keychain" (src/widgets uses the security tool)');
  if (/has no public license/i.test(readme)) items.push(item("NEEDS-MAINTAINER", 'README says "Canvas itself has no public license": change it with the licence choice'));

  // Environment variables: every CANVAS_* the code reads is in the guide's table, and the other way round.
  const code = git("ls-files", "src", "mcp", "apps/macos").split("\n").filter((f) => /\.(ts|js|swift|sh)$/.test(f)).map((f) => { try { return read(f); } catch { return ""; } }).join("\n");
  const used = new Set([...code.matchAll(/\b(CANVAS_[A-Z_]+)\b/g)].map((m) => m[1]));
  const table = new Set([...(guide.split("## Environment variables")[1] ?? "").split("\n## ")[0].matchAll(/`(CANVAS_[A-Z_]+)`/g)].map((m) => m[1]));
  const notDocumented = [...used].filter((v) => !table.has(v) && !guide.includes(v));
  const notUsed = [...table].filter((v) => !used.has(v));
  claim(!notUsed.length, "every environment variable in the developer guide is read by the code", notUsed.join(", "));
  if (notDocumented.length) items.push(item("FAIL", `environment variables read by the code but not in the developer guide: ${notDocumented.length}`, notDocumented.sort()));
  return items;
}

// ---------------------------------------------------------------- long suites

function suite(name: string, script: string, timeoutMs: number) {
  return (c: Ctx): Item[] => {
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
    if (!pkg.scripts?.[script]) return [item("SKIP", `pnpm ${script} is not defined yet`)];
    const t0 = Date.now();
    const r = run("pnpm", [script], { timeoutMs });
    const log = path.join(c.out, `${script.replace(/:/g, "-")}.log`);
    fs.writeFileSync(log, r.out);
    return [item(r.code === 0 ? "PASS" : "FAIL", `pnpm ${script} ${r.code === 0 ? "passed" : `exited ${r.code}`} in ${Math.round((Date.now() - t0) / 1000)} s (log: ${rel(log)})`, r.code === 0 ? undefined : r.out.split("\n").filter(Boolean).slice(-10))];
  };
}

function performanceGate(c: Ctx): Item[] {
  const args = c.quick ? ["--only", WEB_METRICS.join(",")] : [];
  const r = run("pnpm", ["perf:gate", ...args], { timeoutMs: 1_800_000 });
  const log = path.join(c.out, "perf-gate.log");
  fs.writeFileSync(log, r.out);
  const items = r.stdout.split("\n").flatMap((line) => {
    const result = /^(PASS|FAIL|NEEDS-MAINTAINER|SKIP) (.+)$/.exec(line);
    return result ? [item(result[1] as Status, result[2])] : [];
  });
  if (r.error || !items.length || (r.code !== 0 && r.code !== 2 && !items.some((i) => i.status === "FAIL"))) {
    items.push(item("FAIL", `pnpm perf:gate failed (exit ${r.code})`, r.out.split("\n").filter(Boolean).slice(-5)));
  }
  const timing = r.stdout.split("\n").find((line) => line.startsWith("Performance gate finished"));
  if (timing) items.push(item("PASS", `${timing} Log: ${rel(log)}`));
  return items;
}

// ---------------------------------------------------------------- the list

const CHECKS: Check[] = [
  { id: "scrub", title: "1. No secrets, personal paths, private names or customer data in the repo or its history", run: scrub },
  { id: "licence", title: "2. Licence and third-party notices", run: licence },
  { id: "security", title: "3. The server listens on localhost only, checks origins, writes only inside its documents", run: security },
  { id: "agent", title: "4. Agent runs keep their tool allowlist, time and size limits", run: agentLimits },
  { id: "fuzz", title: "5. Malformed and hostile .canvas packages (fuzzed)", run: (c) => testCheck(["test/fuzz-canvas.test.ts"], { FUZZ_N: c.quick ? "24" : "300" }, { summarize: true }) },
  { id: "crash", title: "6. A crash during save loses nothing (kill -9)", run: (c) => crashCheck({ rounds: c.quick ? 4 : 12 }) },
  { id: "migration", title: "7. Document formats open, save and convert", run: migration },
  { id: "a11y", title: "8. Contrast passes AA; VoiceOver reaches the chrome", run: accessibility },
  { id: "install", title: "9. Fresh install from a clone, following the README", run: freshInstall },
  { id: "docs", title: "10. README and docs claims match the code", run: docsClaims },
  { id: "perf", title: "11. Performance stays within its budgets", run: performanceGate },
];
const SUITES: Check[] = [
  { id: "test", title: "pnpm test", run: suite("test", "test", 900_000) },
  { id: "qa", title: "pnpm qa", run: suite("qa", "qa", 1_800_000) },
  { id: "matrix", title: "pnpm qa:matrix", run: suite("matrix", "qa:matrix", 3_600_000) },
  { id: "coverage", title: "pnpm qa:coverage", run: suite("coverage", "qa:coverage", 600_000) },
  { id: "native", title: "pnpm qa:native", run: suite("native", "qa:native", 1_800_000) },
  { id: "bench", title: "pnpm bench", run: suite("bench", "bench", 3_600_000) },
];

async function main() {
  const argv = process.argv.slice(2);
  const quick = argv.includes("--quick");
  const oi = argv.indexOf("--only");
  const only = oi >= 0 ? (argv[oi + 1] ?? "").split(",").filter(Boolean) : null;
  const all = [...CHECKS, ...SUITES];
  if (only) for (const o of only) if (!all.some((c) => c.id === o)) throw new Error(`unknown check ${o}; one of ${all.map((c) => c.id).join(", ")}`);
  const list = only ? all.filter((c) => only.includes(c.id)) : quick ? CHECKS : all;
  fs.mkdirSync(OUT, { recursive: true });
  const ctx: Ctx = { quick, out: OUT };
  const results: { check: Check; items: Item[]; ms: number }[] = [];
  const t0 = Date.now();
  for (const check of list) {
    console.log(`\n${check.title}`);
    const s = Date.now();
    let items: Item[];
    try {
      items = await check.run(ctx);
    } catch (e) {
      items = [item("FAIL", `the check itself failed: ${(e as Error).message}`, (e as Error).stack?.split("\n").slice(1, 4))];
    }
    for (const i of items) {
      console.log(`  ${i.status.padEnd(13)} ${i.text}`);
      for (const d of (i.details ?? []).slice(0, i.status === "PASS" ? 0 : 8)) console.log(`                ${d}`);
      if ((i.details?.length ?? 0) > 8 && i.status !== "PASS") console.log(`                ... ${i.details!.length - 8} more in the report`);
    }
    results.push({ check, items, ms: Date.now() - s });
  }
  const worst = (items: Item[]) => items.reduce<Status>((w, i) => (RANK[i.status] > RANK[w] ? i.status : w), "PASS");
  const counts = (s: Status) => results.flatMap((r) => r.items).filter((i) => i.status === s).length;
  const md = [
    "# Release checklist report",
    "",
    `${new Date().toISOString().replace("T", " ").slice(0, 16)} UTC, commit ${git("rev-parse", "--short", "HEAD").trim()}${quick ? ", --quick" : ""}${only ? `, --only ${only.join(",")}` : ""}, ${Math.round((Date.now() - t0) / 1000)} s.`,
    "",
    "| Check | Result | PASS | FAIL | NEEDS-MAINTAINER | MANUAL |",
    "|---|---|---|---|---|---|",
    ...results.map((r) => `| ${r.check.title} | ${worst(r.items)} | ${["PASS", "FAIL", "NEEDS-MAINTAINER", "MANUAL"].map((s) => r.items.filter((i) => i.status === s).length).join(" | ")} |`),
    "",
    ...results.flatMap((r) => [
      `## ${r.check.title}`,
      "",
      `${worst(r.items)}, ${Math.round(r.ms / 1000)} s.`,
      "",
      ...r.items.flatMap((i) => [`- **${i.status}** ${i.text}`, ...(i.details ?? []).map((d) => `  - \`${d.replace(/`/g, "'")}\``)]),
      "",
    ]),
  ].join("\n");
  const report = path.join(OUT, "report.md");
  fs.writeFileSync(report, md);
  console.log(`\n${counts("PASS")} pass, ${counts("FAIL")} fail, ${counts("NEEDS-MAINTAINER")} need the maintainer, ${counts("MANUAL")} manual in ${Math.round((Date.now() - t0) / 1000)} s`);
  console.log(`report: ${rel(report)}`);
  const perfNeedsMaintainer = results.some(({ check, items }) => check.id === "perf" && items.some((i) => i.status === "NEEDS-MAINTAINER"));
  process.exitCode = counts("FAIL") ? 1 : perfNeedsMaintainer ? 2 : 0;
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
