import { execFile } from "node:child_process";
import { createReadStream, existsSync } from "node:fs";
import { lstat, mkdtemp, readdir, readFile, rm, statfs } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { promisify } from "node:util";
import { chromePath } from "../../doc/render/chrome-path.ts";
import { bad, int, str } from "../check.ts";
import { blockedReason, safeFetch } from "../http.ts";
import { withPreviewProxy } from "../preview-proxy.ts";
import { isSourceApproved, webOrigin } from "../trust.ts";
import { parsePath } from "../jsonpath.ts";
import { ciData, diskData, gitData, metricData, previewData, usageCollector } from "../source-data.ts";
import { SourceApproval, WidgetError, type Config, type Source, type WidgetKind } from "../types.ts";

const exec = promisify(execFile);
function command(name: string, args: string[], cwd?: string, timeout = 10_000) {
  const { PATH, HOME, LANG } = process.env;
  const env: NodeJS.ProcessEnv = { PATH, HOME, LANG, GIT_CONFIG_NOSYSTEM: "1" };
  if (name === "/usr/bin/git") env.GIT_OPTIONAL_LOCKS = "0";
  if (path.basename(name) === "gh") {
    for (const [key, value] of Object.entries(process.env)) {
      if (key.startsWith("GH_") || key === "GITHUB_TOKEN") env[key] = value;
    }
    env.GH_PROMPT_DISABLED = "1";
  }
  return exec(name, args, { cwd, timeout, maxBuffer: 2_000_000, env }).then((r) => r.stdout);
}
const empty = (message: string) => ({ empty: message });
const error = (message: string) => new WidgetError(0, "source-error", message);
const errorCode = (err: unknown) => (err as NodeJS.ErrnoException).code;
const git = (cwd: string, args: string[]) => command("/usr/bin/git", ["-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null", ...args], cwd);
async function gitStatusOutput(cwd: string) {
  // Local repository config can otherwise execute a clean filter when the worktree is read.
  const keys = await git(cwd, ["config", "--includes", "--name-only", "--null", "--list"]);
  const filters = new Set(keys.split("\0").map((key) => /^filter\.(.+)\.(?:clean|smudge|process|required)$/.exec(key)?.[1]).filter(Boolean));
  const overrides = [...filters].flatMap((name) => [
    "-c", "filter." + name + ".clean=", "-c", "filter." + name + ".smudge=",
    "-c", "filter." + name + ".process=", "-c", "filter." + name + ".required=false",
  ]);
  return git(cwd, [...overrides, "status", "--porcelain=v2", "-z", "--branch", "--ahead-behind", "--ignore-submodules=dirty", "--untracked-files=all"]);
}
const folder = (s: string) => s.startsWith("~/") ? path.join(os.homedir(), s.slice(2)) : path.resolve(s);
const gh = (args: string[]) => {
  const bin = ["/opt/homebrew/bin/gh", "/usr/local/bin/gh", "/usr/bin/gh"].find(existsSync) ?? "gh";
  return command(bin, args, os.homedir()).then((out): unknown => JSON.parse(out));
};

function urlConfig(raw: unknown, fallback = "") {
  const val = str(raw, "URL", fallback, 2048).trim();
  if (!val) return val;
  try {
    const u = new URL(val);
    if (["http:", "https:"].includes(u.protocol) && !u.username && !u.password && !blockedReason(u.hostname)) return u.href;
  } catch {}
  throw bad("URL", "must be an HTTP or HTTPS address without credentials");
}

function live(
  info: Omit<WidgetKind, "source" | "defaults" | "minSize"> & { defaults: Config },
  interval: number, fetch: Source["fetch"], approval?: Source["approval"],
): WidgetKind {
  return {
    ...info, defaults: () => ({ ...info.defaults }), minSize: { w: 260, h: 140 },
    source: {
      key: (c) => JSON.stringify(c),
      minIntervalSec: 15,
      intervalSec: (c) => typeof c.refreshSec === "number" ? c.refreshSec : interval,
      fetch, approval,
    },
  };
}

const repoFolder = (c: Config) => typeof c.repo === "string" && c.repo.trim() ? folder(c.repo.trim()) : undefined;
const repoField = { key: "repo", label: "Repository folder", type: "text" } as const;

