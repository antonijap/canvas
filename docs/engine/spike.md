Engine phase 0 spike: vello + wgpu (WebGPU) as WASM, in a browser and in a real WKWebView. Run 2026-11-14.

## Verdict

**GO** for WASM-in-WKWebView. Keep the native-Metal contingency on the shelf; no reason to start it.

- WKWebView on macOS 27.0.1 has `navigator.gpu` ON by default. No flag, no private API needed. Adapter reports vendor/architecture "apple".
- vello 0.11 + wgpu 30 (webgpu backend) compile to wasm and render correctly in both hosts, first try. Text via parley is crisp.
- Per-board texture cache with quad compositing (strategy 2) is the only strategy with large headroom: about 1 ms GPU per frame at any zoom, vs 14 ms (Chrome) and 27 ms (WK) for the full re-render with all 60 boards visible.
- Full re-render (strategy 1) is fine at 100% and up (3 to 5 ms) and borderline at 25%. At 5% zoom it is over a 120 fps budget in both hosts. So the plan's cache + crisp-on-settle design is required, not optional.

## Environment

- Mac: Apple M5 Pro, macOS 27.0.1 (26A434). rustc 1.98.1, wasm-bindgen-cli 0.2.130.
- Host (a): Chrome for Testing 156.0.8078.4 headless (Playwright's copy from `~/Library/Caches/ms-playwright`; no Google Chrome in /Applications). Flags `--headless=new --enable-unsafe-webgpu --force-device-scale-factor=2`. Viewport 1440x700 CSS, DPR 2 (2880x1400 px). Adapter: apple / metal-3.
- Host (b): real WKWebView in a throwaway Swift app (`engine/spike/WebViewHost.swift`), 1440x900 CSS window, DPR 2 (2880x1800 px). Not enabled by any flag. Note the WK canvas is 29% taller, so it renders more pixels than the Chrome run.
- Scene: 60 boards (10x6, 1200x800, pitch 1400x1000), 20,000 rounded rects with fill + 1.5 px stroke, 2,000 parley text runs (Arial.ttf, 12 to 28 px), board bg + border. World ~14000 x 6000.
- Zoom run: 5 s, 5% to 400% to 5% exponential, centered on board (5,3). Pan run: 5 s at 25% zoom, 12,400 world units horizontally plus a vertical sine.
- Strategies:
  - `rebuild`: re-issue all draw calls every frame for visible boards (worst case).
  - `append`: cached per-board `vello::Scene` appended with the camera transform, then one full vello render. This is "strategy 1" of the plan.
  - `tiles`: strategy 2. Each visible board rendered once into an Rgba8 texture at a power-of-two quantized scale (cap 2400 px wide), max 6 tile re-renders per frame, stale textures stay on screen until replaced; composited as textured quads. Boards leaving the viewport drop their texture.
- Culling by board bounds is on in all modes.

## Numbers

rAF is locked to 60 Hz in both hosts here (headless Chrome and the WK window; this Mac's display mode cap as exposed to the page). So rAF deltas of 16.7 ms are the floor and "frames over 8.3 ms" is 300/301 everywhere. The discriminating numbers are `render() CPU` (JS-thread cost of the call) and `GPU done` (wall time from frame start to `queue.onSubmittedWorkDone`; includes queue wait and vsync-paced present, so it is an upper bound on GPU time). WK `performance.now()` is clamped to 1 ms, so WK values are coarse.

Timestamp queries are available on the adapter (`timestamp_query: true` in both hosts) but vello's internal passes are not instrumented without wgpu-profiler (not vetted), so GPU time here is the submit-to-done proxy.

### Gestures (5 s each, ~300 frames)

Chrome (1440x700 CSS @2x):

| run | rAF p50/p95/p99 | frames >16.7 / >8.3 | render CPU p50/p95 | GPU done p50/p95/p99 | notes |
|---|---|---|---|---|---|
| zoom append | 16.7/16.7/16.8 | 0 / 301 | 1.8/6.4 | 6.5/14.0/22.6 | avg 20 boards visible |
| pan append | 16.7/16.8/16.8 | 0 / 301 | 1.8/2.3 | 8.6/10.2/10.6 | 16 boards |
| zoom rebuild | 16.7/16.8/33.4 | 14 / 287 | 4.3/21.5 | 7.9/64.7/65.1 | encode 15.5 ms p95 |
| pan rebuild | 16.7/16.8/16.8 | 0 / 301 | 5.6/7.4 | 11.5/14.4/14.7 | |
| zoom tiles | 16.7/16.8/16.8 | 0 / 301 | 0.1/1.8 | 1.3/8.3/13.9 | 360 tile renders |
| pan tiles | 16.7/16.7/16.8 | 0 / 301 | 0.1/0.2 | 1.3/1.8/5.6 | 54 tile renders |

WKWebView (1440x900 CSS @2x):

| run | rAF p50/p95/p99 | frames >16.7 / >8.3 | render CPU p50/p95 | GPU done p50/p95/p99 | notes |
|---|---|---|---|---|---|
| zoom append | 17/18/18 | 21 / 300 | 2/8 | 7/28/28 | 22 boards |
| pan append | 17/17/18 | 15 / 301 | 3/4 | 16/23/27 | 18 boards |
| zoom rebuild | 17/29/30 | 70 / 267 | 4/26 | 9/57/62 | 53 fps average |
| pan rebuild | 17/18/18 | 19 / 298 | 8/11 | 27/30/31 | |
| zoom tiles | 17/18/18 | 15 / 300 | 0/1 | 1/11/19 | 373 tile renders |
| pan tiles | 17/18/18 | 27 / 300 | 0/1 | 1/3/9 | 65 tile renders |

(WK ">16.7" counts ticks at 17+ ms after rounding; with the 1 ms clock these are mostly 17 ms ticks, not real misses. The real drops are `zoom rebuild`, 53 fps.)

### Steady state, one frame at a fixed zoom (60 frames, GPU done p50 ms)

| zoom | boards visible (Chrome/WK) | rebuild | append | tiles |
|---|---|---|---|---|
| 5% | 60 | 67 / 56 | 14.3 / 27 | 1.2 / 1 |
| 25% | 15 / 25 | 10.6 / 30 | 8.1 / 13 | 1.2 / 1 |
| 100% | 1 | 3.6 / 5 | 2.9 / 4 | 1.2 / 1 |
| 400% | 1 | 3.7 / 4 | 2.5 / 4 | 1.2 / 1 |

Chrome / WK. The settle (one crisp full re-render at the final camera, measured at the end of each run) takes about 15 ms to the next rAF in both hosts, i.e. one frame, invisible after a gesture.

WK is about 1.5 to 2x slower than Chrome on vello compute for the same work, and WK draws 29% more pixels in this setup, so treat WK as the planning number.

### Startup

| | Chrome | WKWebView |
|---|---|---|
| wasm fetch + compile (`init()`) | 8 ms | 33 ms |
| wgpu device + vello renderer init (shader pipelines) | 12 ms | **587 ms** |
| scene build (20k rects + 2k parley layouts) | 57 ms | 58 ms |
| first frame | 9 ms | 15 ms |
| total to first frame | 166 ms | 707 ms |

WK pipeline creation dominates (~0.6 s). Mitigation if it matters: `AaSupport::area_only()` is already used (fewer permutations); pipeline cache is exposed in `RendererOptions` and can be tried in phase 5; show the DOM renderer or a skeleton while the engine warms.

### Size and memory

- `engine/pkg/canvas_engine_bg.wasm`: 3,220,466 bytes raw (3.07 MB), 947,457 bytes gzip -9 (0.90 MB). Release: opt-level 3, lto, codegen-units 1, panic=abort. No wasm-opt run (not installed, not vetted); it would likely trim this.
- WASM linear memory after the full run: 26.9 MB (Chrome), 34.4 MB (WK). JS heap: 1.9 MB (Chrome; `performance.memory` is absent in WebKit).
- GPU texture memory in the tile strategy: visible boards only, at most ~2400x1600x4 = 15 MB per board at the cap; 1 board at 100%+, 60 tiny ones at 5%.

## Text quality

Screenshots (canvas `toBlob` after a strategy-1 render, 2880 px wide):

- Chrome 100%: a scratch screenshot, not kept
- Chrome 300%: a scratch screenshot, not kept
- WKWebView 100%: a scratch screenshot, not kept
- WKWebView 300%: a scratch screenshot, not kept

Glyphs are smooth and correctly shaped at 100% and 300%, edges clean, grayscale AA (no subpixel/LCD AA, unhinted since glyphs are drawn as vector paths). Rounded rects, strokes and text look identical in both hosts. Looks like Skia grayscale quality, slightly lighter than macOS DOM text at small sizes; not compared pixel-for-pixel against the DOM renderer. One thing for phase 2: tiles are bilinear-sampled and up to 2x oversampled, so a gesture frame is slightly soft until the settle re-render.

## Baseline comparison

`docs/perf/baseline.md` does not exist yet (the directory is empty), so no DOM comparison. Add one once the baseline lands: same scene shape (60 boards, 20k nodes) and the same zoom/pan script is in `engine/spike/spike.js`.

## Dependencies and supply chain

- Exactly the vetted list, exact versions, `default-features = false` where specified. Only the surface actually called is `vello`, `wgpu` (through vello), `parley`, `peniko`, `kurbo`, `bytemuck`, `wasm-bindgen`, `js-sys`, `web-sys`. taffy, skrifa, serde, serde_json, wasm-bindgen-futures are declared but unused in the spike code (they are for phases 1+).
- `cargo tree -d`: one version each of wgpu (30.0.1), naga (30.0.2), skrifa (0.44.0), read-fonts (0.41.0), peniko (0.6.1), kurbo (0.13.1), wasm-bindgen (0.2.130). Other duplicates: hashbrown 0.17.1 listed twice (same version, different feature sets), miniz_oxide 0.8.9 and 0.9.1, num-traits 0.2.19 twice (same version), syn 2.0.119 and 3.0.10 (build-time proc-macros), naga-types 30.0.2 twice (same version). Nothing worrying.
- `cargo-audit`: **not installed**; not run, nothing installed to replace it. Run it before phase 1 if you want it.
- Installed this session: rustup target `wasm32-unknown-unknown`, `wasm-bindgen-cli 0.2.130 --locked` (both requested). Nothing else.
- Panic hook: 10-line `std::panic::set_hook` writing to `console.error` via web-sys. No console_error_panic_hook.
- `RUSTFLAGS=--cfg=web_sys_unstable_apis` is set in `engine/build.sh` (wgpu's webgpu backend needs it).

## Problems hit

- API drift vs older wgpu: `get_current_texture` returns `CurrentSurfaceTexture` (enum), present via `queue.present(frame)`, vertex buffers are `&[Some(..)]`, pipeline layout takes `&[Some(&bgl)]` plus `immediate_size`, render pipelines need `multiview_mask`. All compile-time, fixed in minutes.
- No Google Chrome installed; used Playwright's Chrome for Testing. Dia was not touched.
- Headless Chrome viewport comes out 1440x700, not 900; WK used 1440x900.
- rAF capped at 60 Hz in both hosts, so true 120 fps pacing could not be demonstrated, only inferred from GPU-done times (tiles: ~1 ms, p95 under 11 ms).
- WK clamps `performance.now()` to 1 ms: coarse numbers.
- vello renders each tile in its own submit; zoom-tiles p95 GPU 8 to 11 ms comes from batches of up to 6 tile re-renders in one frame. A tile budget tied to measured time would flatten that.
- The tile strategy here has no tile pyramid for huge boards (cap 2400 px wide texture); a real board at 400% will need tiles inside a board. Not tested.
- Not tested: images, gradients, shadows, blur, clipping, 20+ fonts, huge text blocks, memory over long sessions, device-lost recovery.

## Files (nothing committed)

- `engine/Cargo.toml`, `engine/Cargo.lock`, `engine/src/lib.rs`, `engine/build.sh`, `engine/.gitignore` (target, pkg, spike/out)
- `engine/spike/index.html`, `engine/spike/spike.js`, `engine/spike/server.mjs` (port 5185, allowlisted `/font/arial.ttf`), `engine/spike/WebViewHost.swift`
- Raw results: `engine/spike/out/result-chrome.json`, `engine/spike/out/result-wk.json`

Reproduce: `engine/build.sh`, `node engine/spike/server.mjs`, then open `http://127.0.0.1:5185/?tag=x` in Chrome or build `WebViewHost.swift` with `swiftc` and run it.
