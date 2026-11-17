Evidence for roadmap and interaction-conventions work. A card or nicety is done only when its row here points at proof.

## Rules for every item

1. Read the item's row in [docs/interaction-conventions.md](../interaction-conventions.md) (the exact rule) or its roadmap card. Match that rule unless the product direction says otherwise (Canvas has no drawing tools; agents and paste/drop make layers).
2. Write a failing test first: a unit test in `test/`, and a scenario that drives the feature with real input: `qa/scenarios.ts` (headless Chrome, real mouse and keys) for page features, `qa/native/scenarios.ts` (real NSEvents in an isolated QA build) for anything in the SwiftUI shell (inspector, layers panel, menus, toasts, palette). Each scenario declares `covers` from `qa/features.yaml`; add the feature or case there if missing.
3. Make it pass with the smallest change that does the job well. Keep the Canvas look: shadows not borders, no middots, no em dashes in UI text, blue only for canvas selection, grey for list selection, SF typography rules (no tracking on the system font in the app).
4. Capture a screenshot that shows the result (the scenario's end state or a mid-interaction frame): PNG, at most 300 KB, in `docs/evidence/img/<area>-<slug>.png`. Look at it yourself before you commit it. A screenshot that does not show the feature is not evidence.
5. Add a row to your area's file `docs/evidence/<area>.md`:

   | Item | Commit | Tests | Command and result | Screenshot |

   The command column quotes the pass line you saw, e.g. `pnpm qa -- "paste to replace"`: `1 pass, 0 fail`.
6. If an item cannot be done tonight (needs the maintainer, needs a download, needs a product decision), add a row with the reason instead. Never mark it done.

## Before you report

- `pnpm -s typecheck`, `pnpm -s test`, `pnpm qa`, and `pnpm qa:native` if you touched the shell, all green (name any load flake and show it passing on a rerun).
- `git merge main` into your branch first, then rerun what the merge touched.
- Commit on your branch with plain messages and no attribution lines. Do not push or merge to main.
- Do not touch the maintainer's running Canvas.app or its server on port 5189, and do not rebuild `apps/macos/Canvas.app` (QA builds go to a temp folder). Do not kill processes by broad patterns.
- Delete your scratch files.

## Index (2026-11-17)

| File | What it proves |
|---|---|
| [drops.md](drops.md) | Drop a shader tile (Cmd-drop an image) onto a layer to make it the fill, image files from Finder, Cmd+V of a screenshot |
| [copy-paste.md](copy-paste.md) | Selected card outline, copy and paste of layers and cards across pages, tabs and files |
| [paste.md](paste.md) | Clipboard payload sealing, paste to replace, plain text, paste into several frames, keep the parent, Place Image |
| [autolayout-drag.md](autolayout-drag.md) | The auto layout drag glitches, frame by frame before and after |
| [text.md](text.md) | Edit the next text, type keys, styled ranges, find and replace, multi-edit, truncate |
| [layers.md](layers.md) | Lock, select matching, batch rename, collapse, select inverse, keyboard box selection |
| [navigation-export.md](navigation-export.md) | Copy as PNG/SVG/code, right-click Select layer, export formats and settings, zoom keys, pixel grid, rulers and guides |
| [first-run.md](first-run.md) | Toasts you can act on, `pnpm app`, the fallback banner, the Welcome file, MCP named canvas |
| [fills.md](fills.md) | Fill type picker, paint editors, blend modes, selection colors, eyedropper, crop, corner smoothing, mask |
| [components-inspector.md](components-inspector.md) | Swap instance, aspect lock, reset one override, push to main, field math, Option-scrub, rotate keys |
| [moving.md](moving.md) | Space keeps the parent, the move modifiers, smart selection, tidy up, align to parent, rotation origin |
| [leftovers.md](leftovers.md) | Layout guides, paragraph spacing and indent, lists |
| [gaps.md](gaps.md) | Shader card to fill, nested instance swap, Components panel drag, reset by right-click, replace image fill, copy one paint, letter case, hanging punctuation, list details, undo atomicity |
| [speed.md](speed.md) | 5,000-board open, save log (two reviews' findings and the last four cases fixed; on by default, `CANVAS_SAVE_LOG=0` turns it off) |
| [keys.md](keys.md) | Real-key tests for K, Opt+Cmd+Shift+R, Opt+Cmd+C/V, `.`, Cmd+] / [, Opt+Cmd+K/B, Cmd+Return, Shift+Cmd+Return |
| [qa-infra.md](qa-infra.md) | Native QA without OCR, Shift+Cmd chord check, page lists on add and delete |
| [privacy.md](privacy.md) | Usage counts to the website's contract and Settings > Privacy (Share usage counts, Help improve Canvas, Show what's sent) |
| [review-fixes.md](review-fixes.md), [review-fixes-2.md](review-fixes-2.md) | Bugs found by the Codex and Claude reviews, each failing before its fix |
