# QA and speed plan for the open-source release

Goal: when Canvas goes public, nothing a first-time user tries embarrasses us, and every speed number we publish is measured the same way, on a named machine.

Everything here runs when the maintainer asks for it. Nothing is scheduled. One command per layer:

| Command | What runs | Time |
|---|---|---|
| `pnpm test` | Unit tests | under 1 min |
| `pnpm qa` | Scripted scenarios in headless Chrome, sharded | under 1 min |
| `pnpm qa:matrix` | Generated scenarios for every feature and case in the catalog | 5–10 min |
| `pnpm qa:native` | Real macOS mouse and keyboard in the app, in-process | 5 min |
| `pnpm bench` | Speed suite, Canvas only | 3 min |
| `pnpm qa:swarm` | Agent swarm: exploratory testing by personas | 30–60 min |
| `pnpm qa:release` | Everything above plus the release checklist | about 90 min |

## Status (2026-11-16)

All six steps are built. How to run each is in the [developer guide](developer-guide.md#qa-in-headless-chrome).

Last full run on main, all suites one after the other:

| Command | Result |
|---|---|
| `pnpm test` | 1371 of 1371 pass |
| `pnpm qa` | 46 of 46 pass, 41 s on 9 workers |
| `pnpm qa:matrix` | 332 of 332 pass, 178 s (two seeded sequences that failed were test errors: a card side covered by another card, and a nudge that moves a group fitted to its only child) |
| `pnpm qa:native` | 14 of 14 pass, 66 s |
| `pnpm qa:coverage` | 644 feature x case pairs, 351 covered (55%), all passing |
| `pnpm qa:release --quick` | 94 pass, 1 fail (bundle ids, since changed to `cc.getcanvas.canvas`), 8 need the maintainer, 2 manual |

- `qa/features.yaml`: 86 features. Nothing yet in mcp and agent; little in chrome, pages and components.
- `pnpm qa`: each scenario is followed by the shared checks (the 41 scenarios before took 176 s on one process, without the checks).
- `pnpm qa:matrix`: 308 generated cases plus 24 seeded random sequences of 6 edits.
- Visual baselines: every scripted and generated scenario has a picture in `qa/baselines`, the same on two runs in a row.
- Measured on an M5 Pro that other agents kept at a load of 40 to 55. Under that load a single write can take 200 to 360 ms: with more than two workers the latency budget is reported, not enforced (`QA_SHARDS=1` enforces it).

Bugs the checks found, each fixed with a failing test first:
- Undo and redo moved a removed or added property to the end of the node, so the file came back with other bytes; undoing auto layout on a group did the same with its children.
- The inspector got a turned group's drawn box as its size (width and height swapped at 90 degrees).
- Cmd+arrows on a turned layer set its width from the drawn box (90 px became 104).
- An arrow pressed right after selecting a layer was dropped while the page asked the server how the layer moves.
- Two quick drags of one layer sent both writes at once; they could land in either order and lose the second drag.
- An unconfigured PostHog card said Loading for good after its page was left and shown again: the page dropped its reading.
- The playground's image fixture was a corrupt PNG.

Found and not fixed (product decisions or larger work):
- A hidden layer stays selected but shows no selection box (the engine does not draw it, so it has no rect); designers expect the box. The selection check skips hidden layers and says so.
- Cmd+arrows on a group answer "Could not resize": a group has no width of its own. Designers expect the group to scale.
- Cmd+D on a card did nothing but say so. Fixed 2026-11-16: cards copy, cut, paste and duplicate (`qa/scenarios.ts` clipboard area).
- Right after reselecting a group that was just turned, its selection box can sit about 100 px off for a moment ("rotate a group twice" now waits for it to hold still).
- Seen under heavy load, not reproduced on demand (72 tries): a resize from the west or south-west handle of a layer inside a plain frame grew it to the east (twice in six matrix runs).

Not covered yet: most of the native shell beyond step 4's scenarios (below), MCP tools, file sizes beyond the playground (large: an 18 MB real-world file; 5,000 boards), dark theme pictures, the agent features.

### Speed (step 3)

`pnpm bench` is the speed suite on generated 200, 2,000 and 5,000-board files (`bench/speed.ts`, `bench/fixtures/gen.ts`); a real file only comes in through `BENCH_FILE`. Budgets and the full before and after table are in [docs/perf/latency.md](perf/latency.md).

| Line | Before | After |
|---|---|---|
| Cold open, 200 boards | 7.7 s | 0.56 s |
| Cold open, 2,000 boards | never finished | 1.5 s |
| Cold open, 5,000 boards | never finished | 3.4 to 5.1 s |
| Flush to disk, 31 MB file, p50 / p95 | 35 / 147 ms | 5 / 6 ms |
| Structure ops on an 18 MB file, p50 | 36 to 53 ms | 8 to 20 ms |
| Megapixels repainted per edit | 1.4 to 2.1 | 0.05 to 0.11 |
| MCP edit to pixel, p50 | 31 ms | 15 ms |

Every open is within budget now (second pass, 2026-11-17: [evidence](evidence/speed.md)). Saving appends what changed to a save log beside `document.json` and writes the whole file once edits pause. The pan at the 5,000-board overview misses its budget when other agents load the GPU.

### Native input (step 4)

`pnpm qa:native` is built (`apps/macos/QA.swift` in a `QA=1` build only, `qa/native/`); how it works is in the [developer guide](developer-guide.md#native-qa-real-macos-input). 14 scenarios, all passing, about 2 minutes on one instance (40 s of it the QA build when Swift changed, 30 to 60 s text recognition loading its model), the same with `QA_NATIVE_SHARDS=3`:

- Sidebar drags: a Widgets row onto the canvas (the card lands centred on the drop point), a shader tile (and it draws within seconds), page reorder (and no blue drop line stays), a board onto another page, a Layers row into a frame and back out.
- Layers rename: double-click, type, Return.
- Inspector: hex field, opacity, letter spacing `-2%` (stored as px of the font size), W `+10` then Hug contents on an instance (the field follows without reselecting).
- Cmd+K: open, search, run. The zoom pill's menu: 100%, Zoom to Selection, Fit Page.
- Settings: Cmd+, opens it; theme Dark and Light, Show board names; each change is in the instance's stored preferences.
- Styles: the Text, Variables and Fonts switch.

No product bugs found: the scenarios aimed at today's fixes (sidebar drags, Hug on an instance) pass. Limits, by design: menus in a QA instance are not drawn (a drawn menu takes the whole screen's mouse), so a menu's look is not tested, only its items and actions; drags run in-process, so the window server's part of drag and drop is not tested; the QA window is visible on screen while the run lasts. Flaky so far: with 3 instances starting text recognition at once, one first `qa.find` stalled past 60 s (now retried).

### Swarm (step 5)

`pnpm qa:swarm` is built (`qa/swarm.ts`, `qa/swarm-lib.ts`, `qa/swarm-tool.ts`); how to run it is in the [developer guide](developer-guide.md#agent-swarm). Without `--go` it is a dry run that prints the plan and the prompts and spawns nothing. Each agent has its own scratch server, Chrome, fixture copy and Canvas MCP; findings go to a verifier on a fresh copy, and confirmed ones come out as a ranked report plus `qa/scenarios.ts` stubs.

Smoke run (2 Codex finders on history, 4 min each, plus 2 verifiers, about 196k tokens, 9 minutes): both findings confirmed, both now fixed with a failing test first (`test/structure-pages-undo.test.ts` and two scenarios):
- Deleting the component board `cmp_main` and undoing restored `document.json` byte for byte, but `widgets.json` kept the id of the "Deleted components" board, which no longer existed. The page list write now joins the structure op's own undo step.
- Select `board0`, nudge it, switch to an empty page, Cmd+Z: the empty page stayed active with `board0` selected and drawn nowhere, and Backspace then deleted `board0` from the other page. Undo now switches to the page of the change, and the page's structure requests drop ids from other pages.

The Claude side was not run live: the Claude CLI had used its weekly quota (the preflight stops the run and says so).

### Release checklist (step 6)

`pnpm qa:release` is built (`qa/release.ts`, `qa/release-crash.ts`, `qa/release-allow.txt`); how to run it is in the [developer guide](developer-guide.md#release-checklist). `--quick` runs the ten checks of section 8 in a few minutes; without it the long suites follow. Each item is PASS, FAIL, NEEDS-MAINTAINER or MANUAL; the report is `qa/out/release/report.md`. New tests that `pnpm test` runs too: `test/release-security.test.ts` (listening, origins, writes only inside packages), `test/release-agent-limits.test.ts` (tool allowlist, time cap, output cap, runs at once) and `test/fuzz-canvas.test.ts` (27 hostile packages plus seeded random ones; 400 random ones also pass).

Holes found and fixed, each with a failing test first:
- A package whose `document.json`, `widgets.json`, `shaders/` or `media/` was a symlink to somewhere else had every edit written there, with the journal and backups beside the target. Links out of a package are now refused (`src/docpath.ts` `inPackage`, `src/doc/docfile.ts`); a dangling link counts as out.
- Document write routes checked the `x-canvas` header but not the Origin: a request from another site or another local port that carried the header got through. Every method but GET, HEAD and OPTIONS now needs a same-origin or no Origin (`src/server.ts`). Browsers could not send that request (the preflight is never answered), so this is defence in depth.
- `/asset` served any image on disk to any site that embedded it. It now answers with `Cross-Origin-Resource-Policy: same-origin`.
- A file nested 50,000 frames deep overflowed the stack in the background board index (`src/doc/boardindex.ts`) and took the server down; the walk no longer recurses.
- Scratch servers wrote their backups into the home folder's backup folder (over 10,000 folders there); `qa/lib.ts` now points `CANVAS_STATE_DIR` into the scratch folder.

Fixed after the first run: private names out of tracked files (the size case is now `large`, names to look for live only in the git-ignored `qa/release-private.txt`), the personal path in `anim.py`, `THIRD_PARTY_NOTICES.md` lists all 94 npm packages and 143 crates, no false conflict copies or leftover `-prev.tmp` after a kill -9 (the developer guide now says recovered edits wait in `<name>.recovered-<time>`), contrast tokens to AA (light muted text, placeholders, red, a new `dangerFill`), `pnpm build:engine` and a README note on the DOM fallback, the missing tools and variables in the guide, and every test server on a free port.

Left for the maintainer:
- Licence: no LICENSE file and no `license` fields; the README says Canvas has no public licence. The notices list licences, not full texts.
- Git history: private names, one personal path and the maintainer's email on every commit. Removing them needs a history rewrite or a fresh public repo.
- VoiceOver walk and a mac app build from a fresh clone (MANUAL, steps in the report).

## 1. The feature catalog

`qa/features.yaml` lists every feature with the cases it must survive: node type (frame, group, text, image, instance, card kinds), state (empty, one, many, rotated, inside an instance, inside auto layout, hidden, on another page), theme (light, dark), file size (tiny; large, an 18 MB real-world file; 5,000 boards) and input (mouse, keyboard, agent tool).

`pnpm qa:coverage` prints which feature × case pairs have a passing test and which don't. A feature counts as done only when its catalog entry has coverage.

## 2. Checks every scenario runs

Any scenario, written or generated, ends with the same checks:

- **Undo:** undoing to the start gives the original file byte for byte; redo gives the end state byte for byte.
- **Save and reopen:** the reopened file draws the same picture (pixel diff under a threshold).
- **File:** valid against the schema; no orphaned ids; components resolve.
- **Console:** no errors or unhandled rejections in the page or the server.
- **Selection:** the selection box matches the drawn rect; the inspector's values match the file.
- **Layout of the UI:** no overlapping floating UI (captions, toasts, pills), no clipped glyphs in the chrome, dividers edge to edge.
- **Latency:** every interaction inside its budget (`docs/perf/latency.md`).

## 3. Generated scenarios

From the catalog: every edit (move, resize from each edge and corner, set each property, group, ungroup, auto layout on and off, duplicate, delete, paste) × every node type × undo × redo × save and reopen. Plus random sequences (property-based, seeded, so a failure replays exactly). Expected size: a few thousand cases, sharded over 8–12 processes.

## 4. Visual regression

Every scenario's end state is screenshotted and diffed against a stored baseline. A changed baseline needs the maintainer's OK in the report, so design changes are deliberate.

## 5. Native input without computer use

A debug-only bridge command in the app posts real `NSEvent`s into its own window (mouse down, drag, up, keys with modifiers). This covers what the browser can't: sidebar drags, menus, the inspector's SwiftUI fields, the palette. Several app instances can run side by side with their own ports and data folders. Computer use stays for occasional end-to-end looks only. Built: `pnpm qa:native` (status above).

## 6. Speed

Measured on this Mac, on the generated stress files:

| Metric | How |
|---|---|
| Cold open of a 200-board file to first full picture | Screen recording, frame of first complete paint |
| Pan and zoom frame time, p50 and p95, 200 and 2,000 boards | Engine counters, and a screen recording at 120 fps |
| Drag a layer, resize, type: input to pixel | 240 fps recording of the cursor and the change |
| Select in a dense board | Same |
| Memory after 10 min of editing | Activity Monitor sampling |
| Export 50 boards to PNG | Wall time |
| An agent's edit to pixel | MCP call timing |

Engine work this will drive, roughly in order: tile cache hit rate at zoom transitions, incremental layout for structure ops (today 36–60 ms on the large file), saving only changed bytes instead of rewriting 18 MB, GPU repaint of only changed tiles, 120 Hz in WKWebView, and a 5,000-board stress file. Every engine change ships with its before and after from `pnpm bench`.

Published numbers in the README come only from `pnpm bench`, with the date, machine and versions.

## 7. Agent swarm, on demand

`pnpm qa:swarm` starts 10–20 agents (Claude and Codex mixed). Each gets a persona (designer on a big file, keyboard-only user, agent-heavy user, first-time user, accessibility user), a feature area and the catalog. They drive Canvas through the headless page, the agent tools and the native bridge, and try odd sequences. A verifier tries to disprove each finding; confirmed ones come back as a ranked report, and each becomes a deterministic scenario before it is fixed.

## 8. Release checklist (`pnpm qa:release`)

- Fresh macOS user account: clone, install, build, open the sample file, following the README word for word.
- No secrets, personal paths, private file names or customer data in the repo or its history.
- Licence chosen and in place; third-party notices complete.
- The local server listens on localhost only, checks origins, and refuses writes outside the documents it opened.
- Agent runs keep their tool allowlist, time and size limits.
- Malformed and hostile `.canvas` files (fuzzed) never crash the app or write outside the package.
- Crash during save loses nothing (kill -9 tests).
- Files from older versions open and migrate.
- VoiceOver can reach every control in the chrome; contrast passes AA.
- Every README and docs claim is checked against the app.

## Order of work

1. Catalog, coverage report, shared checks, sharded `pnpm qa`. **Done 2026-11-16.**
2. Generated scenarios and visual regression (`qa:matrix`). **Done 2026-11-16.**
3. `pnpm bench` extended to the speed table. **Done 2026-11-16.**
4. Native bridge (`qa:native`). **Done 2026-11-16.**
5. Swarm runner (`qa:swarm`). **Done 2026-11-16.**
6. Release checklist (`qa:release`). **Done 2026-11-16.**

Every bug found anywhere becomes a failing test first, then a fix.
