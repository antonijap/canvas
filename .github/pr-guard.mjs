// Reads a pull request's changed files and diffs through the GitHub API and fails on what a stranger's pull request
// must never bring in. Runs from main's copy (.github/workflows/pr-guard.yml); it executes nothing from the pull
// request. Plain Node, no dependencies.
//
// Fails on:
// - changes to .github/ (workflows, this guard, CODEOWNERS, templates) from anyone but the owner
// - binaries and archives (compiled apps, libraries, wasm, zips), and pictures outside the folders that hold them
// - new install-time scripts in package.json (preinstall, install, postinstall, prepare, ...) or changes to
//   pnpm-workspace.yaml (the install-script allowlist and the release-age cooldown live there)
// - very long lines in code (minified or obfuscated code hides what it does)
// - invisible or direction-changing Unicode in added lines (code that reads differently from how it runs)
// Lists for the reviewer, without failing: dependency changes, shell and build scripts, the MCP server, the
// server's network code, and other places where a small change does a lot.

const { GH_TOKEN, REPO, PR, AUTHOR_ASSOCIATION, PR_USER } = process.env;
const owner = AUTHOR_ASSOCIATION === "OWNER";
// Dependabot only bumps pinned action SHAs and versions; its pull requests still need the maintainer's review.
const dependabot = PR_USER === "dependabot[bot]";

async function api(path) {
  const out = [];
  for (let page = 1; page <= 30; page++) {
    const r = await fetch(`https://api.github.com/repos/${REPO}/${path}${path.includes("?") ? "&" : "?"}per_page=100&page=${page}`, {
      headers: { authorization: `Bearer ${GH_TOKEN}`, accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28" },
    });
    if (!r.ok) throw new Error(`${path}: ${r.status} ${await r.text()}`);
    const j = await r.json();
    out.push(...j);
    if (j.length < 100) return out;
  }
  // GitHub lists at most 3000 files; a pull request that large is refused rather than half checked.
  fail.push("more than 3000 files changed: split the pull request");
  return out;
}

const fail = [];
const review = [];
const files = await api(`pulls/${PR}/files`);

const BINARY = /\.(app|dylib|so|node|wasm|exe|dll|jar|class|o|a|zip|tar|gz|tgz|bz2|xz|7z|rar|dmg|pkg|bin|iso|car|nib|mobileprovision|p8|p12|keystore|icns|ttf|otf|woff2?)$/i;
const PICTURE = /\.(png|jpe?g|gif|webp)$/i;
const PICTURE_DIRS = /^(docs\/evidence\/img|docs\/perf|qa\/baselines|test\/golden|demos|design|src\/paper\/thumbs|src\/page\/symbols|apps\/macos\/Harness)\//;
const CODE = /\.(js|mjs|cjs|ts|swift|rs|sh|wgsl|html|css)$/i;
const HIDDEN = /[​-‏‪-‮⁠-⁤⁦-⁩﻿]/;
const INSTALL_SCRIPT = /^\+\s*"(preinstall|install|postinstall|preprepare|prepare|postprepare|prepublish|prepack|postpack)"\s*:/m;
const SENSITIVE = [
  [/^(package\.json|pnpm-lock\.yaml|engine\/Cargo\.(toml|lock)|engine\/.*\/Cargo\.(toml|lock))$/, "dependencies"],
  [/(^|\/)build\.rs$|\.sh$|^scripts\//, "build or shell scripts"],
  [/^mcp\//, "the MCP server (agents run these tools)"],
  [/^src\/server\.ts$|^src\/bridge|^src\/agent-run\.ts$/, "the local server and agent runner"],
  [/^apps\/macos\/(Info\.plist|.*\.entitlements|build\.sh)$/, "app identity and signing"],
];

for (const f of files) {
  const name = f.filename;
  const patch = f.patch || "";
  const added = patch.split("\n").filter((l) => l.startsWith("+") && !l.startsWith("+++"));

  if (name.startsWith(".github/") && !owner && !(dependabot && name.startsWith(".github/workflows/"))) fail.push(`${name}: only the maintainer changes .github/ (CI, this guard, code owners)`);
  if (BINARY.test(name) && f.status !== "removed") fail.push(`${name}: binaries and archives are not accepted; the project builds from source`);
  if (PICTURE.test(name) && f.status !== "removed" && !PICTURE_DIRS.test(name)) fail.push(`${name}: pictures belong in docs/evidence/img or qa/baselines`);
  if (!patch && f.status !== "removed" && f.changes > 0 && !PICTURE.test(name)) fail.push(`${name}: GitHub shows no text diff for it (binary or too large to review)`);
  if (name === "pnpm-workspace.yaml" || name === ".npmrc") fail.push(`${name}: install settings (the script allowlist, the release-age cooldown) are the maintainer's`);
  if (name === "package.json" && INSTALL_SCRIPT.test(patch)) fail.push(`${name}: adds an install-time script`);
  if (CODE.test(name) && added.some((l) => l.length > 1000)) fail.push(`${name}: an added line is over 1000 characters (minified or generated code is not accepted)`);
  const hidden = added.findIndex((l) => HIDDEN.test(l));
  if (hidden >= 0) fail.push(`${name}: an added line holds invisible or direction-changing Unicode`);
  for (const [re, what] of SENSITIVE) if (re.test(name)) review.push(`${name} (${what})`);
}

const lines = [`Checked ${files.length} changed file(s).`];
if (review.length) lines.push("", "Review these closely:", ...review.map((r) => `- ${r}`));
if (fail.length) lines.push("", "Not accepted:", ...fail.map((r) => `- ${r}`));
const summary = lines.join("\n");
console.log(summary);
if (process.env.GITHUB_STEP_SUMMARY) {
  const fs = await import("node:fs");
  fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `## PR guard\n\n${summary}\n`);
}
process.exit(fail.length ? 1 : 0);
