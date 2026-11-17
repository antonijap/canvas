@AGENTS.md

## Releases

- Before every release build, ask the maintainer whether to bump the version, and to what. Never bump it, or keep it, on your own.
- A release is done only when the website matches it: the zip under its own per-build file name, `releases.json` (version, file, size, SHA-256, minimum macOS, notes), the download page and every page that names a version, a macOS requirement or a setup step.
- Then check the live site yourself: download the zip from `/download/latest` and compare its SHA-256, read `releases.json`, and read each changed page. Report what you checked.
