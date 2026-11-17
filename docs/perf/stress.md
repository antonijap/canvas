# Stress tests (E1)

Adversarial pass before the maintainer tests: worst-case files, hostile input, a 30-minute soak, cold start and media memory. Measured 2026-11-14 on the Apple M5 Pro (18 cores, 64 GB), headless Chrome for Testing 156 with WebGPU (`--enable-unsafe-webgpu --use-angle=metal`), 1440x900 CSS px at device scale 2, rAF at 60 Hz. Machine load average 3 to 4 during the runs (other agents working), so treat single frames near 33 ms as noise unless they repeat.

Harness: `bench/stress.ts` (`BENCH_PORT=5287 node bench/stress.ts <scenario...>`). It runs the real server in its own process and the real page in headless Chrome, on temp copies only (a real file is copied first) and on generated files. Per scenario it reports frame deltas from rAF, grey-placeholder frames (engine stat `tilesBlank`, new), boards in view not loaded yet, engine CPU per frame, JS heap, WASM memory, GPU budgets, DOM nodes, event listeners, live timers, Chrome RSS and phys_footprint (all Chrome processes), page errors, and file integrity on disk after every edit storm. Evidence: `docs/perf/stress/` (before.json, after.json, soak-before.json, soak-after.json, growth.json).

Before = the tree at the start of this pass (committed `dd899fc` plus uncommitted work then present). After = this pass's fixes (the code went into `86576a8` together with other work).

## Headline

| | Before | After |
|---|---|---|
| Overview of 500 boards / 99k nodes: longest frame while boards load | 7,150 ms | 50 ms (1 to 3 frames over 33) |
| 1,150 boards / 228k nodes / 59 MB file: open to settled | 120.7 s | 8.5 s |
| same file: frame p50 / max while zooming and panning | 383 / 433 ms | 16.7 / 16.8 ms |
| same file: idle CPU after the gesture | 114% (still placing boards) | 0% |
| Page switch in the middle of a fly-to (the real file, 30x): p95 / max / frames over 33 ms | 100 / 250 ms / 31 | 16.7 / 16.8 ms / 0 |
| 200 images of 8192x8192 on one board: longest frame | 83 ms | 16.8 ms |
| same: decodes that failed ("could not be decoded") | 10+, 83 retry timers | 0 |
| Text in Apple Color Emoji, four weights: WASM memory | 597 MB (274 MB of font bytes) | 407 MB |
| Drag 50 selected boards: frames with grey placeholders | 11 (up to 46 slots) | 0 |
| 30-min soak: event listeners / DOM nodes at the end | 5,525 / 16,704 (from 453 / 1,979) | 453 / 2,021 |
| Real file cold start, warm tab: whole view drawn | 997 ms | 736 ms |
| Video cards in view: live `<video>` decoders (8 cards) | 8 | 4 |

## Scenarios (after)

Frame deltas over the whole gesture. Over 33 = frames that took longer than two vsyncs.

| Scenario | p50 / p95 / max ms | over 33 | Grey frames | Notes |
|---|---|---|---|---|
| Pinch 2% to 800% and back, 6 times, the real file | 16.7 / 16.7 / 16.8 | 0 | 0 | tiles peak at the 256 MB budget, never over |
| Pan the 500-board overview while boards load | 16.7 / 16.8 / 50 | 1 to 3 | 112 (boards with no texture yet) | settled 0.8 s after the gesture |
| 30 page switches mid fly-to | 16.7 / 16.7 / 16.8 | 0 | 75 (new page, first textures) | camera ends valid, page drawn |
| 300 MCP set_node_props + 60 inspector edits + 6 structure ops during pan and pinch | 16.7 / 16.8 / 16.8 | 0 | 0 | 366/366 writes 200, file parses, every last value on disk, no duplicate ids |
| Drag 50 selected boards | 16.7 / 16.7 / 16.8 | 0 | 0 | all 50 moved by the same delta on disk |
| Resize a board with 5,000 children live | 16.7 / 16.7 / 16.8 | 0 | 0 | size on disk matches |
| 200 window resizes in 4 s (DPR 1 and 2), then pinch | 16.7 / 16.8 / 16.8 | 0 | 0 | canvas back at 2880x1800 |
| Theme switch on every pinch step (20x) | 16.7 / 16.8 / 16.8 | 0 | 0 | background follows |
| 20 shader + 8 video cards on screen, pan and pinch | 16.7 / 16.8 / 16.8 | 0 | 0 | 4 cards play (engine cap) |

