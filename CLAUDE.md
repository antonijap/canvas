@AGENTS.md

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
