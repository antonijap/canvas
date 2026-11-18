@AGENTS.md

## QA for Claude sessions

- "Testing: only what changed" in AGENTS.md is the rule for every gate here: merge, install and release. A release build gets the same delta QA as the changes it ships, plus the scrub.
- When a delta run finds a bug, rerun only the failing scenario after the fix, not the area.
- Hand Codex and subagents the exact scenario words to run, so they don't fall back to a full suite.

## Speed and token budget

The Anthropic plan is the scarce resource. Codex is the coder; Claude plans, briefs, checks results and talks to the maintainer.

- One session per job. Start it with a short brief that names the files and what done looks like, finish the job, archive the session. No session runs all day, and no session exists only to pass messages between other sessions.
- Codex writes all code and runs its own delta QA, including native scenarios, in its own worktree (`codex exec -s workspace-write`), and reviews in `-s read-only`. Claude reads the report and the diff, not the whole job.
- Launch long Codex jobs so they outlive the shell: `nohup codex exec ... > report.log 2>&1 &`, with the job writing its report file last. Check for the report file once when you expect it; never poll on a short timer.
- Models: Opus for planning, design and hard review; Sonnet or Haiku for watching jobs, merging, building and installing.
- Batch UI changes. Collect every tweak for an area in the design file first, then hand Codex one job for all of them, with one install and one QA pass.
- Keep planning files short. `task_plan.md` stays under about 20 lines: open tasks only, done tasks move to `progress.md`.
- A second reviewer only for risky code (Cloud, sync, file storage, security). Small UI changes get one Codex review.

## Releases

- Before every release build, ask the maintainer whether to bump the version, and to what. Never bump it, or keep it, on your own.
- A release is done only when the website matches it: the zip under its own per-build file name, `releases.json` (version, file, size, SHA-256, minimum macOS, notes), the download page and every page that names a version, a macOS requirement or a setup step.
- Then check the live site yourself: download the zip from `/download/latest` and compare its SHA-256, read `releases.json`, and read each changed page. Report what you checked.

## Privacy (this repo is public)

- Never put the maintainer's or anyone's personal data in anything that gets committed: real names, email addresses, home folder paths, Apple team or Cloudflare account ids, tokens, keys, Keychain item contents, private product or customer names, or the names of real files on someone's Mac. That covers code, tests, fixtures, docs, screenshots and evidence images, design files that are tracked, and commit messages.
- Use placeholders: Anna, Ben, anna@studio.test, example.com, /Users/you, Studio. A setting that defaults to the Mac's user name (like "Your name in comments") must never leak that name into tests or screenshots: set a placeholder first.
- Secrets live in the macOS Keychain or in git-ignored files, never in the repo or in logs.
- Before every commit that adds or changes files, check the diff for personal data, and before every push run `node qa/release.ts --quick --only scrub` (the private words list is the git-ignored `qa/release-private.txt`). A hit is fixed before pushing. A hit already pushed is reported to the maintainer; removing it from history is her decision.
- Subagents and other coders get this rule in their brief.