"Grey frames" counts frames where the engine drew its grey placeholder for part of a board. After the fixes it only happens for a board that has never had a texture: a board that just loaded at the overview, or the first frames of a page that was not open. Content that was on screen never goes grey.

Worst-case files (open, then zoom 2% -> pan -> 100% -> pan -> 400% -> 5%):

| File | Size | Open to settled | Gesture p95 / max | WASM | Tiles | Idle after |
|---|---|---|---|---|---|---|
| 500 boards, 99k nodes | 25 MB | 12.6 s -> 2.8 s | 16.7 / 16.8 | 158 MB | 49 MB | 0.4 ms/s page, 0.2% Chrome |
| 1,150 boards, 228k nodes | 59 MB | 120.7 s -> 8.5 s | 433 / 433 -> 16.7 / 16.8 | 349 MB | 94 MB | 1,129 -> 0.3 ms/s |
| 30 boards, 60 nested levels | 0.3 MB | 0.4 s | 16.8 / 16.8 | 2 MB | 0 | 0.3 ms/s |
| 20 boards, 1,200 texts: CJK, Arabic, Hebrew, emoji ZWJ, combining marks, missing fonts | 0.4 MB | 3.9 s | 16.8 / 16.8 | 597 -> 407 MB | 16 MB | 0.4 ms/s |
| 50 components (nested), 2,000 instances with overrides | 0.3 MB | 6.1 s -> 1.1 s | 16.7 / 16.8 | 103 MB | 82 MB | 0.4 ms/s |
| 200 images of 8192x8192 on one board, 4 boards with one each | 0.03 MB + 200 JPEGs | 6.2 s -> 0.6 s | 83 -> 16.8 max | 3 MB | 32 MB | decodes run on in the worker for ~15 s (200% CPU, off the main thread), then 0 |

No page exceptions, engine errors or console warnings in any scenario after the fixes (that file itself has two image references that 404, also in the original).

## What broke, and the fixes

