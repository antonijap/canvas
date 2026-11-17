# Engine renderer in the page (phase 3 + 5)

Measured 2026-11-14 on the Apple M5 Pro (18 cores, 64 GB, macOS 27.0.1), headless Chrome for Testing 156.0.8078.4 with `--enable-unsafe-webgpu --use-angle=metal`, 1440x900 CSS px at device scale 2, `?shell=native`. Test file: a temp copy of a 16.9 MB real-world design file (file A) (81 boards, about 38k resolved nodes). Headless rAF runs at 60 Hz, so fps tops out at 60 for both renderers; main-thread time and frame-time tails are the numbers that separate them.

## What runs where

- Default renderer is the engine when `navigator.gpu` exists and `Engine.create` succeeds. `?renderer=dom` forces the DOM renderer. No WebGPU, an init error (including a missing `engine/pkg` build, which `/engine/*` answers with 404) or a lost GPU device switch to DOM, once, without a reload. The console logs `[canvas] renderer: engine|dom (why)`; `window.__canvas.renderer` and the page state (`/api/bridge/state`, `/api/bridge/status`) carry it.
- One `<canvas id="engine">` is the first child of `#view`, under `#world` (widgets) and the overlays. Its size comes from a `ResizeObserver` and a `(resolution: Ndppx)` media query, never from per-frame layout reads.
- `flushCam` is still the only rAF: camera work (world transform for widgets, titles, overlays, `host.emit("cam")`) when the camera changed, then `engine.setCamera` + `engine.frame()` in the same callback. It keeps scheduling itself while `frame()` returns true.
- In engine mode no board DOM is built. Board records, `#labels`, selection and hover boxes, highlights, gloss and toasts stay DOM, placed by math from `engine.nodeRect` (world coordinates).
- Click, hover and the bridge's hover state go through `host.pick(clientX, clientY)`: `engine.hitTest` when the canvas is the element under the pointer (a widget or island on top wins), `elementFromPoint(...).closest("[data-id]")` in DOM mode. Space hand mode is unchanged.
- Boards load lazily as before (viewport + 0.6 prefetch), in batches: all scenes of a batch are fetched, their fonts registered once, then each board is `setBoard`. A board whose scene differs only by position is `moveBoard`d. `setDoc` moves loaded boards right away and reloads changed ones in the same task.
- After the first batch, the rest of the document's fonts (`GET /api/scene/fonts`, the union over all boards) are registered one per idle moment, never during a gesture. Without this, a font arriving with a board mid-pan relaid out every board using that family: a 216 ms frame (2 x ~105 ms `registerFont`) at the overview.
- Images are decoded at most 512 px on the long side while no board shows them large, and again at up to 2048 px (the engine's largest mip level) once a board in view needs more, checked when the camera settles. The old bitmap is closed after the swap.
- Background follows `getComputedStyle(#view).backgroundColor`, re-read on `prefers-color-scheme` changes.
- Snapshot: `POST /api/bridge/cmd {op:"snapshot"}` first sends `freeze` to engine pages of the app's current file (the page draws a frame and copies it into a 2D canvas over the GPU one), then the shell's `WKWebView.takeSnapshot`, then `thaw`. A page that does not answer in 1.5 s is snapshotted as is.

## Bench (`pnpm bench:baseline`, page scenarios, median of 2)

`BENCH_FILE=/path/to/A.canvas BENCH_SCENARIOS=load-fit,enter-overview,zoom-overview,pan-overview,zoom-working,pan-working BENCH_NO_TRACE=1 node bench/run.ts --page-only`, plus `BENCH_QUERY="&renderer=dom"` for DOM. Results: `bench/out/engine.json`, `bench/out/dom.json`.

| | engine | DOM |
|---|---|---|
| load-fit: first contentful paint | 48 ms | 24 ms |
| load-fit: first board painted | 227 ms | 97 ms |
| load-fit: whole viewport drawn | 481 ms | 930 ms |
| load-fit: DOM nodes / JS heap | 548 / 1.5 MB | 1,497 / 1.0 MB |
| enter-overview: settle (81 boards) | 1,027 ms | 1,344 ms |
| enter-overview: main-thread task time | 709 ms | 650 ms |
| enter-overview: DOM nodes added | 0 | 52,510 |

Interaction, 5 s of 120 Hz wheel input (fps / frame p95 / frames over 16.7 ms / main thread busy ms):

| Scenario | engine | DOM |
|---|---|---|
| zoom-overview | 60 / 16.7-16.8 / 0 / 251-260 | 60 / 16.7-16.8 / 0 / 255-268 |
| pan-overview | 60 / 16.7-16.8 / 0 / 218-232 | 60 / 16.7 / 0 / 232-236 |
| zoom-working | 60 / 16.7 / 0 / 188-199 | 60 / 16.7 / 0 / 133-140 |
| pan-working | 60 / 16.8 / 0 / 179-186 | 60 / 16.7 / 0 / 132-135 |

At the overview (below 10% zoom) the DOM renderer shows flat placeholder rectangles (`lod=flat`); the engine draws every board's content for about the same main-thread time. The bench's "working" camera mostly shows empty canvas (its scan for a node to select finds nothing in either renderer), so it measures the fixed cost per frame: the engine's `frame()` adds about 10 ms per second of main-thread time there.

## Dense camera and memory (scratch harness, same input)

Board "Weekly plan and check-in v2" fitted (56%), and all boards fitted (overview). Chrome footprint = sum of `footprint` over the browser, GPU and renderer processes.

| | engine board | DOM board | engine overview | DOM overview |
|---|---|---|---|---|
| zoom: fps / p99 / max ms | 60 / 16.8 / 16.8 | 60 / 16.8 / 16.8 | 60 / 16.8 / 16.8 | 60 / 16.8 / 16.8 |
| zoom: main thread busy ms | 304 | 326 | 321 | 224 |
| pan: main thread busy ms | 233 | 353 | 289 | 247 |
| engine GPU time per frame (`gpuDoneMs`) | 1.7-4.0 | | 1.7-1.8 | |
| tiles / WASM memory | 253 MB / 81-88 MB | | 38 MB / 153 MB | |
| DOM nodes | 993 | 6,291 | 993 | 65,976 |
| Chrome footprint | 1,160 MB | 494 MB | 1,396 MB | 1,103 MB |

Memory trail at the overview: 4,330 MB with full-size `ImageBitmap`s kept for 250 images (renderer process 3.4 GB), 1.8 GB renderer with a 2048 px cap, 580 MB renderer (1.4 GB total) with the 512/2048 split. At a board view the tile cache sits at its 256 MB default budget (`setTextureBudget`), which is most of the gap to DOM.

## Live edits

`/api/update` on a text node, 4 runs each: POST to SSE event 207-241 ms in both renderers (server write + watcher). SSE to the engine taking the new scene 9-10 ms, to the next drawn frame 8-14 ms more. DOM: SSE to swap 23-26 ms.

## Fidelity through the real page

Engine page vs `?renderer=dom` page at the same camera, view area only, DPR 2, `fidelity/diff.ts`:

| Board | zoom | mismatch | SSIM |
|---|---|---|---|
| A components board | 24.5% | 0.42% | 0.989 |
| Weekly plan and check-in v2 | 55.7% | 0.34% | 0.988 |
| 03 | 26.5% | 0.32% | 0.991 |
| Brand exploration 22 Oct | 29.7% | 0.35% | 0.986 |
| Lessons 2+ format 2 Nov | 190% | 0.07% | 0.984 |
| 4.10.7 Pronunciation score | 190% | 0.08% | 0.984 |
| Full-screen paywalls (8 images) | 190% | 0.03% | 0.977 |
| A board with 10 images | 190% | 0.10% | 0.987 |
| 01 (images) | 26.5% | 0.67% | 0.983 |

The image boards give the same numbers when the overview loads them first (small decodes) and the camera then zooms in (upgrade on settle).

Hit-test parity, same camera, a 23 px grid (1,482 points per board), `host.pick` engine vs DOM: 99.5 to 100% identical on 8 boards. Every difference checked was a point within 1 world px of a node edge, where float rounding picks the parent or the child; node rects agree to the pixel.

## Not measured here

- WKWebView (the app) and a 120 Hz display: headless Chrome only.
- Whether `WKWebView.takeSnapshot` shows the WebGPU canvas on its own; the freeze step makes it not matter, but it is verified only in Chrome (CDP screenshots include the engine canvas with and without freeze).
