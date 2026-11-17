Optical alignment pass over the newer UI (2026-11-17): comments on the canvas, the Welcome card, Settings (General, Cloud, Agents), About Canvas, the letter spacing field and its token button, and Home. Rules: [README](README.md).

## How it is measured

- `qa/ink.ts` finds a control's visible ink on a 2x capture: every pixel inside the control's rounded shape that differs from its fill, with fractional edges (a column at 30% of the ink's contrast moves the edge by 0.7 px). Text is placed by its baseline (the bottom edge most letters end on) and the middle of its capitals above it (cap height from the font). Unit tests: `test/ink.test.ts`.
- Page: `qa/scenarios-alignment.ts` (headless Chrome at 2x, light and dark), with the DOM side in `qa/ink-page.ts`.
- App: `qa/native/scenarios-alignment.ts` (the QA build's own window capture, 2x, light and dark), including the same comment and welcome checks inside the app's web view.
- Tolerance: 0.5 pt (one device pixel) for icons, dots and edges; 0.75 pt where text lands, because a renderer draws a line's baseline on a whole pixel. Every measurement is written to `qa/out/alignment/*.jsonl` with a 4x crop of each control (git-ignored).
- "off" below is the difference the check measures, in points, light theme (dark measured the same within 0.05 unless noted).

## What was off, the fix, after

| Element | Before (off, pt) | Fix | After (off, pt) |
|---|---|---|---|
| Comment avatars (pin, thread, composer, draft pin, shared bar): the initial's cap middle vs the circle's centre | 1.12 low | Every one-line label in comments.js is a span trimmed to its cap height (`text-box: trim-both cap alphabetic`), so flex centring centres the capitals | 0.12 |
| Pin count (open and deleted-layer pin) | 1.12 low | same | 0.12 |
| esc key in the comment-mode hint: x-height middle vs key centre | 2.16 low | trimmed to the x-height (`text-box-edge: ex alphabetic`) | 0.16 |
| Hint and count bar bubble icon vs pill centre | 0.99 high | the icon's span is a flex box, so the svg no longer sits on a line box's baseline | 0.01 |
| Hint: room left of the bubble vs right of the esc key | 13.11 vs 12.00 | left padding 11 (the bubble's ink starts 1.1 px inside its box); count bar left padding 11, right 5 | 0.11 |
| Resolve button (check icon + word): left vs right ink margin | 1.26 | text buttons with an icon take 7.5 px on the icon side | -0.24 |
| Layer chip (layer icon + name): left vs right ink margin | 0.66 | chip padding 6 / 7 | -0.34 |
| Comment row: name's cap middle vs avatar centre | 1.58 high | avatar margin-top 1, meta row 4.5 px top padding, names on one baseline | 0.42 |
| Comment row: name and time baseline (13 px and 12 px text) | 1.00 apart once trimmed | meta row aligns on the baseline; the delete button sits absolutely on the cap line | 0 (name and time); pending state 0.50 |
| Pending: clock vs the state's cap middle | 0.73 | the state is inline, the clock placed with `vertical-align: calc(.5cap - 5.5px)` | 0.23 |
| Refused: Retry's centre vs the reason's first line | 2.14 | Retry and Discard margin-top -2 px | 0.14 |
| Refused: alert icon vs first line | 0.64 | icon margin-top 2 px | -0.36 |
| Deleted-layer band: ghost icon vs the middle of the two lines | 1.42 high | the band's title and line trimmed to their caps; the top row 22 px min height | 0.08 |
| Deleted-layer band: ghost ink vs the buttons' left edge | 1.50 | ghost margin-left -1.5 px | 0.50 |
| Pin to a layer: left vs right ink margin (the P's side bearing) | 0.76 | left padding 8.5 | 0.26 |
| Composer: the field's cap middle vs the avatar centre | 1.52 | avatar margin-top 1 (as in the thread) | 0.52 |
| Welcome card in the app's web view: agent name's cap middle vs Connect and Copy's centre | 0.80 | the name trimmed to its caps | within 0.3 |
| FieldButton with a glyph (Copy, Open, New file): left vs right ink margin | 0.89, 0.66, 0.96 | 11.5 pt leading padding beside a glyph | 0.39, 0.16, 0.46 |
| Share Comments... (closing ellipsis): left vs right ink margin | -0.98 | trailing padding 11 after an ellipsis | 0.02 |
| About: Alpha chip, left vs right ink margin | -0.76 | padding 7.5 / 6.5 | 0.23 |
| About: buttons drawn with a border, ad hoc colours and sizes | border, `Color.primary` | FieldButton (`wide`), Palette and Typography tokens (`Typography.appName` added) | no border |
| Letter spacing glyph: wider than its 18 pt handle, ran 2 pt past line height's glyph and 2 pt closer to the number | 2 (from the crop) | `imageScale(.small)`; it starts and ends where line height's glyph does | start 0.0, end 0.51 |
| Auto chip: 10 pt in a 16 pt frame beside an 11 pt caption, outlined when off | baselines about 0.4 apart, an outline | Typography.section, the caption's baseline (`.firstTextBaseline`), a grey fill when off | 0.07 |
| Token button hexagon in a field: top vs bottom margin | 0.60 | `MiniButton(glyphNudge: -0.5)` for the hexagon | -0.41 |
| Home server view: status dot vs the status line | 10.57 (centred between two lines) | dot on the first line's cap middle (alignment guide) | 0.07 |
| Home first launch: New file glyph (doc.badge.plus) in its tile | 4.01 left, 0.94 high | optical nudge 2 pt right, 0.5 pt down | 0.01, 0.06 |
| Home first launch: team glyph (cloud) | 0.81 low | nudge 0.5 pt up | -0.18 |
| FieldButton labels (Check for Updates, Sign out, Connect, Copy, Open, New file, Home's start buttons): cap middle vs centre | 0.43 to 0.46 low | `capCentered(size, weight)` in the design system centres a line by its capitals (glyphs on its baseline) | -0.23 to -0.04 |
| Home filter segments: cap middle vs segment centre | 0.45 low | `capCentered` | -0.23 to -0.05 |
| Home sidebar rows: name's cap middle vs row centre | 0.51 to 0.61 low | `capCentered` on the name, the glyph's frame 20 pt tall so the row centres on the shared line | 0.01 to 0.13 |
| Home sidebar rows: glyph middle vs the name's cap middle | -0.61, -0.44 | same | 0.06 to 0.32 |
| Status dots beside text (Agents status, Home sidebar server row) vs the text's cap middle | -0.51, -0.61 | `StatusDot` (design system) sits on the caps' middle in a baseline-aligned row; also used by Cloud's status | -0.01, -0.13 |

## Checked and judged fine on purpose

- Home filter "All": its ink box reads 0.79 pt left of the middle; the A starts on its own edge with thin diagonals, so it looks centred. The check allows 0.85 for that label only.
- About: the version line's ink is 0.6 pt off the window's centre; the line is centred by its advance and its commit hash changes per build.
- Settings > Cloud status dot: -0.61 against "Connected", the same `StatusDot` that measures -0.01 against "Not connected" in Agents; the round letters of "Connected" reach past the baseline the measurement takes from the ink, and the line lands on a whole pixel.
- Text fields (Your name in comments, Server address) 0.42 to 0.53 and the model menu's text 0.51: AppKit draws the field text; within the 0.75 text tolerance, left as is.
- Comment pins in dark: the teardrop is the popover colour (dark grey), like every card in dark, not white.
- Comment status dots keep their darker green and amber (#16a34a, #d97706): the token greens are below 3:1 against white for a 7 px dot.
- The deleted-layer band keeps its orange values: there is no orange token, and its secondary text uses the band's own hue.
- Welcome card buttons, shared bar, reply row, Settings fields, menus' chevrons, Home cards, the pinned Home tab's house and the empty recents measured within tolerance before any change.

## Checks added

Page (`pnpm qa alignment`): "comments / alignment: every comment control is optically centred, light and dark" (62 checks per theme), "first-run / alignment: the welcome card's Connect and Copy buttons, its command names and its dot".

App (`pnpm qa:native alignment`): Settings (General, Cloud, Agents), About Canvas, letter spacing (glyph, Auto, token button, the line height field beside it), Home (tab, header, filter, sidebar rows, server row and view, card meta line), Home first launch (tile glyphs, buttons, empty recents), and in the app's own web view: pins, count bar, thread head, reply row, hint, and the welcome card.

## Runs

- `pnpm -s typecheck`: clean. `pnpm -s test`: `tests 1757, pass 1757, fail 0` (two of eight runs under load had one failure that did not repeat; the failing test was not captured).
- `pnpm qa`: `136 pass, 0 fail, 0 skip in 102 s on 9 workers`; after the last scenario edits `pnpm qa comments first-run`: `12 pass, 0 fail, 0 skip`.
- `QA_NATIVE_SHARDS=3 pnpm qa:native`: `88 passed, 1 failed, 0 skipped in 235 s`. The failure was "palette / Cmd+K opens, searches and runs a command" (the query read empty under three instances); alone: `1 passed, 0 failed`. After the last Settings change: `pnpm qa:native "alignment: general"`: `PASS`.
- `node qa/release.ts --quick --only scrub`: `15 pass, 0 fail` (the one history-only hit predates this branch).

Before the fixes the page scenario failed with 36 problems (18 per theme) and the native ones with 26 (settings 4, about 4, letter spacing 6, Home 6, first launch 6).