1. **Placing boards froze the page** (`src/page/engine-view.js` `loadBoards`, `src/server.ts` `engineLoad`). Every board of a batch was laid out in one task: 500 boards at the overview = a 7 s frame. Now boards are placed nearest the view first, in slices of at most 8 ms during a gesture and 20 ms while the camera is still (always one board) that start right after a frame, and each board lands (title, placeholder, hit tests) as soon as it is in. A batch that fails marks every board for the retry backoff, so none is left "loading" forever. Tests: `board placement in slices` in `test/engine-view.test.ts`.
2. **Restacking was quadratic and called the engine for every pair.** Each fresh board ran `boardsToReorder` over all loaded boards, and each check asked the engine for `nodeRect`, which searched every board's index. The 59 MB file spent 15 of 20 s there. Now board rects are cached from `setBoard` (and follow moves and font relayouts), overlapping pairs come from a sweep along x, and restacking runs once per batch, only when a new board overlaps another. New engine call `nodeRectIn(board, id)` looks in one board first; the page uses it for overlays and image sizes. Test: `restacking on a 1,000-board file`.
3. **Image decodes blocked the main thread and ran unbounded.** Shrinking a decoded 8k image to 2048 px ran on the main thread (80 ms; a real-file page switch spent 1.7 s in `createImageBitmap` and 0.3 s in `close`), and 200 large decodes at once failed for memory. Decoding and shrinking now happen in a worker (from a Blob URL, no new file), three at a time, with the full-size bitmap closed in the worker. A worker that cannot decode falls back to the main thread per image, and after three such cases for good. A URL that answers 4xx is warned about once per page, not on every page visit (the soak logged the same two 404s hundreds of times). Tests: `image decoder worker`.
4. **A text set in Apple Color Emoji got the whole 183 MB face, once per weight** (`src/scene.ts`). It now gets the subset of glyphs the text uses that the face has (one file whatever the weights); every other character falls back as before (a CJK character in the same text still gets its platform font). Test in `test/scene.test.ts`. Known limit, same as the fallback path: the subset has no ZWJ sequences, so a family emoji draws as its parts.
5. **Dragging boards showed grey placeholders** (`engine/src/api.rs` `move_board`, `engine/src/cache.rs` `shift_board`). A move bumped the board's generation and left its textures where it had been; with 50 boards moving, the tile budget could not re-render them all each frame. The textures now move with the board and stand in until the new grid renders. Test: `a_moved_board_keeps_its_textures_as_stand_ins_where_it_is_now`.
6. **Video cards leaked their whole DOM on every page visit** (`src/page/widget-kinds.js`). Each video card's MutationObserver watched the entire widget layer, so a removed card stayed alive and its callback ran on every class change. Eight visits to a page with eight video cards left 64 dead cards. It now watches the card's own element. Regression check: `probe-leak` in the harness (detached elements after 24 page switches: 64 cards -> 0; listeners stay at 150 on that page instead of 502 -> 854).
7. **Every video card near the view held a decoder** (`src/page/videos.js`). The engine plays at most four cards, but each card within a screen of the view kept a `<video>` element. Now only the four largest on screen keep one (autoplaying cards before paused ones), plus any card the person pressed play on or hovers; others go after 3 s (15 s when far) and show their poster again. A card added while the page is open gets its element on the same pass. Tests: `video elements kept` in `test/videos.test.ts`.
8. **Eviction could drop a board's only whole picture.** A stale base texture now counts as fresh while its board has no fresh one (`engine/src/cache.rs`; test `a_stale_base_outlives_other_tiles_while_its_board_has_no_fresh_one`). The pinch scenario's grey frames before were mostly a metric artefact (slots whose uncovered strip lies outside the board, where nothing is drawn); the metric now counts only drawn grey.
9. **GPU textures were never destroyed** (`engine/src/gpu.rs`, `engine/src/shade.rs`, `engine/src/api.rs`). wgpu 30's WebGPU backend does not call `GPUTexture.destroy()` when a texture is dropped, so every evicted tile, blur job, image level, card texture and video staging texture held GPU memory until the JS garbage collector finalized its handle, which a page with a 4 MB heap rarely does. They are now destroyed when the engine lets go of them (the GPU frees them after work already submitted). The blur pass temporaries and uniform buffers too. No WebGPU validation errors in any scenario afterwards (this one was not in a Codex round).

Codex reviewed the fixes (read-only) in two rounds. The first round (fixes 1 to 4 and 7) found nine issues, all fixed before the after-runs: restacking inside slices (now once per batch), worker failures never falling back, the full decode leaking when shrinking failed, worker jobs left pending on destroy, stale cached rects after a font relayout, a new video card never getting an element, paused cards starving autoplaying ones, a dropped card losing its picture, and emoji coverage hiding CJK fallbacks. The second round (fixes 5, 6 and a 404 cache) found two: a remembered 404 could hide an image an agent writes later (dropped: the page asks again on the next visit, as before, and only the warning is once per page), and after a board move a tile rendered in the same frame could leave a one-pixel sliver for one frame (covers are now worked out again after any tile renders).

## Soak (30 min, the real file)

