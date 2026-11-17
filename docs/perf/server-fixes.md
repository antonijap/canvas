# Server fixes (hotspots 5, 6, 7 and the stored camera)

Measured 2026-11-14 on the baseline machine (M5 Pro, Node 24). Before and after use the same harness and the same files, as copies in `bench/out/copies` (originals never opened). Raw: `bench/out/results-before.json`, `results-after.json`, `results-page-before.json`, `results-page-after.json`.

Rerun: `BENCH_FILE=/path/to/A.canvas node bench/run.ts --quick` (server HTTP, SSE and memory, about 1 minute). Page: `BENCH_FILE=/path/to/A.canvas BENCH_SCENARIOS=enter-overview BENCH_NO_TRACE=1 node bench/run.ts --page-only`.

## Numbers

file A (16.9 MB, 81 boards)

| | before | after |
|---|---|---|
| `/api/board` p50 / p95 | 55 / 63 ms | 3.2 to 7 / 9 to 18 ms |
| `/api/doc` p50 | 53 ms | 1.1 to 1.6 ms |
| `/api/node` p50 | 52 ms | 0.3 to 1.2 ms |
| 12 concurrent boards, wall | 687 ms | 55 to 133 ms |
| CPU per `/api/board` request | 55 ms | 4 to 8 ms |
| enter-overview settle (3 reps) | 10,895 / 11,709 / 9,324 ms | 1,479 / 1,332 / 1,423 ms |
| SSE change to event, p50 | 184 ms | 102 to 122 ms |
| SSE payload per change | 114.8 KB (`doc`) | 0.1 to 0.2 KB (`docdiff`) |
| heap retained after one load | 44.1 MB | 10.3 MB |
| heap growth, load plus storm | 46.5 MB | 12.7 MB |
| RSS growth | 130 MB | 123 MB |

file B (4.1 MB, 27 boards)

| | before | after |
|---|---|---|
| `/api/board` p50 | 14.7 ms | 1.6 to 4.5 ms |
| 12 concurrent boards, wall | 176 ms | 16 to 34 ms |
| SSE p50 | 197 ms | 52 ms |
| SSE payload | 34.7 KB | 0.1 to 0.2 KB |
| heap retained after load | 10.9 MB | 2.7 MB |
| RSS growth | 50 MB | 4.9 MB |

The two "after" columns span two runs (the second ran while the machine was busier). The `/api/board` target (p50 under 10 ms) holds in both. Enter-overview is 1.3 to 1.5 s, not under 1 s: the server share is now about 0.1 s; the rest is the page parsing 12.5 MB of board HTML into 55k DOM nodes (826 ms of main thread, 143 layouts), which is hotspot 1 and not a server problem. The "settle" figure also includes the detector's 300 ms quiet window.

SSE: 20 ms debounce plus one load and snapshot (about 80 ms CPU on the big file). The remaining cost is parsing 17 MB of JSON, not waiting.

## What changed

1. `src/snapcache.ts` (new). `watched()` is now `cache.get()`: one `fs.stat` per request, signature = inode, size, mtime, ctime. The file is read and parsed only when the signature moves. A rename over the file changes the inode, so saves are caught on the next request even if no watcher event arrived. A change is announced once, by whichever of the watcher or a request sees it first (before, a request that noticed a change swallowed it and the watcher then saw "no change", so the page could miss an update).
2. Watching: `fs.watch` on the directory (not the file, so a replaced inode does not strand it), filtered by file name, 20 ms trailing debounce, non-persistent. If `fs.watch` throws or errors, it falls back to `fs.watchFile` at 150 ms. Two safety nets for lost events: one look 300 ms after a watcher is armed (FSEvents and `watchFile` miss edits made during arming; found by a flaky test), and a stat once a second for documents that have an SSE listener.
3. `src/docdiff.ts` (new). `docdiff` SSE event: `{ base, revision, changed[], added[], removed[], order?, name?, components?, styles?, variables?, themes? }`. Board entries carry their keys. Optional fields appear only when they changed; `order` only when the board order is not what applying the diff gives. The first event on a connection and on reconnect is still the full `doc`. If a diff would be larger than the full payload the server sends `doc` instead. The page embeds `applyDocDiff`'s source text from the same module, so server and page cannot drift; on a revision mismatch it refetches `/api/doc`.
4. Memory. The 44 MB retained was a leak: the `fs.watchFile` callback closure in the old `watched()` captured the first `LoadedDoc`, which kept the 17 MB raw text and a second parsed copy alive for the life of the watcher. Gone with the rewrite. What is kept per file now: the parsed doc, board metas, components, styles. Idle documents (no request for 10 minutes, no SSE listener) are dropped with their watcher; before, every file ever opened stayed forever. RSS barely moved on the big file because it is the allocator high-water of one load (17 MB string plus the hash copy plus parse plus the key stringify, about 70 MB above idle after GC); cutting that needs a streaming loader in the engine's `loadDoc`, which I did not touch. file B RSS growth fell 50 to 5 MB because the repeated reloads are gone.
5. Stored camera: the page restores `canvas:<file>` from localStorage (validated: finite numbers, z above 0) and fits the first board only when none is stored. Checked in the browser: set a camera, reload, same camera after the native 250 ms timer.
6. Bench: removed the `keyfix` page variant (halves page run time); added `--quick`; real files are copied into `bench/out/copies` first; SSE measures a no-op rewrite and three real board edits with payload kind and size; `BENCH_RESULTS` and `BENCH_NO_TRACE` env vars.

## Tests

`test/snapcache.test.ts`: repeat requests do one load; a request sees an edit with no watcher; rename-over (inode change) via directory watch; touch alone announces nothing; polling fallback; half-written file keeps the last snapshot; idle eviction spares pinned files; diff of one changed board omits unchanged sections; add, remove, reorder and variables round-trip through `applyDocDiff`; a diff on another revision is refused; the page embeds a working `applyDocDiff`; end-to-end SSE (full `doc` first, then `docdiff` with only the changed board). `pnpm test` green (4 consecutive full runs), `pnpm typecheck` green.
