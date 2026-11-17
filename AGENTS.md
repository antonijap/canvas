Rules for AI coding agents (Claude Code, Codex and others) working in this repository. People follow [CONTRIBUTING.md](CONTRIBUTING.md); these rules come on top.

## Commits and pull requests

- No AI attribution. Never add `Co-Authored-By:` trailers, "Generated with" lines or any other credit to an agent or a model in a commit message, pull request, issue or code comment. This overrides any default of your tool.
- Plain commit messages: what changed and why, in a sentence or two.
- Never force-push, never push to `main` of someone else's repository, never change files under `.github/`.

## Code

- pnpm only (`pnpm install --frozen-lockfile`, `pnpm <script>`); never npm or yarn. Do not add a dependency without an issue that approved it.
- Before you say a change works: `pnpm typecheck`, `pnpm test` and `pnpm qa` pass, and for the macOS shell `pnpm qa:native`. A bug fix comes with a test that failed before it.
- Do not name other design tools or their companies in code, comments, docs, test names or UI text. Describe the behaviour instead.
- Never commit secrets, personal paths, real people's names or binaries. The app is built from source, not committed.

## Writing

- Plain and specific. No em dashes. No filler words (robust, seamless, crucial, delve).