Loop: pinch to 30%, pan, pinch to 400%, pan back, 20 MCP text edits; every 8th loop a page switch, every 4th the media cards (20 shaders, 8 videos) in view. Memory sampled every 30 s (GC every 5 min).

633 loops, 12,660 MCP edits (0 failed), about 80 page switches and 160 visits to the media cards. File on disk whole after the soak (parses, no duplicate ids, every last edit present). Frame p95 per loop 16.8 ms in every loop; 0 frames over 33 ms after (4 before). No page exceptions or engine errors.

Samples after a forced GC (every 5 min), after the fixes:

| min | JS heap | WASM | tiles | images | card tex | Chrome footprint | listeners | DOM nodes | timers | server heap / RSS |
|---|---|---|---|---|---|---|---|---|---|---|
| 0 | 2.8 | 77 | 8 | 13 | 33 | 1,580 | 453 | 1,979 | 1 | 35 / 487 |
| 5 | 3.8 | 97 | 9 | 7 | 10 | 1,523 | 577 | 3,041 | 4 | 102 / 506 |
| 10 | 4.9 | 107 | 8 | 7 | 10 | 1,778 | 1,197 | 8,536 | 5 | 47 / 488 |
| 15 | 4.8 | 107 | 9 | 7 | 10 | 1,808 | 1,011 | 6,817 | 5 | 90 / 606 |
| 20 | 11.8 | 107 | 0 | 0 | 15 | 2,508 | 453 | 2,017 | 1 | 65 / 626 |
| 25 | 6.3 | 107 | 3 | 4 | 10 | 2,140 | 1,197 | 8,435 | 5 | 82 / 592 |
| 30 | 6.4 | 110 | 0 | 0 | 15 | 2,633 | 453 | 2,021 | 0 | 64 / 596 |

(MB; listeners and DOM nodes depend on which page shows: the same page always comes back to the same count, 453 / ~2,000 on "Final".) Before the fixes the same counts only went up: 453 -> 1,245 -> 2,037 -> 3,795 -> 4,179 -> 4,325 -> 5,525 listeners, 1,979 -> 16,704 DOM nodes.

- Plateau: JS heap (3 to 12 MB, swings with what is loaded), WASM (77 -> 110 MB, the high-water mark of the largest page; WebAssembly memory never shrinks), tiles, images and card textures under their budgets, live timers 0 to 5, intervals constant at 5, server heap and RSS flat.
- Not a plateau: Chrome footprint drifts up in a sawtooth, +600 to 1,000 MB over 30 min, both before and after. Traced to page switches (below, Not fixed).
- Idle afterwards: page tasks 6.9 ms/s, Chrome 2.2% CPU (the 4 playing cards were on the last page shown; with no cards in view 0.3 ms/s and 0 to 1%).

## Cold start (the real file, temp copy, three fresh tabs)

Time from navigation to the first board drawn, and to every board in the view drawn with the engine idle.

| | Before | After |
|---|---|---|
| First tab (server cache cold): first board / whole view | 994 / 2,424 ms | 782 / 1,954 ms |
| Second tab: first board / whole view | 425 / 999 ms | 409 / 811 ms |
| Third tab: first board / whole view | 420 / 997 ms | 383 / 736 ms |

Boards are placed nearest the view first, in 20 ms slices while the camera is still (8 ms during a gesture), so the first board shows sooner and the view fills sooner than in one task. Run-to-run spread is about 300 ms at this machine load.

## Media memory (20 shader + 8 video cards, 1080p H.264)

Fresh tab per state, same zoom; Chrome footprint summed over all its processes.

| | Before | After |
|---|---|---|
| Live `<video>` elements, cards in view | 8 | 4 |
| Cards playing (engine cap) | 4 | 4 |
| Chrome footprint, cards in view / empty canvas | 1,681 / 1,390 MB | 1,649 / 1,329 MB |
| Card textures / video staging | 7-13 / 8 MB | 14-21 / 8 MB |
| Frames over 33 ms while the cards appear | 3 (max 117 ms) | 0 (max 16.8 ms) |

