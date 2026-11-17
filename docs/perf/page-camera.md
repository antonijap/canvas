# Page camera work (hotspots 2, 3, 4 and board labels)

Measured 2026-11-14, same harness as `baseline.md`: file A (copy in `bench/out/copies`), 5 s of 120 Hz wheel input, headless Chrome 156, 3 reps each, median in brackets. Before = HEAD `0eb6bfc` in a scratch worktree. Rerun an "after" variant with `BENCH_QUERY="&lod=cull" BENCH_REPS=3 BENCH_FILE=/path/to/A.canvas BENCH_SCENARIOS=zoom-overview,pan-overview,zoom-working BENCH_NO_TRACE=1 node bench/run.ts --page-only` (`BENCH_QUERY` is appended to the page URL; `lod=off|cull|flat`, `wc=1`).

## Numbers (fps / p95 / p99 ms / frames over 25 ms / long tasks / main thread busy ms of 5000)

| Scenario | Before | Camera loop + labels only (`lod=off`) | + cull (`lod=cull`) | + flat LOD (default) |
|---|---|---|---|---|
| zoom-overview | 52.8 / 33.4 / 50 / 29 / 3 / 4,548 | 55.5 / 33.3 / 50 / 18 / 2 / 3,814 | 54.7 / 33.3 / 50 / 20 / 3 / 2,819 | **60 / 16.8 / 16.8 / 0 / 0 / 316** |
| pan-overview | 52.7 / 33.3 / 50 / 30 / 3 / 4,669 | 56.3 / 33.3 / 50 / 17 / 1 / 4,321 | 55.1 / 33.3 / 50 / 21 / 1 / 3,251 | **60 / 16.8 / 16.8 / 0 / 0 / 290** |
| zoom-working | 60 / 16.7 / 16.8 / 0 / 0 / 430 | 60 / 16.7 / 16.8 / 0 / 0 / 238 | 60 / 16.7 / 16.8 / 0 / 0 / 162 | 60 / 16.8 / 16.8 / 0 / 0 / 154 |
| recalcs per frame (zoom-overview / zoom-working) | 1.37 / 1.91 | 0.98 / 0.99 | 0.98 / 0.99 | 0.98 / 0.98 |

Before the change, zoom-working showed 1.9 recalcs per frame (every board label rewritten per wheel event); now 1.0, the floor. Layouts per frame went from 0.01 to 0.2 to 0.5 in the overview: the label `max-width` writes (contained in `#labels`, tiny). zoom-working still has 0 layouts.

## What changed (src/server.ts PAGE script)

1. Camera loop: `applyCam()` only marks a gesture and requests one rAF. `flushCam()` writes the world transform, the zoom text (only when the rounded % changes), places labels and culls boards, places overlays, calls `scheduleVisible`, then `host.emit("cam")` once. `cam` itself is updated immediately, so math readers (`host.cam`, bridge, widgets) are always current; `flushNow()` applies a pending frame before anything measures the DOM (`measureWorld`, `select`). If the page is hidden (no rAF) it flushes synchronously. localStorage camera write is debounced 250 ms (also on `pagehide`). Native `post({zoom})` only on a % change and at most every 100 ms, with a trailing send. Bridge state posts already debounce (`schedule(100)` in bridge.js), unchanged. `boxOf` reads cached sizes (`b.w/b.h`, set from meta, then measured once per board swap and written as `contain-intrinsic-size`); view size is cached (`VW/VH`, updated on resize and insets).
2. Labels: one `#labels` layer in `#view` outside `#world`. One `translate3d` per visible label per frame (rounded to device pixels), 11-12 px chrome token size, `max-width` = board screen width with ellipsis, hidden under 40 px wide or outside the viewport (display toggled only on change). The selected board's label uses the selection colour (`--c-sel`). The per-board `.label` elements and their per-event counter-scale are gone.
3. Hit testing: `gesturing` is true from any camera change until 150 ms after the last. `queueHover` does nothing while it is true, the hover box is hidden at gesture start, and `settle()` resumes hover. Verified in headless Chrome: 0 `elementFromPoint` calls during 60 wheel events, one after settle, 1 localStorage write after the gesture.
4. Compositing: `will-change: transform` on `#world` during a gesture exists but is OFF by default (`?wc=1`). Measured on the 81-board overview it cost fps (pan-overview 52 to 30 fps, busy 5,425 vs 4,321 ms without it): the layer is huge and gets rastered whole. Without it text re-rasters crisp at every scale anyway. Not helpful in the DOM fallback; revisit with the engine.
5. LOD for the DOM fallback (default `flat`): boards outside viewport plus the 0.6 prefetch margin get `content-visibility: hidden` (`.cv`, DOM kept). Below zoom 0.10 (leave at 0.11) every drawn board is `.flat`: content hidden behind a flat rectangle in the board's fill colour (read once per swap). Boards not yet drawn keep their placeholder. Cull alone cuts busy 4,548 to 2,819 ms at overview. Flat is what brings the overview to 60 fps with no long tasks (busy 316 ms). Cost: below 10% the boards are flat blocks plus titles, no content; `?lod=cull` or `?lod=off` turns it off. Content still loads while flat (parse and DOM cost remains, 12.5 MB for the full overview); a fill colour on board meta would let flat skip the fetch (follow-up, needs boards.ts).

Selection overlay behaviour from e2fbdc4 is untouched (math placement, hand mode, live-only lookup). Culled boards are shown again for any measurement inside them (`showBoard`), and re-culled the next frame.

## Not measured / caveats

WKWebView and a 120 Hz screen; headless rAF is 60 Hz. file B and synthetic files not re-run. Single bench host load per run.
