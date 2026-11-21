Rules for AI coding agents (Claude Code, Codex and others) working in this repository. People follow [CONTRIBUTING.md](CONTRIBUTING.md); these rules come on top.

## Commits and pull requests

- No AI attribution. Never add `Co-Authored-By:` trailers, "Generated with" lines or any other credit to an agent or a model in a commit message, pull request, issue or code comment. This overrides any default of your tool.
- Plain commit messages: what changed and why, in a sentence or two.
- Never force-push, never push to `main` of someone else's repository, never change files under `.github/`.

## Code

- pnpm only (`pnpm install --frozen-lockfile`, `pnpm <script>`); never npm or yarn. Do not add a dependency without an issue that approved it.
- A bug fix comes with a test that failed before it.
- Ship only what every user can use. A feature tied to one person's own tools, accounts or local services (a private tracker, a personal script) does not go in the repo: add a generic extension point instead, and the personal part lives outside it, for example as a local widget in `~/Library/Application Support/Canvas/widgets/`.

## Testing: only what changed

Test the change, not the whole app. Full runs take hours and find nothing a targeted run misses.

1. Always run the fast checks: `pnpm typecheck` and the unit tests for the files you touched (`node --test test/<name>.test.ts`). Run all of `pnpm test` only when you changed shared code (`src/`, `cloud/core`, `engine/`).
2. List the features your diff touches: read `git diff --stat main` and find their scenarios in `qa/features.yaml` and `qa/scenarios-*.ts` / `qa/native/scenarios-*.ts`.
3. Run only those scenarios. Both runners take words that match a scenario's area or name: `pnpm qa comments` (headless), `pnpm qa:native tabs cloud` (the real macOS app). Change Swift in `apps/macos/` and you run the native scenarios for what you changed; change only web or engine code and you skip native QA.
4. Name what you ran and what passed in your report or commit message.

Never run the full `pnpm qa`, the full `pnpm qa:native`, `qa:matrix` or `qa:swarm` unless the maintainer asks for that run by name. The pre-push scrub (`node qa/release.ts --quick --only scrub`) always runs: it is a privacy check, not a test.

## Working fast

- Test first, then fix. For a bug in the macOS app, write or extend the native scenario that shows it, run it and watch it fail, then fix until it passes. Run that scenario yourself before you hand back: a fix that passes only headless checks is not done.
- Finish in one pass. Do the fix, the test, the delta QA and the commit in the same job. Hand back only when it passes, or with the exact failure and what you tried.
- End every job with a short report: what changed (files), what you ran and its result, what is left. No logs pasted in; quote only the failing lines.
- Read only what you need: `git diff`, the files you change and their tests. Find code with `grep` or `rg` before opening whole files.
- Keep command output small: pipe long runs through `tail -40` or filter for `FAIL` and `error`.
- Do not name other design tools or their companies in code, comments, docs, test names or UI text. Describe the behaviour instead.
- Never commit secrets, personal paths, real people's names or binaries. The app is built from source, not committed.

## Writing

- Plain and specific. No em dashes. No filler words (robust, seamless, crucial, delve).