Headless Chrome decodes 1080p H.264 in hardware with little memory per element, so the footprint difference here is within run-to-run noise (about 100 MB). The 1.43 -> 2.23 GB the maintainer saw is WKWebView, where each `<video>` keeps its own media player and frame pool; halving the elements removes half of those. Not verified in Canvas.app: worth one look in Activity Monitor with 8 videos on screen.

## Round 2: memory on page switches, write latency, video in WKWebView

Same machine and harness, 2026-11-14 evening. Before = the tree at `bcc09de` (86576a8 plus other agents' UI work).

| | Before | After |
|---|---|---|
| Page switching 3 min (probe-gpu): Chrome GPU process | 422 -> 800 to 1,046 MB, sawtooth; 469 only 30 s after it stops | 486 -> 554 to 612 MB, flat |
| same: GPU textures made and freed per minute | about 4,600 MB (vello atlases 3,400, tiles 540, images 530, effects 140) | about 25 MB (1,500 with fix 1 alone) |
| 30-min soak (media cards, page switches, 12k edits): Chrome footprint | 1,580 -> 2,633 MB | with fixes 1 to 4: 1,665 -> 2,774 MB (still drifting; fix 5 found after this run, its 30-min soak not run yet) |
| 100 concurrent `set_node_props`, server only (18 MB file): p50 / p95 | 218 / 398 ms | 47 to 50 / 101 to 111 ms |
| same during pan and pinch (edit-gesture, 3 runs): p50 / p95 | 242 / 475 ms | 46 to 52 / 112 to 206 ms (bursts 2 and 3: 40 to 63 / 43 to 72; the first burst, while the page is still loading, carries the tail) |
| One edit, 18 MB file: p50 / p95 | 4.0 / 10 ms | 4.0 to 4.9 / 7 to 13 ms (one F_FULLFSYNC of the journal) |
| WKWebView, 8 cards of a 4K H.264 clip visible: WebContent + GPU process over an empty canvas | +1,772 MB (WebContent 1,489, GPU 601) | +346 to +353 MB (431 / 233) |
| same: engine CPU per frame | 10 ms | 5 ms |

### What it was, and the fixes

1. **vello freed its image atlas on every render without images** (`engine/src/gpu.rs`). vello 0.11 resolves a scene with no gradient, glyph or image as "solid paths only" and reports an atlas of size 0; on that it frees its atlas texture, and the next scene with an image allocates a new one (2048 or 4096 px square, 16 to 64 MB) and uploads every image again. Tiles, effect renders and the atlas flush alternate between the two kinds, so a page switch made and destroyed a few atlases a second: 3.4 GB of GPU textures a minute of switching, found with a WebGPU object probe in the harness (`probe-gpu`, `STRESS_GPU_PROBE=1`: every buffer and texture by label, made / destroyed / collected; stacks of the big unlabeled ones). Destroyed textures go back to the OS lazily, which was the GPU process's sawtooth. Every render now draws a 1x1 transparent image outside its target, so the resolver never takes that path and the atlas stays (one atlas for the whole run). No vello patch.
2. **Page switches threw every board away** (`src/page/engine-view.js`, `engine/src/api.rs`, page script in `src/server.ts`). Leaving a page removed its boards from the engine, which freed their tiles, image textures and layout; coming back laid out, decoded and rendered it all again (with fix 1 alone still 1.5 GB of textures a minute: tiles, images, gradient ramps, effects). Boards of the page left are now parked: `setBoardHidden` keeps them laid out but out of drawing, hit tests, `nodeRect` and `boardsInView`, their images stay registered, and their tiles age out under the normal tile budget. Going back is a move and a show, no layout. Parked boards are bounded (60,000 nodes or 300 boards, oldest parked first out); a board deleted from the file while parked is removed. The real file keeps all 78 boards in the engine: WASM 160 MB instead of 107 to 110 MB (WebAssembly memory is reserved once, so that is the new high-water mark, not growth). Tests: `parked boards` in `test/engine-view.test.ts`.
3. **The crash journal fsynced once per edit** (`src/docwriter.ts`). Each edit's journal line was fsynced (`F_FULLFSYNC` on macOS, 3.4 ms) inside `editDoc`, so 100 concurrent edits waited in line: 1.3 s of the 4 s bench was in `fsyncSync`. It is now a group commit: the line is appended at once, one `fs.fsync` off the main thread covers every line written before it started, and the next round collects what came meanwhile. The guarantee stays: the server holds every response (`gateOnJournal` in `src/server.ts`: writes and end, in order, with backpressure) until the fsync covering the edits made so far is done, so an edit is never answered, and never announced to a bridge wait or an event stream, before its journal line is durable. A failed fsync is reported and the journal rewritten from what is pending, as before. Tests 58 to 61 in `test/docwriter-safety.test.ts`.
4. **A document font decoded on the event loop** (`src/fontfiles.ts`). The WOFF2 Brotli step of a document font ran synchronously in `findFont` while a page loaded: 420 ms during which no edit was answered (the first burst of edit-gesture). It now runs in the thread pool (`toSfntFile`).
5. **The renderer grew 25 MB a minute while the camera moved** (`src/page/bridge.js`). Found after fixes 1 and 2, with the probe's activity loops (`STRESS_LOOP`): idle flat, any camera motion (wheel or a camera set from the page) +25 MB/min, JS heap, WASM, GPU and DOM flat, Blink's `Resources` counter 271 -> 1,580 in 3 min. The page reports its camera to the server (`POST /api/state`, about 6 a second while it moves) and never read the answers; an unread response keeps its network resource alive. The body is now read and dropped (also for two rarer posts in `videos.js` and `widgets.js`). 4 min of camera motion: renderer 577 -> 581 MB, `Resources` 14 to 54.
6. **4K video cards in WKWebView** (`src/videos.ts`, `src/page/videos.js`). WebKit keeps a 4K stream's decoder surfaces and the frames the engine reads at the stream's own size: four playing 4K cards cost +1.3 GB in the GPU process even as plain `<video>` elements, and the engine's frame reads put another 1.1 GB on WebContent. Cards now play a proxy of about their on-screen size: the page asks `/api/videos/<id>/variant` with the card's long side in device px; the server answers a tier (640, 960, 1280 or 1920 px long side, shown at most 25% larger) or the file itself when it is no larger, makes missing proxies with macOS's `avconvert` (AVFoundation, no new dependency; one at a time, 3 to 5 s for this clip) into `~/Library/Caches/Canvas/video-proxies/<hash>-<tier>.mp4`, and the 640 one right after an import. The file in the package is untouched (export, Reveal). A proxy URL (`&v=<tier>`) only ever serves that proxy, so one element never mixes two files. While the tier a card needs is being made, a ready one stands in (or the poster shows); zooming to another tier swaps the element at the same time (measured: zoom in, 1920 tier; zoom back, 640, memory back). Tests: `video proxies` in `test/videos.test.ts`. Evidence: `docs/perf/stress/video-wk.json`.

Codex reviewed the save-path change read-only in three rounds. Round 1: the fsync error path could close the journal fd twice (a newer journal can get the same number), skipped the rewrite when the journal had been replaced or kept aside, and bridge events and event-stream messages could announce an edit before its fsync. Round 2: held writes returned true, so a piped video stream ignored backpressure. Round 3: a synthetic "drain" could follow `end()`. All fixed and covered by tests 58 to 61. Left as is (both bounded by one fsync, a few ms): writers that ignore backpressure (event streams) and pipelined requests queue what they send during that fsync.

### Measured and not taken

- VideoFrame vs copying straight from the `<video>` element: same memory.
- Drawing each frame into a 2D canvas at card size and copying that: 80 to 180 MB less, but 25 ms of engine CPU per frame instead of 10. Dropped.
- Smaller proxies: 8 cards through the engine cost +356 MB at 640x360, +425 at 960x540, +496 at 1280x720, +701 at 1920x1080. One playing card alone costs +255 to +338 MB, and the same videos as plain `<video>` elements cost 25 to 220 MB: most of what is left is WebKit's WebGPU video import itself (GPU process 26 -> 230 MB as soon as one frame is copied).

## Not fixed (reported)

- **30-min soak after fix 5 not run.** Measured alone: page switches (GPU process flat, fixes 1 and 2), media visits (flat), camera motion after fix 5 (renderer flat over 4 min). Gestures with edits were measured only before fix 5 (renderer +25 MB/min, the same leak). The full mixed 30-min soak still has to confirm the plateau (target within 100 MB).
- **Edit burst during page load: p95 up to 206 ms in 2 of 3 runs (target 200).** The first of the three bursts lands while the page still fetches scenes, fonts and images; the server is mostly idle then (profiled), and the journal fsyncs take 4 to 20 ms, so the tail is request queueing around the page load and 100 fresh connections. Steady state: p95 43 to 72 ms.

- **WKWebView video: +350 MB for 8 visible cards, target was +300.** What remains is WebKit's fixed cost of copying video frames into WebGPU (one card: about +250 to +340 MB whatever its size). Going below it means not reading frames into WebGPU at all, for example showing playing cards as positioned `<video>` elements over the canvas (4 plain 640 px elements: +82 MB), which changes how cards stack with shader cards and overlays. Not done without a decision.
- Grey placeholders for boards that never had a texture (loading at the overview, first frames after a page switch): 2 to 5 frames per switch. That is loading, not lost content; prerendering other pages' boards would cost memory.
- WASM memory never shrinks (WebAssembly limit): the text file's 407 MB stays until reload.
- 200 8k images take 10 to 15 s to all decode, three at a time; the board shows soft stand-ins meanwhile.
- Not measured: WKWebView, a 120 Hz display.

## Round 3 (2026-11-15): soak after the /api/state fix, first-burst tail

- **30-min soak at 345f8c4** (`docs/perf/stress/soak-r3.json`; 635 loops, 12,700 MCP edits, 0 failed, file whole, no page errors, frame p95 16.8 ms): Chrome footprint 1,673 MB at the start, then 1,683 to 2,079 MB from minute 6 to 30 with no trend (least-squares slope +2 MB/min, swing set by which page shows). Same page ("Final") at minute 6 and minute 29.5: 1,991 and 2,002 MB. Plateau holds within 100 MB; WASM settles at 168 MB (parked boards' high-water mark), server RSS flat at about 515 MB. Machine load average 5 to 25 during the run (other agents), 13 frames over 33 ms in 635 loops.
- **12-min soak on the round-3 tree** (`soak-final.json`): same shape, "Final" 1,668 to 1,898 MB from minute 6.5 on, 5,160 edits, 0 failed.
- **First-burst tail.** Two server costs, both fixed: a freshly loaded file had no "shown" snapshot, so the first diff after load named a base no page had and every page fetched the whole document again; and each turn of the loop with an edit rebuilt the full board, component and usage payload for open pages. Now the loaded snapshot counts as shown, and page broadcasts are coalesced to one per 40 ms per file (bridge events stay immediate). 100 concurrent edits right after load (in-process probe, A/B interleaved, 3 runs): CPU 1,005 to 1,246 ms -> 545 to 615 ms, p95 725 to 2,033 -> 551 to 661 ms at load average 20 to 29. The edit-gesture p95 itself could not be re-measured cleanly at that load (baseline runs swung from 114 to 1,208 ms).
