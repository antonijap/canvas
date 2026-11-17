# Canvas performance baseline

Measured 2026-11-14. Run it again with `pnpm bench:baseline` (about 15 minutes). Raw numbers: `bench/out/results.json`. Traces: `bench/out/trace-<file>-<scenario>.json` (open in Perfetto or chrome://tracing), CPU profiles next to them as `.cpuprofile` (open in Chrome DevTools, Performance or Memory tab).

## Environment

| | |
|---|---|
| Machine | Apple M5 Pro, 18 cores, 64 GB, macOS 27.0.1 |
| Node | v24.22.3 (runs `.ts` directly) |
| Browser | Chrome for Testing 156.0.8078.4, headless=new, 1440x900 CSS px, device scale factor 2 |
| Page mode | `?shell=native` (no left rail or props panel, like the macOS app) |
| Server | `src/server.ts` unchanged, own process on port 5199, `--expose-gc` for heap numbers |
| Code | The page run used HEAD `73fd1c8`. Commits landed while I measured; see "Fixed during this work". |

Google Chrome is not installed on this machine (`/Applications/Google Chrome.app` does not exist), so the harness falls back to the Playwright copy of Chrome for Testing. Override with `BENCH_CHROME=/path/to/chrome`. Same Blink and V8, so layout, style and paint counts transfer. Timing does not transfer exactly.

### Files (read-only; nothing is written next to them)

| File | Size | Top-level boards | Nodes |
|---|---|---|---|
| real-world design file A | 16.9 MB | 81 | 28,671 |
| real-world design file B | 4.1 MB | 27 | 6,063 |
| real-world design file C | 1.4 MB | 4 | 1,987 |
| bench/out/synthetic-200x50.canvas (generated) | 2.4 MB | 200 + 1 component | about 10,000 |

Backups and `worktrees/` are skipped when picking the largest files.

## Methodology

Server (`bench/server.ts`, `bench/inproc.ts`):
- In-process: a fresh Node process per file. "Cold" is the first call (includes JIT). "Warm" is the median of 8 to 12 repeats. `loadDoc` is split into read, parse, sha256.
- HTTP: `/api/doc` 15 to 30 times, `/api/board` for every board 3 to 5 times, `/api/node` for 20 nodes, a burst of 12 concurrent board fetches (what the page does on entering an overview). Sizes are raw and gzip. CPU and heap come from the server process over IPC.
- SSE: copy the file into `bench/out`, connect to `/events`, rewrite the copy by write-temp-then-rename (how the writer saves), 6 times. Latency is rename to the `event: doc` frame.

Page (`bench/page.ts`), driven over raw CDP (WebSocket). A fresh browser context per run, Google Fonts blocked so network does not add noise (set `BENCH_NET=1` to allow):
- `load-fit`: navigate, wait until every board in the viewport (plus the page's 0.6 prefetch margin) is swapped in and quiet for 300 ms. 3 reps, median shown.
- `enter-overview`: after load, jump the camera to fit the whole file (ctrl+wheel then wheel), wait for the boards to settle.
- `pan-working`, `zoom-working`, `pan-overview`, `zoom-overview`, `pan-selected`: set the camera (0.25 "working" or fit-all "overview"), wait to settle, then 5 s of `Input.dispatchMouseEvent` wheel events at 120 Hz. Pan is 1200 px/s. Zoom is ctrl+wheel, 2.5 s in then 2.5 s out, 0.6 deltaY per event. `pan-selected` clicks a node first so the selection overlay is live.
- Collected in page: rAF deltas, long tasks (PerformanceObserver), board swaps. From CDP: `Performance.getMetrics` deltas (LayoutCount, RecalcStyleCount, ScriptDuration, TaskDuration), input round trip time per wheel event, `/api/board` request count and bytes.
- A second, traced run per scenario records a Chrome trace (Tracing domain) and a V8 CPU profile (0.5 ms sampling). Traced runs are never used for the timing columns.

Caveats you need to read before trusting a number:
1. **WKWebView is not Chrome.** The app renders in WKWebView (WebKit). Style, layout and paint counts carry over. Frame times, raster and compositor behaviour do not. Treat Chrome numbers as ratios between code paths, not as what the app does on screen. Re-run the same scenarios in the app before deciding anything close.
2. **Headless rAF is locked to 60 Hz.** Frame deltas sit at 16.7 ms whenever the main thread has more than about 5 ms to spare, so they cannot show how close to the edge a scenario is. Use "main thread busy" (`TaskDuration` over the 5 s window; 5000 ms would be a saturated thread) as the headroom measure. A 120 Hz ProMotion display has half the budget (8.3 ms).
3. One rep per interaction scenario. Differences under about 15% are noise.
4. CDP wheel deltas are divided by the device scale factor by the page; the harness compensates (`DSF` in `page.ts`).

## Fixed during this work

The first full run found this (run A, code before commit `73fd1c8`; the comment at `server.ts` line 272 now documents the fix):

`/api/board` did not return a `key`, so `loadedKey` was always `undefined`, `loadVisible` never considered a board loaded, and `loadBoard` called `scheduleVisible` after every load. Every visible board was refetched in a loop. Run A numbers, with the key emulated by a fetch shim ("key fixed") versus as shipped:

| File | idle `/api/board` per second | main thread busy, 5 s zoom (ms) | same, key fixed | enter-overview settle (ms) | key fixed |
|---|---|---|---|---|---|
| synthetic-200x50 | 100 (pan) | 1,972 (pan) | 816 | 890 | 800 |
| file B | 13 to 45 | 687 to 743 | 315 to 507 | 1,047 | 269 |
| first-week | 36 to 68 | 3,854 (zoom) | 809 | 1,820 (up to 23,700 ms in one earlier run, 355 MB transferred) | 193 |
| file A | 5 to 6 | 705 | 369 | 2,552 | 2,016 |

Run A used a half-depth camera (the CDP wheel scaling was not compensated yet), so treat it as the size of the bug, not as a baseline. The final run below has the key and an idle request rate of 0.

## Server results (HEAD 73fd1c8)

| File | MB | cold loadDoc+snapshot (ms) | warm loadDoc p50 | warm snapshotOf p50 | boardHtml p50 / max |
|---|---|---|---|---|---|
| file A | 16.9 | 134 + 71 | 48 (read 14, parse 18, sha256 17) | 14 | 2.9 / 10.6 |
| file B | 4.1 | 27 + 17 | 21 | 12 | 2.8 / 7.8 |
| first-week | 1.4 | 9 + 5 | 7 | 3 | 3.6 / 20.8 |
| synthetic-200x50 | 2.4 | 10 + 11 | 8 | 7 | 1.0 / 23 |

(Warm numbers vary 20 to 40% between runs on this shared machine; file A warm `loadDoc` was 74 ms in one run and 48 ms in another.)

| File | `/api/doc` cold / p50 / p95 (ms) | `/api/board` p50 / p95 / max | `/api/node` p50 | 12 concurrent boards, wall | SSE change to broadcast p50 / max |
|---|---|---|---|---|---|
| file A | 174 / 79 / 116 | 83 / 106 / 298 | 74 | 1,013 ms | 184 / 224 |
| file B | 27 / 14 / 15 | 19 / 27 / 32 | 20 | 248 ms | 198 / 199 |
| first-week | 10 / 7 / 9 | 9 / 32 / 84 | 7 | 56 ms | 50 / 199 |
| synthetic-200x50 | 18 / 8 / 9 | 9 / 11 / 19 | 8 | 104 ms | 89 / 200 |

| File | doc payload raw / gzip | board raw avg / gzip avg | all boards raw | server heap after load | heap growth after storm | RSS growth | CPU per `/api/board` |
|---|---|---|---|---|---|---|---|
| file A | 115 / 11 KB | 159 / 12.7 KB | 12.6 MB | +44 MB | +46 MB | +153 MB | 81 ms |
| file B | 35 / 4 KB | 109 / 13.4 KB | 2.9 MB | +11 MB | +11 MB | +14 MB | 19 ms |
| first-week | 10 / 1 KB | 398 / 45 KB | 1.6 MB | +3 MB | +4 MB | +19 MB | 17 ms |
| synthetic-200x50 | 21 / 4 KB | 12 / 0.9 KB | 2.4 MB | +4 MB | +4 MB | +3 MB | 8 ms |

`/api/files`: first non-empty result after 106 ms (14 files), warm request 0.6 ms. SSE broadcast payload for file A is 117 KB.

## Page results (HEAD 73fd1c8, key present)

Load (median of 3):

| File | first board painted (ms) | viewport settled (ms) | DOM nodes | boards mounted | layouts | recalcs |
|---|---|---|---|---|---|---|
| file A | 333 | 1,044 | 1,491 | 2 | 11 | 13 |
| file B | 139 | 739 | 875 | 2 | 9 | 11 |
| first-week | 196 | 982 | 5,629 | 3 | 12 | 13 |
| synthetic-200x50 | 74 | 782 | 1,491 | 9 | 18 | 20 |

Settled time is dominated by the 300 ms quiet window in my detector plus the 3 s `document.fonts.ready` wait cap in `loadBoard`; first board painted is the better number. No long tasks, JS heap about 1 MB in every case.

Jump from fit-first-board to fit-all (enter-overview):

| File | settle (ms) | board requests | transferred | boards mounted | DOM nodes added | main thread busy |
|---|---|---|---|---|---|---|
| file A | 6,687 | 79 | 12.5 MB | 2 to 81 | +55,048 | 2,201 ms |
| file B | 1,000 | 25 | 2.8 MB | 2 to 27 | +10,403 | 168 ms |
| first-week | 692 | 1 | 0.4 MB | 3 to 4 | +1,690 | 34 ms |
| synthetic-200x50 | 1,797 | 192 | 2.4 MB | 9 to 201 | +9,408 | 513 ms |

5 s of 120 Hz wheel input, frame statistics from rAF (headless, 60 Hz locked):

| File | Scenario | fps | p50 / p95 / p99 / max (ms) | frames over 25 ms | long tasks | main thread busy of 5,000 ms | recalcs / frame | layouts / frame |
|---|---|---|---|---|---|---|---|---|
| file A | zoom-working (0.25 to 1.1x) | 60 | 16.7 / 16.7 / 16.8 / 16.8 | 0 | 0 | 363 | 2.0 | 0 |
| file A | **zoom-overview (81 boards mounted, 56k nodes)** | **41.4** | **16.7 / 33.4 / 216.6 / 333.4** | **23** | **7 (1,371 ms)** | **4,888** | 1.4 | 0 |
| file A | pan-working | 60 | 16.7 / 16.7 / 16.8 / 16.8 | 0 | 0 | 349 | 2.0 | 0 |
| file A | **pan-overview** | **31.2** | **16.7 / 116.6 / 266.7 / 366.7** | **55** | **17** | **5,686** | 1.2 | 0 |
| file A | pan-selected | 60 | 16.7 / 16.7 / 16.8 / 16.8 | 0 | 0 | 322 | 2.0 | 0 |
| file B | zoom-working | 60 | 16.7 / 16.7 / 16.8 / 16.8 | 0 | 0 | 368 | 3.0 | 3.0 |
| file B | zoom-overview (27 boards, 11k nodes) | 60 | 16.7 / 16.7 / 16.8 / 16.8 | 0 | 0 | 1,471 | 1.4 | 0 |
| file B | pan-overview | 49.7 | 16.7 / 33.4 / 33.4 / 49.9 | 51 | 0 | 1,665 | 1.5 | 0.05 |
| first-week | zoom-working | 60 | 16.7 / 16.7 / 16.8 / 16.8 | 0 | 0 | 984 | 3.0 | 3.0 |
| first-week | pan-overview | 60 | 16.7 / 16.7 / 16.8 / 16.8 | 0 | 0 | 1,112 | 2.5 | 1.5 |
| synthetic-200x50 | zoom-working | 60 | 16.7 / 16.7 / 16.8 / 16.8 | 0 | 0 | 1,179 | 2.9 | 2.9 |
| synthetic-200x50 | zoom-overview (201 boards, 11k nodes) | 60 | 16.7 / 16.7 / 16.8 / 16.8 | 0 | 0 | 1,958 | 1.6 | 0 |
| synthetic-200x50 | pan-overview | 60 | 16.7 / 16.7 / 16.8 / 16.8 | 0 | 0 | 1,911 | 2.4 | 1.2 |

Reading it: with the viewport showing a few boards, zoom and pan hold 60 fps with 70 to 95% of the main thread idle (file A is cheapest because its boards are mounted lazily and few are in view). Once the whole file is mounted, file A drops to 31 to 41 fps with 0.2 to 0.4 s frames and the main thread saturated. file B and the synthetic file keep 60 fps but use 30 to 40% of the thread (7 ms of every 16.7 ms frame; that is under half the 8.3 ms budget of a 120 Hz screen, no spare).

### Board titles and labels during zoom

Each board has a label (`.board>.label`) with `transform: scale(1/z)` so it keeps a constant screen size. `applyCam` rewrites that transform on every board, every wheel event (about 120 times a second): file A 81 style writes per event, about 9,700 a second; synthetic 201 per event, about 24,000 a second. Observed effect: style recalcs of 1.4 to 3.0 per frame on every zoom scenario (the floor with no labels is about 1), `applyCam` itself 0.2 to 0.9% self time, so the label loop is not the CPU hog. What it does is dirty style for every board each event, which combined with `placeOverlays` and `boxOf` reads causes 3.0 layouts per frame on file B, first-week and synthetic zoom-working (about 1.5 forced layouts per wheel event; 0 in the real file where the boards are not yet sized). At fit-all (z about 0.02 to 0.09) labels are scaled up 11x to 50x, so a 12 px label is 130 to 600 px wide; label paint cost at that scale is not isolated by this harness (gap, see below).

## Hotspots, ranked for zoom smoothness

1. **Everything stays mounted, and at overview zoom everything is painted and hit-tested.** After fit-all file A holds 56,539 DOM nodes (81 boards, 12.5 MB of HTML) and nothing is ever unloaded. Zoom-overview: busy 4,888 of 5,000 ms, 23 frames over 25 ms, 7 long tasks totalling 1.4 s (max 320 ms), p99 frame 217 ms. Traced: Paint 705 ms, Layerize 147 ms, HitTest 1,838 ms. Pan-overview is worse (busy 5,686 ms, 55 frames over 25 ms, Paint 1,220 ms, Layerize 650 ms). Proposal: level of detail. Below about z 0.1 swap each board's DOM for a cached bitmap or tile (the WebGPU tile cache from commit 73fd1c8 already exists) and unmount boards outside the 0.6 margin; add `content-visibility: auto` plus `contain-intrinsic-size` to `.board` as a cheap first step. Expected: nodes at overview from 56k to under 5k, busy from 4.9 s to under 1 s, p99 under 20 ms on this file.
2. **`elementFromPoint` hit testing on pointer move during gestures.** CPU profile of file A zoom-overview: `elementFromPoint` 25% self time (file B 10%, synthetic 12%); trace `HitTest` 1,838 ms of 5,010 ms of tasks. The hover handler runs it per animation frame while wheel events also move the synthetic pointer. Proposal: skip hover work while a wheel or pinch gesture is active and for 150 ms after (a flag set in the wheel handler), and when z is below about 0.15 skip it entirely; for hits at low zoom use a board-rect index instead of the DOM. Expected: minus 20 to 25% main thread at overview, about 1 s of 5 s on file A.
3. **No compositing hint: scale transform on the whole world re-rasterizes.** Paint 555 to 705 ms per 5 s and Layerize 483 ms (synthetic) in zoom traces while the script itself is under 300 ms. Proposal: `will-change: transform` on `#world` while a gesture runs, rasterize at the settled scale and re-raster once after the gesture ends (the standard "zoom as bitmap, re-render on idle" pattern). Expected: Paint and Layerize cut by half or more during the gesture.
4. **`applyCam` does too much per wheel event.** At 120 Hz it runs twice per frame and each call writes `#z100` text, loops over all boards writing label transforms, calls `localStorage.setItem(JSON.stringify(cam))` (visible in the profile as `setItem`), posts to the native shell, calls `placeOverlays` and `host.emit("cam")`. Evidence: 2 to 3 recalcs per frame and 3.0 layouts per frame on mid-size files. Proposal: record the camera on each event but apply once per `requestAnimationFrame`; set label scale through one CSS variable on `#world` (`--z`) instead of per-board writes, or only update labels when the gesture ends; debounce `localStorage` and `post` to 250 ms; cache board sizes in `boxOf` instead of reading `offsetWidth`/`offsetHeight` (the forced layout). Expected: recalcs per frame 3 to 1, layouts per frame 3 to 0, busy minus 10 to 20% on working-zoom scenarios.
5. **Every `/api/*` request re-reads and re-parses the whole file.** `watched()` calls `loadDoc` first, then compares the hash. For file A that is 48 to 74 ms per request (read 14, parse 18, sha256 17), while `boardHtml` itself is 2.9 ms p50. So `/api/board` p50 is 83 ms, 97% of it file I/O. Entering the overview costs 79 requests and 6.7 s (burst of 12 concurrent: 1.0 s). CPU per board request: 81 ms. Proposal: trust the `fs.watchFile` cache and check only `stat` mtime and size per request; load again only if they differ. Expected: board p50 83 to about 5 ms, enter-overview on file A from 6.7 s to under 1 s, CPU per request 81 to about 5 ms.
6. **SSE change latency of 184 ms (file A) is about 150 ms poll plus 40 ms debounce plus parse/snapshot (87 ms CPU), and the payload is the full 117 KB doc each time.** `fs.watchFile` with `interval: 150` is the floor. Proposal: `fs.watch` on the containing directory (rename aware) with a 10 ms debounce, and send board key diffs instead of the whole payload. Expected: 184 to about 100 ms.
7. **Server memory.** File A: +44 MB heap and +153 MB RSS from one open file (parsed doc, snapshot, kept in `filesSeen`; `boardsOf` stringifies the whole doc again for keys). Not a smoothness problem; matters if many files stay open. Proposal: compute board keys from per-board hashes during parse, drop the raw string, evict `filesSeen` entries with no watchers.
8. **Stored camera is never restored.** `applyCam` persists `canvas:<file>` to localStorage on every event, but the first `doc` event always calls `fit(boards[0])`, so a reopened file always starts on its first board. Not a perf issue, but the localStorage writes in hotspot 4 buy nothing today.

## Gaps and what I did not measure

- WKWebView, the SwiftUI overlay, and a 120 Hz display. Run the zoom scenarios inside the app with Instruments or Safari Web Inspector timelines before and after hotspot 1.
- Label paint cost at z 0.02 (a label scaled up to hundreds of px). Next step: add a scenario that hides `.board>.label` via injected CSS and compare Paint time.
- GPU raster is whatever headless Chrome picks (software or SwiftShader); `Paint` times here are likely higher than on a real GPU path.
- Hover and drag-pan with the mouse are not scripted; only wheel pan and zoom. Drag-pan uses the same `applyCam`.
- Single rep for interaction scenarios. If a decision depends on a 10% difference, run `BENCH_REPS=3 pnpm bench:baseline`.
- `/api/node` is measured on the version before the "live-only node lookup" change in commit `e2fbdc4`; re-check if that handler moved.
- The `key fixed` page variant is now a no-op (the server sends the key) and doubles the page run time. Remove it from `pageBench` once nobody needs the before/after comparison.

## Rerun

```
pnpm bench:baseline              # everything, about 15 minutes
node bench/run.ts --server-only
node bench/run.ts --page-only
BENCH_FILE=/path/to/B.canvas BENCH_SCENARIOS=zoom-overview,pan-overview node bench/run.ts --page-only
BENCH_REPS=3 BENCH_HZ=60 BENCH_DUR_MS=5000 pnpm bench:baseline
```

Files: `bench/run.ts` (driver and summary table), `bench/server.ts`, `bench/server-host.ts`, `bench/inproc.ts`, `bench/page.ts`, `bench/lib.ts` (stats, synthetic generator, Chrome launcher, CDP client).