const gitStatus = live({
  id: "git-status", title: "Git status", description: "Branch and commits",
  cardSubtitle: "Branch and changes",
  symbol: "point.3.connected.trianglepath.dotted",
  defaultSize: { w: 330, h: 252 }, defaults: { repo: "" }, fields: [repoField],
  validate: (c) => ({ ...c, repo: str(c.repo, "Repository folder", "", 2048).trim() }),
}, 60, async ({ widget }) => {
  const cwd = repoFolder(widget.config);
  if (!cwd) return empty("Choose a repository folder in the inspector.");
  const status = await gitStatusOutput(cwd)
    .catch(() => { throw error("Could not read Git status. Check the repository folder."); });
  const log = status.includes("# branch.oid (initial)\0") ? "" :
    await git(cwd, ["log", "-5", "--format=%h%x09%s", "--no-show-signature", "--"]).catch(() => { throw error("Could not read recent commits."); });
  return { content: { git: gitData(status, log) } };
}, { field: "repo", verb: "read", target: repoFolder });

const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const ciSlug = (s: string) => REPO.test(s) && s.split("/").every((part) => part !== "." && part !== "..") ? s.toLowerCase() : undefined;
const ciTarget = (c: Config) => typeof c.repo === "string" ? ciSlug(c.repo.trim()) ?? repoFolder(c) : undefined;
export function repoFromRemote(remote: string) {
  return /^(?:git@github\.com:|https:\/\/github\.com\/|ssh:\/\/git@github\.com\/)([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+?)(?:\.git)?\/?$/.exec(remote.trim())?.[1];
}

const ci = live({
  id: "ci", title: "CI and PRs", description: "Runs and open PRs",
  cardSubtitle: "Builds and reviews",
  symbol: "arrow.triangle.branch",
  defaultSize: { w: 380, h: 310 }, defaults: { repo: "" },
  fields: [{ ...repoField, label: "Repository", help: "Owner/name or a local repository folder with an origin remote." }],
  validate: (c) => ({ ...c, repo: str(c.repo, "Repository", "", 2048).trim() }),
}, 120, async ({ widget }) => {
  const repo = ciTarget(widget.config);
  if (!repo) return empty("Set a repository in the inspector.");
  const resolved = ciSlug(repo) ?? await git(repo, ["remote", "get-url", "origin"]).then(repoFromRemote).catch(() => undefined);
  const slug = resolved && ciSlug(resolved);
  if (!slug) throw error("Use owner/name or a repository folder with a supported origin.");
  // The remote can change independently of the saved folder. Give each resolved repo its own approval.
  if (!isSourceApproved("ci", slug)) throw new SourceApproval(slug, "read");
  const target = "github.com/" + slug;
  try {
    const [runs, pulls] = await Promise.all([
      gh(["run", "list", "-R", target, "--limit", "5", "--json", "databaseId,name,status,conclusion,url"]),
      gh(["pr", "list", "-R", target, "--limit", "15", "--state", "open", "--json", "number,title,url"]),
    ]);
    const jobs = await Promise.all((Array.isArray(runs) ? runs : []).map(async (run) => {
      if (run.conclusion !== "failure" || !Number.isSafeInteger(run.databaseId)) return [];
      const result = await gh(["run", "view", String(run.databaseId), "-R", target, "--json", "jobs"]) as { jobs?: unknown[] };
      return result.jobs;
    }));
    const data = ciData(runs, pulls, jobs);
    return data.runs.length || data.pulls.length ? { content: { ci: data } } : empty("No workflow runs or open pull requests.");
  } catch (err) {
    if (errorCode(err) === "ENOENT") return empty("Install the gh CLI to show workflow runs and pull requests.");
    if (/gh auth login|not logged|authentication token/i.test(String((err as { stderr?: string }).stderr))) return empty("Sign in with gh auth login to load this repository.");
    throw error("Could not read workflow runs and pull requests. Check repository access.");
  }
}, { field: "repo", verb: "read", target: ciTarget });

async function readUsage(root: string, usage: ReturnType<typeof usageCollector>): Promise<void> {
  const info = await lstat(root).catch((err) => {
    if (errorCode(err) === "ENOENT") return null;
    throw err;
  });
  if (!info || info.isSymbolicLink()) return;
  if (info.isDirectory()) {
    for (const name of await readdir(root)) await readUsage(path.join(root, name), usage);
  } else if (info.isFile() && root.endsWith(".jsonl") && info.mtimeMs >= usage.start) {
    const input = createReadStream(root);
    const lines = createInterface({ input, crlfDelay: Infinity });
    for await (const line of lines) usage.add(line);
  }
}

const usage = live({
  id: "claude-usage", title: "Claude usage", description: "Weekly token totals",
  cardSubtitle: "Plan limits left",
  symbol: "chart.bar.xaxis",
  defaultSize: { w: 350, h: 310 }, defaults: { weeklyLimit: 0 },
  fields: [{ key: "weeklyLimit", label: "Weekly token limit", type: "number", help: "Optional. Use 0 to hide the limit bar." }],
  validate: (c) => ({ ...c, weeklyLimit: int(c.weeklyLimit, "Weekly token limit", 0, 0, Number.MAX_SAFE_INTEGER) }),
}, 120, async ({ now }) => {
  const usage = usageCollector(now);
  await readUsage(path.join(os.homedir(), ".claude", "projects"), usage).catch(() => { throw error("Could not read local usage files."); });
  const data = usage.result();
  return data.models.length ? { content: { usage: data } } : empty("No local token usage in the last seven days.");
});

const urlField = { key: "url", label: "URL", type: "url" } as const;

const webApproval = { field: "url", verb: "load", target: (c: Config) => webOrigin(c.url) } as const;

const metric = live({
  id: "metric", title: "Metric", description: "Number and trend",
  cardSubtitle: "One number, trend",
  symbol: "chart.xyaxis.line",
  defaultSize: { w: 300, h: 176 }, defaults: { url: "", path: "$", sparkPath: "", refreshSec: 60 },
  fields: [urlField, { key: "path", label: "Value path", type: "text", help: "For example $.total" },
    { key: "sparkPath", label: "Sparkline path", type: "text", help: "Optional. For example $.history[*].value" },
    { key: "refreshSec", label: "Refresh every (seconds)", type: "number" }],
  validate(c) {
    const valuePath = str(c.path, "Value path", "$", 200).trim();
    const sparkPath = str(c.sparkPath, "Sparkline path", "", 200).trim();
    try {
      parsePath(valuePath);
      if (sparkPath) parsePath(sparkPath, { wildcard: true });
    } catch (err) { throw bad("JSON path", (err as Error).message); }
    return { ...c, url: urlConfig(c.url), path: valuePath, sparkPath, refreshSec: int(c.refreshSec, "Refresh interval", 60, 15, 3600) };
  },
}, 60, async ({ widget, request }) => {
  const { url, path, sparkPath } = metric.validate(widget.config);
  if (!url) return empty("Add a JSON URL in the inspector.");
  const { json } = await request({ url: String(url), sameOrigin: true });
  return metricData(json, String(path), String(sparkPath));
}, webApproval);

const preview = live({
  id: "page-preview", title: "Page preview", description: "Website snapshot",
  cardSubtitle: "Live site snapshot",
  symbol: "rectangle.inset.filled.and.person.filled",
  defaultSize: { w: 400, h: 332 }, defaults: { url: "" }, fields: [urlField],
  validate: (c) => ({ ...c, url: urlConfig(c.url) }),
}, 300, async ({ widget }) => {
  const url = urlConfig(widget.config.url);
  if (!url) return empty("Add a page URL in the inspector.");
  const response = await safeFetch({ url, method: "HEAD", sameOrigin: true, maxBytes: 4096, totalMs: 8000 });
  if (response.status >= 400 && response.status !== 405) throw error("The page returned HTTP " + response.status + ".");
  let browser;
  try { browser = chromePath(); } catch { return empty("Install a Chromium browser to capture page previews."); }
  const dir = await mkdtemp(path.join(os.tmpdir(), "canvas-widget-preview-"));
  const screenshot = path.join(dir, "preview.png");
  try {
    await withPreviewProxy(response.url, (flags) => command(browser, [...flags, "--headless=new", "--no-first-run", "--no-default-browser-check", "--use-mock-keychain", "--password-store=basic",
      "--disable-background-networking", "--disable-component-update",
      "--disable-features=MediaRouter,Translate,OptimizationHints",
      "--disable-sync", "--disable-extensions", "--mute-audio", "--hide-scrollbars", "--window-size=720,480",
      "--timeout=8000", "--user-data-dir=" + path.join(dir, "profile"), "--screenshot=" + screenshot, response.url], dir, 25_000)
      // Chromium may write the screenshot and still fail while shutting down.
      .catch(() => undefined));
    return { content: { preview: previewData(await readFile(screenshot)) } };
  } catch { throw error("Could not capture the page. Check that it opens in a browser."); }
  finally { await rm(dir, { recursive: true, force: true, maxRetries: 3 }); }
}, webApproval);

const disk = live({
  id: "disk-space", title: "Disk space", description: "Available storage",
  cardSubtitle: "Free space left",
  symbol: "internaldrive",
  defaultSize: { w: 300, h: 150 }, defaults: {}, fields: [],
  validate: (c) => c,
}, 120, async () => ({ content: { disk: diskData(await statfs("/")) } }));

export const liveKinds = [gitStatus, ci, usage, metric, preview, disk];
