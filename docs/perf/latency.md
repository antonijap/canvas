# Latency budget

Measured 2026-11-16 with `pnpm bench:latency` (bench/latency.ts), headless Chrome for Testing 156 with WebGPU, 1440x900 at device scale 2, page in `?shell=native` mode, on the Apple M5 Pro while other agents built and tested (load average 5 to 10).

## The budget

Agreed with the maintainer: every interaction under one frame, every write under 100 ms.

| Line | Budget | What is measured |
|---|---|---|
| frame | p95 <= 16.7 ms | Main-thread frame time while panning and zooming with 120 Hz wheel events: from the frame's vsync (rAF timestamp) to the end of its work (a MessageChannel task posted from inside the frame). Only frames that moved the camera count. The note says how many frames missed 8.3 ms (a 120 Hz display), how many vsyncs were dropped, and the engine's GPU time (`gpuDoneMs`). |
| input | p95 <= 16.7 ms | Input-to-paint: from the input event to the end of the first frame whose drawing shows the change (the engine's rectangle of the layer, the selection, the checkbox). The wait for the next vsync is left out (0 to 16.7 ms in any app); a change that misses a frame counts that whole frame. Inputs are sent one at a time. |
| write | p95 <= 100 ms | From the release (or key, or menu command) to the server's 200, read from the page's own fetch. Flush: from an edit's 200 to POST /api/flush answering (the bytes on disk). |
| info | none | Page switch and tab switch until every board in view is drawn (`canvasHost.perf.page` / `.show`, the numbers bench/cache.ts reads). |

Files: a clone of an 18 MB real-world design file (29k nodes; interactions on its busiest page, a to-do card there, a note card on another page; frames on three of its pages) and `demos/playground.canvas`. Network is off: Chrome resolves no host but 127.0.0.1, the server gets no Keychain secret and no PostHog origin, so PostHog cards show cached data or their empty state.

## The speed suite (`pnpm bench`)

`bench/speed.ts` measures the QA plan's speed table (docs/qa-plan.md section 6) on generated stress files (`bench/fixtures/gen.ts`: 200, 2,000 and 5,000 phone boards, 10.7k, 108k and 270k nodes, 3, 31 and 77 MB; list, hero, grid and form boards with auto layout, text, image fills, instances with overrides, groups, shadows, and a dense board of 600 layers every 25 boards). One scratch server and one headless Chrome, as above.

### Budgets

The frame, input and write budgets above hold for every file size. Added for the suite:

| Line | Budget | What is measured |
|---|---|---|
| open | 200 boards <= 1.5 s, 2,000 <= 3 s, 5,000 <= 6 s | Cold open at the overview (the file fitted to the window) to the first complete picture: `canvasHost.perf.picture`, from navigation start until every board in view is laid out, its images are in, the camera is at rest and the last frame drew every tile in view at the exact scale. The note gives when the engine went idle too (`perf.load`: base textures, the stand-ins for a later zoom, drawn as well). The first open of each file in a fresh server and Chrome; two warm opens follow (info). |
| frame on big files | p95 <= 16.7 ms at 200, 2,000 and 5,000 boards | Pan and zoom at the overview and at 50 %. A frame measured while the file is still drawing says so ("still drawing"). |
| select in a dense board | p95 <= 16.7 ms | Clicks alternating between two clusters of a board of 600 layers. |
| structure | p95 <= 100 ms; aim p50 <= 20 ms at 2,000 boards | Duplicate, reorder, group, ungroup, delete over HTTP, n = 20 each. |
| mcp | p95 <= 100 ms | An agent's `set_node_props` through the real MCP server (stdio) until the page shows it. |
| export | <= 15 s | 50 boards to PNG at 1x (POST /api/export). |
| memory | growth <= 400 MB | Footprint (Activity Monitor's Memory: `footprint`) of the server, the page's renderer, Chrome's GPU process and the rest, after open and after 60 rounds of edits (about 10 minutes of a person's work, compressed: drag, resize, inspector edits, typing, duplicate and delete, undo and redo, pan, zoom). |

The 5,000-board file's budgets are the same as the others' for frames, input and select; its open budget is 6 s. It opens in 3.4 to 5.1 s (the second pass below), 5.3 to 6.5 s until the engine is idle; main took 43 to 58 s.

### Second pass (2026-11-17): the 5,000-board open and saving

Back to back on the same Mac, before = main at `0262cd6` with its engine build, after = the branch (`f62ee00`); three before runs and four after runs at load 7 to 25 (other agents' native QA builds and simulators). Every run, the commands and notes: [../evidence/speed.md](../evidence/speed.md). p50 / p95 ms.

| Line | Before (3 runs) | After (4 runs) |
|---|---|---|
| cold open to complete picture, 200 boards | 934 to 1,036 | 555 to 583 |
| cold open, 2,000 boards (budget 3,000) | 4,153 to 8,511 FAIL | 1,469 to 1,660 |
| cold open, 5,000 boards (budget 6,000) | 43,584 to 49,943 FAIL | 3,421 to 4,742 |
| same, until the engine is idle | (the same: main's picture waited for it) | 5,309 to 6,510 |
| flush to disk, 31 MB (2,000 boards) | 35.3 / 147.4, 36.0 / 121.0, 71.3 / 284.8: FAIL | 5.2 / 6.4 and 6.2 / 7.0 (f62ee00) |
| flush to disk, the real 19 MB file | 30.7 / 87.9, 29.9 / 115.8 FAIL, 30.5 / 87.2 | 5.3 / 10.2 and 6.6 / 16.2 (f62ee00) |
| structure ops, 2,000 boards, p95 | 43 to 486 (FAIL in 2 of 3 runs) | 17 to 21 |
| pan at the 5,000-board overview | 5.3 to 5.7 / 6.2 to 7.0 | 3.9 to 4.3 / 4.4 to 4.8 at load 8; 11.7 to 14.1 / 24.6 to 24.7 FAIL in the two runs where other agents took the load to 21 and 25 |

After merging main (1f5ca64: layout guides, paragraph layout, fills) the same lines against main as it is now, three runs each: cold open 5,000 boards 3,516 to 5,099 (main 52,977 to 57,840), 2,000 boards 1,544 to 2,888 at load up to 25 (main 3,971 to 4,885), flush on the real file 5.0 / 6.2 to 5.2 / 8.4 (main 30.8 / 100.1 to 136.2 / 292.8), every line within budget in all three (main: 44 to 48 of 52). Table: [../evidence/speed.md](../evidence/speed.md#after-merging-main).

What changed:

1. **Placeholders on one canvas** (`src/server.ts`). A board not drawn yet showed a div; with thousands of them over the engine's canvas Chrome gave each its own compositing layer (they are too far apart to share one), and Layerize took 250 to 300 ms a frame: 26 s of a 30 s open (trace: `Layerize` on CrRendererMain). Plain placeholders are now rects on one 2D canvas; a board with a snapshot keeps its div.
2. **Small tiles in one atlas** (`engine/src/gpu.rs` `AtlasPool`, `cache.rs` `CellAlloc`). The tiles a batch renders (an overview's boards, base textures, up to 128 px a side with their gutter) go into cells of one array texture (2,048 px layers, cells rounded up to 16 px, one size of cell per layer, growing two layers at a time up to 16, given back once no tile is in it) instead of a texture each. The composite draws a run of quads that share a pipeline, bind group and scissor in one instanced draw; atlas quads clip in the shader. 5,000 boards were 5,000 bind groups, scissor rects and draw calls a frame; now a few draws. Sampling is the same texel for texel (`bench/batch-check.ts`: 0 px differ).
3. **Boards found by index** (`engine/src/api.rs` `pos_of`). `nodeRectIn` (once per image of every board placed) and `setBoard` looked their board up by a scan of every board: n² string compares, about a second of a 5,000-board open. An id index, checked on every hit, rebuilt when boards are removed or reordered.
4. **Smaller per-board costs**: FxHash for the tile and image maps (SipHash took 300 ms of the open), image levels keyed by url then level (a String allocated per lookup), the page's overlap check of each new board against every loaded one (n², 330 ms) replaced by the existing sweep once per batch, and the picture poll reads three numbers (`pictureState`) instead of `stats()`, which walks every board (4 ms each 16 ms).
5. **`perf.picture` at rest, not idle.** It waited until no frame was requested, and the engine requests frames while it draws base textures: work no one sees. It now needs the camera at rest (no move waiting, no fly-to) and the last frame to have drawn every tile in view at the exact scale; the note gives the idle time as well.
6. **Saving writes only what changed** (`src/doc/doclog.ts`, `src/docwriter.ts` `appendLog`). A save of a document of 1 MB or more appends the layers an edit replaced (copy on write keeps everything else the same object: the topmost changed layers, by their path of ids, or a board whole when it is new or changed at its own level) to `.<name>.canvas-log` and fsyncs it: 5 ms where a whole write of 31 MB took 35 to 70. `document.json` stays whole and plain: it is written whole once edits pause for 1.5 s, when the log passes a quarter of the document (at least 4 MB), when a record would be most of a whole write, before Save As and at quit. Loading applies the log only when its header names the document's own bytes; records carry a length and a sha256, so a crash mid-append keeps the records before it; any whole save by someone else makes the log stale (ignored, then removed). The crash journal, atomic rename and folder fsync are unchanged; the log's name is made durable before the first save in it answers. After an append the journal is cut back to its header (not removed and created again) and a `{saved}` line marks what the log holds.
7. **Flush without fixed waits** (`src/server.ts`, `src/docwriter.ts`). `/api/flush` slept 25 ms when the write it waited on was still finishing its bookkeeping; it waits for that write now.

Why the save log and not per-board files: per-board files inside the package with `document.json` as an index would change the format (every older build would open an index without its boards) and need a migration; the log leaves `document.json` the complete document it always was, so older builds still read every file (as of its last whole write), nothing migrates, and the whole write stays the one crash-safe path it was (temp file, fsync, rename, folder fsync), now run less often.

### First pass (2026-11-16)

Measured 2026-11-16 back to back on the Apple M5 Pro (18 cores, 64 GB, macOS 27.0.1, Node 24.22.3, Chrome for Testing 156): before = HEAD `352134f` with the engine build it shipped, in a scratch copy; after = this branch. Load average 8 to 45 during the runs (other agents and a Blender render: earlier the same day it was 60 to 200, and the GPU was shared, so the engine's GPU cost model planned one tile a frame). The write lines of the after column were run again after the last saving change (`bench/out/write-after.json`). p50 / p95 ms unless noted.

| Line | Before | After |
|---|---|---|
| cold open to complete picture, 200 boards | 7,746 | 1,175 |
| warm open, 200 boards | 6,961 / 7,237 | 828 / 829 |
| cold open, 2,000 boards | not complete after 60 s | 4,062 |
| cold open, 5,000 boards | not complete after 60 s | 23,139 (a later run at load 10 to 20: 51,681) |
| pan / zoom at the overview, 200 boards | 1.3 / 2.0, 2.3 / 4.5 | 1.1 / 1.8, 1.8 / 3.0 |
| pan / zoom at the overview, 2,000 boards (before: still drawing) | 6.2 / 8.5, 3.7 / 9.9 | 2.7 / 3.2, 2.6 / 6.1 |
| pan / zoom at the overview, 5,000 boards | 6.1 / 16.1, 8.1 / 25.3 FAIL (still drawing) | 5.2 / 7.2, 4.6 / 15.2 |
| pan / zoom at 50 %, 2,000 and 5,000 boards | p95 2.5 to 3.0 | p95 1.7 to 2.9 |
| drag, resize, type on the 200-board file (per move or key) | p95 2.1, 3.4, 3.3 | p95 2.4, 3.3, 3.0 |
| select in a dense board, 200 / 2,000 / 5,000 boards | p95 2.5 / 2.2 / 2.7 | p95 2.2 / 2.7 / 2.2 |
| MCP set_node_props to pixel | 30.6 / 33.8 | 14.6 / 31.1 |
| structure ops, 2,000 boards (duplicate, reorder, group, ungroup, delete) | p50 33.6, 15.0, 25.9, 18.4, 36.2 | p50 7.0, 7.1, 8.7, 7.6, 7.9 |
| same, p95 | 63.4, 73.3, 56.2, 59.0, 76.6 | 48.7, 49.3, 44.2, 42.1, 10.7 |
| structure ops, the 18 MB real-world file, p50 | 45.3, 36.5, 53.4, 35.8, 53.2 | 8.8, 18.1, 11.1, 20.1, 8.3 |
| same, p95 | 86.1, 91.6, 104.4 FAIL, 235.7 FAIL, 88.8 | 71.1, 76.3, 54.9, 51.1, 38.7 |
| flush to disk, 31 MB (2,000 boards) | 68.3 / 119.6 FAIL | 30.1 / 94.5 |
| flush to disk, the 18 MB real-world file | 63.9 / 95.2 | 39.5 / 85.7 |
| export 50 boards to PNG (1st, 2nd run) | 3,607, 3,888 | 3,956, 4,192 |
| footprint after the 10-minute session, 2,000 boards (MB) | 1,808 (after an open that never finished: 2,230) | 2,568 (after open: 2,463) |
| the whole suite | 1,105 s | 290 s |

Px rendered per edit (`bench/dirty-check.ts`, a phone board at 100 %, device scale 2; same build, partial repaints off and on): resize 1.694 to 0.107 Mpx, typing 2.103 to 0.045, a fill set over HTTP 1.411 to 0.080, an arrow-key nudge 1.411 to 0.055. After every edit the canvas matches a fresh open pixel for pixel. Batch renders match tiles rendered one by one pixel for pixel (`bench/batch-check.ts`).

Server, in process (`bench/structure-prof.ts`, 2,000 boards, load average 90 to 120): duplicate 96.9 / 266.6 to 14.2 / 43.6, group 70.4 / 243.8 to 13.9 / 26.7, delete 106.9 / 422.7 to 34.9 / 120.1 (board indexes alone).

Memory: the after run holds more because its open finished: every board of the overview is laid out (WASM 270 MB at 2,000 boards) where the before run's open was still loading. The session's own growth is 105 MB.

### What changed in the first pass

1. **Structure ops without whole-document walks** (`src/doc/boardindex.ts`). Every board of a document version Canvas adopted gets its facts worked out once per board object: its layers by id, the ids its instances' overrides add, the components it uses, whether it holds one, its "Name N" numbers. `findNode`, `buildIndex`, `allIds`, `cowDoc`, `groupsAround`, `normalize`, `mainsToPark`, `purgeHolder` and `nextName` ask them instead of walking 100k nodes. Edits copy the boards they change, so a shared board never changes and its facts stay right; a board changed in place against that rule is still found (`findNode` walks everything before saying no) and is re-indexed once `verify()` forgets it. The holder of deleted main components is now copied like any board an op changes (deletes and pastes changed it in place). The indexes are built in the background when a file is read.
2. **Saving** (`src/docwriter.ts`). Every hash of the file (four per save, 18 ms each on 30 MB in main-thread slices) is WebCrypto's digest on libuv's pool, and the new bytes are hashed while the same buffer is written and fsynced. The folder fsync after the rename and the first crash-journal write after a save (created in place, made durable by the group commit the answer already waits for) are off the main thread. The checks after a write lands run beside the next write, which waits for them before its own rename; the written file's signature is trusted at once and the hash takes it back if it does not match. A flush answers when the bytes are in place. The once-a-minute backup reads the replaced bytes from a descriptor opened before the write, beside it. Crash safety is unchanged: an edit answers only once its journal line is durable, the rename is atomic, the journal is retired only after the folder fsync; the kill -9 tests pass.
3. **Repaint only what changed** (`engine/src/board.rs`, `gpu.rs`, `api.rs`). Each generation of a board notes the region it changed (`moveNode`/`updateNode`: what the subtree drew before and after; a `setBoard` with the same layers: the union over the layers that differ, so inspector and agent edits, nudges and undo count too). A texture of an older generation renders only that region again into itself, on vello's 16 px grid; unknown reach (fonts, layers added or removed, the root, anything a blur reads) renders whole. 15 to 47 times fewer px per edit.
4. **Big files open** (`engine/src/api.rs`, `cache.rs`, `gpu.rs`; `src/scene.ts`; `src/page/engine-view.js`). Small tiles (up to 384 x 384 px) render together in one vello render into a scratch atlas, each clipped to its cell and copied into its own texture: the GPU cost model admits the batch like one render, so an overview of hundreds of boards is a frame or two, not one tile a frame. Base textures (a coarse picture of every board near the view) size themselves so all of them take at most 30 % of the tile budget (2,000 boards wanted 1 GB of a 256 MB cache and evicted each other for ever), and wait until boards stop arriving. POST /api/scenes streams many boards' scenes in one answer, nearest the view first, and the page places them as they arrive (it waited for 2,000 GETs through six connections). The spark follows board layouts once per frame (it forced a layout per board); installed font faces are looked up once per family.

### Not fixed yet

- **The 5,000-board open** is within budget (3.4 to 5.1 s to the first complete picture) but the engine is idle only at 5.3 to 6.5 s: base textures follow the picture. The open is bound by the page's main thread, which places about 1,800 boards a second (parse each scene, lay it out and paint it in WASM, index its layers) between frames. On a machine at load 25 it takes about a second longer. Next: parse scenes off the main thread, and skip text shaping for boards smaller on screen than a glyph.
- **The pan at the 5,000-board overview** keeps its budget at load 8 (p95 4.4 to 4.8) and misses it when other agents take the GPU (two runs at load 21 and 25: GPU p95 46 to 49 ms).
- **Saving** still writes the whole document once edits pause (1.5 s), when the log grows past a quarter of it, and when an edit changes a board at its own level (a duplicate or delete of a direct child of a 2 MB board appends the board). A build without the save log sees the edits only after that whole write. A record names layers by their path of ids: a board whose layers share an id among siblings saves whole.
- **The atlas** grows two layers (32 MB) at a time and gives its texture back only when no tile is in it (cells are not moved). With power-of-two cells and no giving back, the 2,000-board session's GPU process grew 230 MB against main's 80 (c8bb4f8 fixed both: +70 MB, main +76, in `BENCH_SIZES=2000 node bench/speed.ts memory`). A long session that keeps an overview and zooms in and out can still leave partly used layers.
- **The GPU cost model** plans one render a frame when the GPU is busy with other apps (its composite estimate was 30 to 290 ms under Blender). Batches make that one render carry many tiles; a single large tile still waits its turn.
- **Memory** after a 2,000-board overview is 2.5 GB across server, renderer and GPU process (the server holds the document, its scenes and caches; WASM holds every board laid out).
- WKWebView and a 120 Hz screen are still not measured here (headless rAF is 60 Hz).

## The latency bench: before and after (earlier the same day)

Same harness, back to back: before = HEAD `4a85027` in a scratch worktree with the engine build it shipped, after = this change. The 18 MB file, p50 / p95 ms:

| Line | Before | After |
|---|---|---|
| drag-move a layer (per move) | 14.8 / 15.7 | 7.6 / 8.1 |
| resize from a handle (per move) | 12.9 / 14.1 | 6.6 / 7.2 |
| drag a spacing handle (per move) | 16.7 / 17.9 FAIL | 6.2 / 9.3 |
| type into a text layer (per key) | 12.7 / 14.2 | 6.5 / 7.3 |
| select by click | 2.8 / 3.4 | 3.3 / 3.9 |
| toggle a to-do | 1.8 / 2.5 | 2.4 / 2.9 |
| move a card (per move) | 2.5 / 2.7 | 2.5 / 2.9 |
| frames, pan and zoom on three pages | p95 1.4 to 2.9, 0 over 8.3 | p95 1.7 to 2.5, 0 over 8.3 |
| write: move, resize, spacing, text, nudge, repeat, to-do, card | p95 16 to 27 | p95 16 to 38 |
| write: structure (Cmd+D, Delete), n = 20 | 30.2 / 40.9 (max 89) | 35.7 / 60.1 (max 84) |
| flush to disk | 51.8 / 97.3 | 48.1 / 78.8 |
| page switch / tab switch (info) | 178 / 16 | 179 / 17 |

An earlier run of the unchanged code under heavier machine load had drag-move at 16.5 / 33.4 (20 of 96 moves a frame late), resize at 31 / 40 and typing at 14 / 19: on a 1,300-node board the margin was gone. After the change the same edits leave half the frame free, which is also what a 120 Hz display needs (8.3 ms). Playground lines were all under 4 ms before and after.

## What was slow then, and the fixes

Every live edit (a drag of a layer, a resize, a padding drag, a typed character) laid its whole board out again each frame: `live.js` parsed the board's scene, put the edits on it, stringified it twice (once for `contentKey`), and the engine's `setBoard` parsed the JSON into a serde `Value`, built the tree, shaped every text, laid out with taffy, painted and rebuilt the hit index. On the 1,330-node board that was 8 to 12 ms of engine time plus 3 to 5 ms of page JS per frame (CPU profile: setBoard 10 ms per call, of it parse 3.5, layout 4.5 with shaping 2.7, paint 1.9).

1. **Moves without a layout** (`engine/src/board.rs` `move_node`, `moveNode` in the API; `src/page/live.js` edit). A layer whose parent is a frame with layout none and a fixed size moves alone: its subtree's transforms, the hit index and a paint. Anything else (a flow child, a parent that hugs, a group, the board itself) still sets the whole board. Pixel-checked: the live drawing during a drag equals the drawing after the server's answer.
2. **Edits of a few layers lay out only their subtree** (`Board::update_node`, `layout::relayout_subtree`, `updateNode` in the API; `live.js` flush tracks which layers each dirty board's edits touched). Same condition on the parent. Resizes, padding and gap drags, typed text and pins go through it; a hook that changes the scene beyond the touched layers (autolayout's drag overlay) returns true and the board is set whole. Node test and engine tests compare against a fresh layout.
3. **Shaped text kept for boards laid out again** (`engine/src/text.rs`). While a board is replaced (`setBoard` on a board it has) or edited, `TextSystem::build` reuses shaped parley layouts by every prop shaping depends on. Bounded to 4,096 entries, cleared when a font is registered. `setBoard` on the 1,330-node board: 12.5 to 7.6 ms.
4. **A drag showed one frame late** (`src/server.ts` flushCam): the drag's position was applied after `live.flush()` had laid the boards out, so it drew in the next frame. The position now goes in first.
5. **One stringify instead of two per install** (`src/page/engine-view.js` `sceneTextAndKey`), and the drop test of a move parses each board's scene once per drag instead of twice per pointer move (`src/page/autolayout.js` `moveScene`).
6. **Flush answered after bookkeeping** (`src/docwriter.ts`). POST /api/flush waited for the whole write, including two more reads and SHA-256s of the 18 MB file after the rename (was the replaced file the one the write was based on; confirming the new signature). It now answers once the bytes are renamed into place and the folder synced (`flushWrites(f, { early: true })`); quitting still waits for everything. The lingering previous copy is hashed asynchronously two seconds later instead of synchronously (it held every request behind it for about 25 ms).

## Not fixed then (structure ops, flush and GPU repaint: see the speed suite above)

- **Structure ops on a large file** take 30 to 45 ms on the server (whole-document walks in `structure.ts`: `allIds`, `buildIndex`, `mainsToPark`, `placeOf`), and their tail reaches 60 to 110 ms when they land on a background write's synchronous fsyncs (`rewriteJournal`, `syncDir`) and its 18 MB serialize, write and hash. Within budget at p95 with n = 20, but with the least margin. Next: an id index for `placeOf`/`findNode`, and moving the journal rewrite's fsync off the main thread.
- **Flush** is bound by the full rewrite of an 18 MB file (serialize 4 ms, hash 9 ms, write 3 to 45 ms, fsync 6 to 75 ms). Per-board files or an append log would be the real fix.
- **GPU** time per frame stays as it was: a moved or resized layer still repaints its board's tiles in view (dirty-rect tile reuse would cut it).
- WKWebView and a 120 Hz screen were not measured; headless rAF is 60 Hz. Treat the numbers as the page's own work, not what the app shows on screen.

## Run it

```
pnpm bench                                      # the speed suite: about 5 minutes, exit 1 on a FAIL
pnpm bench open frame                           # some groups (open frame input write memory export mcp)
BENCH_SIZES=200,2000 pnpm bench                 # some stress-file sizes (default 200,2000,5000)
BENCH_FILE=/path/to/file.canvas pnpm bench write   # structure and flush lines on a real file of yours (cloned)
node bench/structure-prof.ts 2000 20            # server-side structure ops and flush in process (PROF=1: CPU profile)
node bench/open-prof.ts 2000                    # where an open's time goes (page CPU profile, tiles per frame, why batches stopped)
OPEN_PROF_FRAMES=0 node bench/open-prof.ts 5000 # the same without per-frame engine stats (4 ms a frame at 5,000 boards)
node bench/dirty-check.ts                       # px rendered per edit, partial repaints off and on, pixel check
node bench/batch-check.ts                       # batch renders against tiles rendered alone, pixel check
pnpm bench:baseline                             # the older server and page baseline (docs/perf/baseline.md)
pnpm bench:latency                              # everything, about 2.5 minutes, exit 1 on a FAIL
pnpm bench:latency frame input                  # only some groups (frame, input, write, info)
LATENCY_FILES=playground pnpm bench:latency     # one file (fixture, playground, real)
LATENCY_ONLY=move,resize pnpm bench:latency input   # some interaction steps
BENCH_FILE=/path/to/file.canvas pnpm bench:latency    # also a real file of yours (cloned)
pnpm bench:cache <file> [pageId]                # load timings with and without the caches
```

Output: a table on stdout and `bench/out/latency-<time>.json` plus `bench/out/latency-latest.json` (every sample). It works on clones in a temp folder, starts one scratch server and one headless Chrome, and removes all of it at the end.
