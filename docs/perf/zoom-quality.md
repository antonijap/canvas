# Zoom and render quality

Zoom and render quality of the engine renderer (task F7), measured 2026-11-14 on the Apple M5 Pro, headless Chrome for Testing 156 with WebGPU (`--enable-unsafe-webgpu --use-angle=metal`), 1440x900 CSS px at device scale 2 (2880x1800 device px), on a temp copy of `an 18 MB real-world design file`. Before = the engine at `25dcc1e`; after = this change.

## How it was measured

A scratch harness (not kept) ran the real server and page, let the page load its boards, then took the engine away from the page loop and drove it frame by frame on a virtual 60 fps clock: `performance.now` advances exactly 16.7 ms per frame plus the real time spent inside `frame()`, and the time spent capturing is taken out, so settle timers, tile budgets and the GPU cost model see the same frame pacing as a real 60 Hz display. After every frame the WebGPU canvas was copied (same task) and measured. Every second frame of each moving segment was then compared with a settled render at the same camera.

Script, 641 frames on board "pG4CR" (1320 x 2868, photo, text, phone screenshots) and its neighbours: pinch out fit to 2% (1 s), pinch in 2% to 800% (2 s), hold, pinch back to fit (1 s), hold, slow zoom to 1.6x (2.5 s), hold, fast pan 3000 world units and back (1.5 s), hold. Plus a seam test on a 4000 x 3000 board filled with 50% translucent blue at fractional zooms and camera offsets, and a stress sweep over 40 boards at 25%, 100% and 300%.

- **Blank %**: pixels inside board frames that show the canvas background or the grey placeholder. "Excess" = minus the settled render at the same camera (a board may really have background-coloured pixels).
- **Blur ratio**: mean luma gradient of the frame / of the settled frame at the same camera. 1.0 = as sharp; below = blurrier; above = aliasing or wrong content.
- **PSNR**: every 5th slow-zoom frame against its settled render (whole frame).
- **Settle step**: mean absolute luma change between consecutive frames while the camera is still (the pop when exact tiles replace stand-ins).
- **Seam px**: pixels inside the translucent board that differ from its settled colour by more than 2/255.

## Results

| | Before | After |
|---|---|---|
| Blank excess, pinch out (max / mean) | 53.6% / 27.1% | 0.01% / 0 |
| Blank excess, pinch in 2% to 800% (max / mean) | 53.5% / 16.1% | 0.01% / 0 |
| Blank excess, fast pan (max) | 22.9% | 0 |
| Blur ratio, pinch in (min / mean) | 0.51 / 0.85 | 0.81 / 0.93 |
| Blur ratio, pinch back (min / mean / max) | 0.89 / 1.30 / 2.65 | 0.93 / 0.98 / 1.00 |
| Blur ratio, slow zoom (mean / std dev) | 2.22 / 0.18 (wrong content) | 0.97 / 0.014 |
| Blur ratio, fast pan (mean / max) | 3.9 / 6.1 (wrong content) | 1.00 / 1.03 |
| PSNR vs settled, slow zoom (min / mean) | 7.6 / 9.1 dB | 32.2 / 35.0 dB |
| Largest settle step (fit / after slow zoom) | 10.6 / 21.3 | 0.53 / 0.42 |
| Seam px, settled at 4 fractional cameras | 1,799 / 2,879 / 5,397 / 0 (a full line) | 0 / 0 / 0 / 0 |
| Seam frames during the seam gesture | 53 of 100 | 0 of 100 |
| Engine `frame()` CPU ms (p50 / p95 / max) | 0.10 / 1.0 / 3.8 | 0.20 / 1.1 / 2.7 |

Before, the "too sharp" blur ratios and the 9 dB PSNR were not aliasing but wrong pictures: tiles drawn with photos and screenshots missing (a vello atlas bug, below) and stand-ins from an older generation (drawn before images arrived) preferred over current ones. Evidence: `zoom-quality/before-slow-zoom.png` and `zoom-quality/after-slow-zoom.png` are the same mid-gesture frame (slow zoom, frame 325); `zoom-quality/after-pinch-in.png` is frame 150, mid pinch-in at about 60%.

GPU time per frame is not reported: in this harness the `onSubmittedWorkDone` latency includes the readback of each frame. The page bench (`docs/perf/engine.md`) is the reference for frame pacing.

## Memory under the stress sweep (budgets enforced)

| | Peak | Budget |
|---|---|---|
| Tile textures | 268.3 MB | 268.4 MB (256 MiB) |
| Image levels | 24.9 MB | 201 MB |
| Effect (blur) textures | 0.03 MB | 134 MB (128 MiB, new) |
| Shader and video card textures | 0 (no cards in this file) | 64 MiB |

Tile textures stay under the budget every frame; base textures and the gutters count against it.

## What changed in the engine

1. **No holes.** A slot without a fresh texture now shows pieces from every cached scale it needs (best first, coarser ones only where the best does not reach, older generations only where nothing current does), each scissored to its own part of the slot. Every board near the view keeps a base texture (whole board at the power of two that fits 512 px, evicted last), so a pinch out or a fast pan shows a soft picture, never the background. Mid-gesture, a slot covered only by a 2x-coarse or old stand-in renders before one that is merely minified.
2. **No shimmer.** The compositor box-filters any texture drawn smaller than 1:1 over each pixel's exact footprint (up to 10 x 10 texels, spread taps beyond that) instead of four bilinear taps, so fine text and hairlines stay put as the zoom moves.
3. **No seams.** Every tile texture has a 2 px gutter of real content, so filtering at a tile edge reads the neighbour. At the exact scale every tile of a board shifts by one rounding (not each its own), and scissors follow the rasteriser's pixel-centre rule, so neighbours never overlap (a translucent board darkened along the seam) or leave a column.
4. **No pop.** After the zoom settles, exact tiles that replace current stand-ins are held until the whole view is ready (at most 250 ms), then shown together, nearest the centre rendered first. With the box filter the stand-ins are close to the exact render, so the one step is small (0.5 vs 10-21 before). A per-tile cross-fade was tried and dropped: drawing the new tile over the old at partial alpha makes translucent content up to 25% more opaque mid-fade (the seam test caught it).
5. **Images never vanish.** vello copies a texture-backed image into its atlas once and trusts the copy; after the atlas grows or repacks the copy can be gone and the image draws empty. Images (and blur textures) are now marked for a fresh copy on every tile render. A board's image levels together are capped at 24 Mpx and the atlas is flushed before three renders could overflow its 8192² (vello drops images that do not fit).
6. **Sharp after a pan.** A tile drawn mid-gesture with image levels below what its scale needs is drawn again once the camera settles.
7. **Budgets.** Blur textures render only for the tiles that show them, one admission each, under a 128 MB LRU (`effectBudget` in `stats()`); boards whose jobs have no texture yet draw a shared transparent one. `stats()` also reports `imagesUnattached`.

Not measured: WKWebView, a 120 Hz display, DPR 1 (the snapping math is DPR-independent and the seam test covers fractional device offsets).
