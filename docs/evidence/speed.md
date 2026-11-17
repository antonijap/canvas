Speed: the two roadmap cards "5,000-board file opens under 6 s" and "Saving writes only what changed". Rules in [README.md](README.md); budgets and the full tables in [../perf/latency.md](../perf/latency.md).

| Item | Commit | Tests | Command and result | Screenshot |
|---|---|---|---|---|
| 1. A 5,000-board file (270k nodes, 77 MB) opens to its first complete picture under 6 s; 2,000 boards under 3 s. Cold open at the overview, every tile in view drawn at the exact scale | d9ce127, 4496673, c8bb4f8 | `engine/src/cache.rs` `atlas_cells_by_class`; `bench/batch-check.ts` (tiles composited from the atlas against tiles rendered alone, pixel for pixel); `bench/dirty-check.ts` (partial repaints against a fresh open); `test/engine-view.test.ts` | `pnpm bench` (mafter-3, c8bb4f8 merged with main, load 11): `PASS open 5000 cold open to complete picture (1st) n= 1 p50 3516.0 ... engine idle 5984 ms`, `PASS open 2000 ... p50 1544.0`, `52 of 52 lines within budget or info, 0 fail`; main (1f5ca64) back to back: `FAIL open 5000 ... p50 57840.0`, `FAIL open 2000 ... p50 4021.0`, `48 of 52 lines within budget or info, 4 fail`. `node bench/batch-check.ts`: `overview: 263 tiles batched, 406 rendered alone; batched vs alone: 0 px differ`; `node bench/dirty-check.ts`: `partial: after the edits vs a fresh open: 0 px differ` | Overview at `perf.picture` (5,256 ms in that run; `pictureState` 0 missing, 0 blank, exact), scaled down: ![](img/speed-5000-overview.png) A corner at device px, every board drawn with its images and text: ![](img/speed-5000-overview-detail.png) |
| 2. Saving writes only what changed: a save of a document of 1 MB or more appends the layers that changed to a save log beside `document.json` and fsyncs it; the whole file is written once edits pause, when the log passes a quarter of the document, before Save As and at quit. `document.json` is always whole (what an older build reads) | 822e316, 0643d94, f62ee00, 3e969f1 | `test/doclog.test.ts` (15: format, torn tails, stale logs, someone else's whole save, structure edits, compaction, revisions, the journal beside the log); `test/docwriter.test.ts` "killed mid-write" (kill -9 of a 6 MB document: `document.json` and the document with its log both whole); `test/docwriter-safety.test.ts` (63) | `node --test test/doclog.test.ts`: `pass 15, fail 0`; `pnpm -s test`: `tests 1619, pass 1619, fail 0`; `node qa/release.ts --quick --only crash`: `PASS 4 kill -9s of a 6.4 MB document mid-editing (0 with a write in flight, 4 with edits in the save log): the file was always whole, and all 1076 answered edits survived the restart`; `CRASH_ROUNDS=12 node qa/release-crash.ts`: `PASS 12 kill -9s of a 6.4 MB document mid-editing (0 with a write in flight, 12 with edits in the save log): the file was always whole, and all 3582 answered edits survived the restart`; `pnpm bench` (mafter-3): `PASS write 2000 flush to disk (31 MB) n= 12 p50 5.1 p95 15.2`, `PASS write real flush to disk (19 MB) n= 12 p50 5.0 p95 6.3`; main (mbefore-2): `PASS write 2000 flush to disk (31 MB) n= 12 p50 35.7 p95 72.3`, `FAIL write real flush to disk (19 MB) n= 12 p50 136.2 p95 292.8` | |
| 2a. Migration of older files | not needed | The format did not change: `document.json` is the same plain document, and the save log is an optional file beside it (`.document.json.canvas-log`). A file from before has no log; its first big save creates one. A build without the log reads `document.json` as of its last whole write | | |

## Numbers

Apple M5 Pro (18 cores, 64 GB), macOS 27.0.1, Node 24.22.3, Chrome for Testing 156, headless with WebGPU, 1440 x 900 at device scale 2. Other agents ran QA, native QA builds and simulators on the same Mac throughout; the load average is in the table.

Commands, each from its own checkout, the real file cloned (never written):

```
BENCH_FILE=<a real ~19 MB .canvas file> BENCH_OUT=speed-<run>.json node bench/speed.ts
```

Before = main at 0262cd6 (the branch point) with the engine build it shipped, in a scratch copy; after = this branch. Run back to back in the order before-1, after-1, before-2, after-2, after-3, before-3, after-4. after-1 is 822e316, after-2 0643d94, after-3 and after-4 f62ee00. p50 / p95 ms.

| Line | before-1 | before-2 | before-3 | after-1 | after-2 | after-3 | after-4 |
|---|---|---|---|---|---|---|---|
| load average at start, end | 8.9, 8.4 | 8.7, 7.5 | 24.4, 7.7 | 8.5, 9.2 | 7.9, 21.1 | 7.8, 25.3 | 7.3, 7.8 |
| cold open to complete picture, 200 boards | 934 | 991 | 1,036 | 559 | 566 | 583 | 555 |
| cold open, 2,000 boards (budget 3,000) | 4,153 | 4,384 | 8,511 | 1,493 | 1,660 | 1,469 | 1,533 |
| cold open, 5,000 boards (budget 6,000) | 43,584 | 49,943 | 45,432 | 3,870 | 4,222 | 4,742 | 3,421 |
| same, until the engine is idle (base textures too) | = picture | = picture | = picture | 5,309 | 6,510 | 5,603 | 5,379 |
| warm open, 5,000 boards | 40,083 / 41,301 | 43,066 / 47,003 | 41,766 / 41,927 | 3,259 / 3,268 | 3,032 / 6,393 | 4,380 / 5,776 | 2,873 / 2,908 |
| flush to disk, 3 MB (200 boards) | 11.3 / 31.4 | 12.2 / 47.3 | 13.9 / 65.3 | 5.3 / 30.5 | 5.2 / 32.4 | 5.1 / 5.9 | 5.3 / 7.2 |
| flush to disk, 31 MB (2,000 boards) | 35.3 / 147.4 | 36.0 / 121.0 | 71.3 / 284.8 | 5.2 / 35.2 | 5.3 / 30.2 | 6.2 / 7.0 | 5.2 / 6.4 |
| flush to disk, the real 19 MB file | 30.7 / 87.9 | 29.9 / 115.8 | 30.5 / 87.2 | 9.4 / 71.1 | 6.6 / 80.4 | 6.6 / 16.2 | 5.3 / 10.2 |
| structure ops, 2,000 boards, p95 (dup, reorder, group, ungroup, delete) | 199, 91, 65, 115, 154 | 52, 65, 48, 55, 43 | 486, 221, 83, 219, 86 | 18, 17, 17, 17, 17 | 18, 18, 19, 20, 18 | 20, 18, 21, 19, 18 | 21, 17, 17, 19, 18 |
| structure ops, the real file, p95 | 78, 70, 94, 84, 53 | 118, 71, 68, 84, 71 | 120, 67, 70, 83, 66 | 82, 26, 28, 32, 62 | 185, 50, 54, 43, 69 | 99, 35, 57, 44, 36 | 23, 22, 43, 21, 23 |
| pan / zoom at the overview, 5,000 boards | 5.3 / 6.8, 4.4 / 11.6 | 5.7 / 7.0, 4.6 / 11.7 | 5.3 / 6.2, 4.2 / 11.3 | 3.9 / 4.4, 3.3 / 12.7 | 11.7 / 24.6, 9.3 / 24.0 | 14.1 / 24.7, 7.4 / 20.9 | 4.3 / 4.8, 4.0 / 11.4 |
| footprint after open, 2,000 boards (MB) | 2,457 | 2,403 | 2,566 | 2,314 | 2,389 | 2,523 | 2,391 |
| growth over the 10-minute session (MB, budget 400) | 56 | 22 | -59 | 161 | 204 | 147 | 86 |

Frames at 200 and 2,000 boards, input, MCP and export are within budget in every run, before and after. Set props over HTTP on the 2,000-board file failed once before (before-3, p95 120.5) and never after.

Notes on the runs:

- The open line before is held to the same rule as after, but the rule moved: main's `perf.picture` waited until no frame was requested, so it included the base textures (work no one sees: stand-ins for a later zoom). After, it is taken once the camera is at rest and the last frame drew every tile in view at the exact scale. The "until the engine is idle" row is the old definition's number for the after runs: 5.3 to 6.5 s, against 43 to 50 s.
- after-2 and after-3: the load went from 8 to 21 and 25 while the 5,000-board lines ran (native QA builds and a simulator of other agents; `ps` showed them at the top), and the pan at the 5,000-board overview missed its budget (GPU p95 46 to 49 ms). after-1 and after-4, at load 8, kept it (p95 4.4 and 4.8, better than main's 6.2 to 7.0).
- before-3 started at load 24: its 2,000-board open and write lines are the slowest.
- The 25 ms quantization of `/api/flush` (a fixed sleep when the write it waited on had not finished its bookkeeping) and a process lookup in the middle of a save were the p95 of after-1 and after-2 (30 to 80 ms); f62ee00 removed both.
- Structure ops at p50 went from 8 to 15 ms in after-1 to after-4: every append left the crash journal empty, so it was removed, and the next edit created it again (a file and a folder fsync before it could answer). 3e969f1 keeps it as its header; in process (`node bench/structure-prof.ts 2000 12`) the ops are back to 7 to 8 ms p50, 9 to 13 ms p95.

## After merging main

Main moved to 1f5ca64 while this ran (layout guides, paragraph layout, fills). Merged (98dfeed), engine rebuilt, and measured again against main as it is now (engine built from 1f5ca64), back to back:

Before = main at 1f5ca64, its engine built from that commit, in a scratch copy; after = 98dfeed (mafter-1, mafter-2) and c8bb4f8 (mafter-3: the atlas cells and memory fix). Run in the order mafter-1, mbefore-1, mafter-2, mbefore-2, mbefore-3, mafter-3 (the first try of mafter-3 stopped at `Chrome did not start` and ran again right after). Same command and machine. p50 / p95 ms.

| Line | mbefore-1 | mbefore-2 | mbefore-3 | mafter-1 | mafter-2 | mafter-3 |
|---|---|---|---|---|---|---|
| load average at start, end | 12.3, 28.9 | 7.2, 8.8 | 13.3, 13.4 | 10.2, 12.9 | 25, 7.5 | 11.1, 5.8 |
| cold open, 200 boards | 934 | 923 | 1,678 FAIL | 565 | 632 | 547 |
| cold open, 2,000 boards (budget 3,000) | 4,885 FAIL | 3,971 FAIL | 4,021 FAIL | 1,771 | 2,888 | 1,544 |
| cold open, 5,000 boards (budget 6,000) | 52,977 (the warm opens: not complete after 60 s) | 53,510 | 57,840 | 5,099 | 3,557 | 3,516 |
| same, until the engine is idle | = picture | = picture | = picture | 5,945 | 5,417 | 5,984 |
| flush to disk, 3 MB | 10.2 / 30.1 | 10.3 / 33.1 | 11.0 / 35.3 | 12.5 / 20.8 | 7.4 / 20.8 | 5.1 / 5.8 |
| flush to disk, 31 MB | 32.1 / 101.4 FAIL | 35.7 / 72.3 | 27.2 / 68.8 | 34.8 / 54.4 | 6.1 / 7.4 | 5.1 / 15.2 |
| flush to disk, the real 19 MB file | 38.1 / 110.6 FAIL | 136.2 / 292.8 FAIL | 30.8 / 100.1 FAIL | 5.0 / 6.2 | 5.2 / 8.4 | 5.0 / 6.3 |
| structure ops, 2,000 boards, p50 | 7.5 to 9.3 | 6.0 to 9.5 | 6.2 to 7.9 | 23.6 to 32.8 | 7.0 to 7.8 | 6.9 to 7.9 |
| structure ops, 2,000 boards, p95 | 41 to 100 | 13 to 48 | 46 to 99 | 47 to 62 | 9 to 12 | 8 to 14 |
| structure ops, the real file, p95 | 55 to 99 | 197 to 276 FAIL | 37 to 87 | 10 to 76 | 15 to 75 | 9 to 70 |
| pan at the 5,000-board overview | 7.2 / 16.5 | 4.4 / 6.8 | 5.4 / 6.4 | 4.4 / 5.4 | 4.0 / 4.7 | 4.8 / 5.3 |
| set props over HTTP, 2,000 boards | 11.2 / 26.6 | 10.6 / 34.1 | 10.5 / 18.0 | 20.1 / 30.5 | 6.3 / 7.6 | 6.0 / 6.8 |
| MCP set_node_props to pixel | 15.1 / 30.7 | 14.3 / 33.3 | 14.4 / 29.7 | 31.5 / 52.8 | 29.2 / 62.5 | 13.6 / 17.1 |
| growth over the 10-minute session (MB) | 92 | 144 | 232 | 349 | 188 | 20 |
| lines within budget | 48 of 52 | 44 of 52 | 48 of 52 | 52 of 52 | 52 of 52 | 52 of 52 |

- mafter-1's writes on the 2,000-board file (structure p50 24 to 33, flush 35) ran under other agents' load (the cause was not isolated): the same code in mafter-2 had 7 and 6, and in process (`node bench/structure-prof.ts 2000 12`, during mbefore-1) every save was an append of 4 to 5 ms with ops at 7 to 9 ms p50.
- Memory: mafter-1 and mafter-2 still had power-of-two atlas cells and an atlas that never gave its texture back (the GPU process grew 230 MB in the session against main's 75 to 100). c8bb4f8 rounds cells to 16 px and gives the texture back once no tile is in it: mafter-3 grew 20 MB (GPU process 979 to 1,043 MB). The memory group alone, back to back: after 271 MB (GPU +70), main 487 MB (GPU +76; the server grows more in a run of that group alone).
- `lines within budget` counts the info lines too, as the suite does.

## Gates after the merge

Run on f2e1b5c (main merged again at 1af4fd7; it touched no engine code):

- `pnpm -s typecheck`: clean.
- `pnpm -s test`: `tests 1649, pass 1649, fail 0` (on 98dfeed: 1619 of 1619). (Earlier the same night test 58 of `test/docwriter-safety.test.ts`, the group commit test, failed three runs in a row on this branch and on main's own code at 0262cd6 alike: a write of an earlier test's file landed in its 150 ms window. It passed in all three full runs of the suite.)
- `cd engine && cargo test --lib`: `test result: ok. 186 passed; 0 failed`.
- `pnpm qa`: `109 pass, 0 fail, 0 skip in 86 s on 9 workers`.
- `node qa/release.ts --quick --only crash`: `2 pass, 0 fail` (`4 kill -9s ... 4 with edits in the save log ... all 1167 answered edits survived the restart`); `CRASH_ROUNDS=12 node qa/release-crash.ts` on c8bb4f8: `12 with edits in the save log ... all 3582 answered edits survived`.
- `node bench/batch-check.ts`: `0 px differ` at the overview and at 25 %; `node bench/dirty-check.ts`: `0 px differ` with partial repaints on and off.

## Save log review (2026-11-17): off by default

An adversarial review (Claude, with Codex as a second reviewer) reproduced silent data loss in the save log when anything else writes the same file: two servers on one file lose each other's acknowledged edits; an outside whole save before compaction drops flushed edits; a same-bytes rewrite of document.json double-applies a record; an old log can come back when document.json returns to its exact base bytes; and this build deletes a log written by a newer log version. A single server on its own file held up (about 1,000 fuzzed edits with kill -9, 16 kills around compaction).

Until those were fixed (next section), `writeConfig.logMinBytes` was `Infinity` unless `CANVAS_SAVE_LOG=1`: every save wrote the whole file, as before. The open-speed work was unaffected.

## Save log fixes (2026-11-17): on again by default

Each case the review reproduced is a test in `test/doclog-safety.test.ts` (scratch packages of 2 MB, the log on, spawned servers where a second process or a kill -9 is the point). Before = main at 37ec603 exported to a scratch folder with the new test file copied in; after = this branch. The review's own scripts were copied and pointed at this branch (`CANVAS_SAVE_LOG=1` for the before runs).

| Item | Commit | Tests | Command and result | Screenshot |
|---|---|---|---|---|
| 1. HIGH: two Canvas servers on one file keep each other's acknowledged edits. The log's header names its owner (pid, session, start); only the owner appends. Appends, and whole writes while a log is there, hold `.<name>.canvas-lock` (flock with O_EXLOCK on macOS: the kernel lets go when the process dies) and check, under it, that the document and the log are still what the state was loaded with (inode and size of the log); a log that moved is loaded first, still under the lock. A server that is not the owner writes whole, with the log's edits in it, then retires the log; the owner sees its log gone and does not replay those edits. The log is created with `wx`, never truncated | a1a28a3, 80883a6 | `doclog-safety` "each keeps the other's acknowledged edits" (27 edits from two servers, 3 in the review's order, 24 at once) | before: `actual: 'Layer 0.1', expected: 'A-1'`; after: `✔ each keeps the other's acknowledged edits`. Review `t1-two-writers.ts` before: `after compaction: document.json B0N1: Layer 0.1 B1N1: B-edit-1 B2N1: Layer 2.1`; after: `B0N1: A-edit-1 B1N1: B-edit-1 B2N1: A-edit-2` | |
| 2. HIGH: an outside whole save of document.json before compaction keeps Canvas's flushed edits. The owner keeps the edits only in its log; when it finds its log stale under someone's save (still there under the lock, so no Canvas folded it) they go on top of that save like edits not saved yet (one that no longer applies is reported and Canvas's version saved as a recovery copy), then the stale log is retired. The window is bounded: compaction at the latest 10 s after the log's first record even while edits never pause (`compactMaxMs`), and right after opening a file whose log has no running server | a1a28a3 | `doclog-safety` "while Canvas runs, before compaction", "compaction runs right after opening", "at the latest compactMaxMs"; `doclog.test.ts` "someone saves document.json whole: ... its edits go back on top" | before: `actual: 'Layer 0.1', expected: 'CANVAS'`, open and max age `actual: false, expected: true`; after: all `✔`. Review `t3-scenarios.ts` C before: `document.json B0N1 = Layer 0.1 B5N6 = OLD-BUILD-EDIT`; after: `B0N1 = NEW-BUILD-EDIT B5N6 = OLD-BUILD-EDIT`. `t6-control-c.ts` after: `1.97 MB: flush 200; final B0N1=NEW-BUILD-EDIT B5N6=OLD-BUILD-EDIT` | |
| 3. MEDIUM: a same-bytes rewrite of document.json during an append never applies a record twice. From the first byte of a record to its bookkeeping, loads wait (the same flag as a rename); each edit carries the seq of the record that holds it, so a load that finds our log with that record takes those edits as saved instead of replaying them; the same bytes in another file make the log stale (item 4), and then the log's edits and the unsaved ones replay once | a1a28a3 | `doclog-safety` "document.json rewritten with the same bytes during appends" (3 x 60 nudges, a rewrite every 15 ms) | before: `actual: 645, expected: 420`; after: `✔`. Review `t5-same-bytes-reload.ts` (NUDGES=80) before: EVERY=40 `x on disk 503, expected 480 -> MISMATCH`, EVERY=15 `795, expected 480 -> MISMATCH`; after: EVERY=40, 15, 3: `x on disk 480, expected 480 -> OK` (88, 1,227 and 7,781 rewrites) | |
| 4. LOW-MEDIUM: an old log does not come back when document.json returns to its base bytes. Header v2 ties the log to the very file (inode:mtime, read with fstat from the descriptor the bytes came from); every whole write by Canvas retires the log it holds (`run`, and the plain `saveDoc` under the same lock). A stale log whose server is gone is saved as a recovery copy (its records over the new bytes) and reported, never applied | 80883a6, a1a28a3 | `doclog-safety` "after a crash: no edit comes back from an old log, and none is lost silently", "a whole write by store.ts (writeDoc) retires the log" | before: recovery copies `actual: 0, expected: 1`, saveDoc `log left: actual: true`; after: `✔`. Review `t3-scenarios.ts` B before: `reopened in new build: B0N1 = E1`; after: `B0N1 = Layer 0.1`, `document.json.recovered-...` holds `E1` over the other app's save (A: `E1 OLD-BUILD-EDIT`, B: `E1 Layer 5.6`) | |
| 5. LOW: a log of an unknown (newer) version is never deleted; saves stay whole while it is there | a1a28a3 | `doclog-safety` "a log of a newer version is never deleted" | before: `actual: 'Layer 2.2', expected: 'SAVED WHOLE'` (the edit went into a new log over theirs); after: `✔`. Review `t3-scenarios.ts` E before: `still there after this build opened the file: false`; after: `true` | |
| Default: `logMinBytes` is 1 MB again (`CANVAS_SAVE_LOG=0` turns it off) | (this commit) | all of the above, with the log on | `node --test test/doclog-safety.test.ts`: `pass 9, fail 0` (main: `pass 0, fail 9`); `node --test test/doclog.test.ts`: `pass 15, fail 0`; `CANVAS_SAVE_LOG=1 node --test test/docwriter-safety.test.ts` three runs: `pass 63, fail 0` (one earlier run failed test 58, the group commit timing test; main's own code failed it in one of two runs here too); review `t2-fuzz.ts` SEED 1, 2, 3 x 4 rounds: `PASS seed 1`, `PASS seed 2`, `PASS seed 3` (replay == memory every round, every kill -9 at the last acked state or a newer one); `t4-kill-compaction.ts` N=12: `PASS 12 kills around compaction (9 during or after it started)`; `CANVAS_SAVE_LOG=1 node qa/release.ts --quick --only crash`: `2 pass, 0 fail` (`4 kill -9s ... 4 with edits in the save log ... all 1317 answered edits survived the restart`); `CRASH_ROUNDS=12 CANVAS_SAVE_LOG=1 node qa/release-crash.ts`: `12 with edits in the save log ... all 3833 answered edits survived the restart` | |

Flush with the log on and off, same branch (735eb30), back to back: `BENCH_SIZES=200,2000 BENCH_FILE=<a real ~19 MB .canvas file> node bench/speed.ts write`, `CANVAS_SAVE_LOG=1` for the first run, unset (off then) for the second. p50 / p95 ms.

| Line | log on (load 8.4) | log off (load 7.7) |
|---|---|---|
| flush to disk, 3 MB (200 boards) | 5.1 / 6.2 | 10.2 / 22.4 |
| flush to disk, 31 MB (2,000 boards) | 5.1 / 6.2 | 30.5 / 78.7 |
| flush to disk, the real 19 MB file | 5.0 / 5.5 | 22.2 / 61.5 |
| structure ops, 2,000 boards, p95 (dup, reorder, group, ungroup, delete) | 9.1, 8.2, 8.8, 8.1, 8.1 | 43.4, 93.4, 44.9, 35.9, 38.1 |
| set props over HTTP, 2,000 boards | 5.9 / 7.8 | 10.1 / 16.4 |

Every line passed its budget in both runs (20 of 20). The flush numbers with the log on match the ones before the review (5.1 / 15.2 and 5.0 / 6.3 in mafter-3): the lock, the extra stats and the owner checks cost nothing measurable.

- `qa/release-crash.ts` now looks for leftover temp files once the reopened server has quit: opening a file whose server was killed folds its log into document.json at once, and that whole write keeps the bytes it replaced for 2 s, as every whole write does.
- `.<name>.canvas-lock` stays beside the document once a log was used (an empty file; removing a lock file is the race a lock is there to prevent).

## Save log, second review fixes (2026-11-17): still off by default

A second independent review (Claude scripts n1 to n8, c3, c4, plus Codex) found six more ways to lose acknowledged edits with the log on (five of them only with it on). Each is a test in `test/doclog-safety.test.ts` (the "second review" suites), failing on ad72fcc (the tests on main's code) and passing on this branch. Before for the review scripts = main at 215dfe5 with `CANVAS_SAVE_LOG=1`; after = this branch, same scripts pointed at it. `logMinBytes` keeps its default (off unless `CANVAS_SAVE_LOG=1`).

| Item | Commit | Tests | Command and result | Screenshot |
|---|---|---|---|---|
| 1. MEDIUM: the log deleted from outside while Canvas runs (a cleanup tool, `git clean -fd`, `git stash -u`) no longer drops its edits. A load that finds the state's own log gone while document.json is still the bytes that log applied to (a fold by another Canvas writes new bytes) puts the logged edits back as pending and writes whole. The developer guide says to git-ignore `.*.canvas-log` and `.*.canvas-lock`; this repo's `.gitignore` does | 13f2843, 8e01c89 | "the log deleted while Canvas runs" (after an edit, and with only compaction left) | before: `the deleted log's edit is in document.json: actual: false`; after: `✔`. Review `n5-log-deleted.ts` before: `disk: B0N1=Layer 0.1 B1N1=E2`, `after quit: B0N1=Layer 0.1`; after: `disk: B0N1=E1 B1N1=E2`, `after quit: B0N1=E1 B1N1=E2`. `n5b` (the same with `git clean -fd`): before `B0N1=Layer 0.1`, after `B0N1=E1 B1N1=E2` | |
| 2. LOW-MEDIUM: a package moved and reopened at its new path by the same server keeps its logged edits through a later outside save. A log is "covered" only when this state held that very file (same inode) up to its last seq; a log of this server that the state did not write is folded into document.json at once when it applies, and saved as a recovery copy (recoverStaleLog) when it is stale, never deleted | 13f2843 | "the package moved and reopened at its new path" (open then outside save, and outside save then open) | before: `E1 is in document.json or a recovery copy: actual: false`; after: `✔`. Review `n6-two-paths.ts move` before: `disk: B0N1=Layer 0.1 B5N6=OUT`; after: `disk: B0N1=E1 B1N1=Layer 1.1 B5N6=OUT`; `case`, `case-both` after: `B0N1=E1 ... B5N6=OUT` | |
| 3. LOW-MEDIUM: a copy of the package (Finder Duplicate, ditto, `cp -R`) made while the log has records holds the same edits. The header's tie now ends with the log file's own inode; a log read from another inode is a copy. Next to the bytes it was written for it applies and is folded into the copy's document.json at once; next to other bytes its edits become a recovery copy. Never deleted unread | 13f2843 | "a copy of the package ... holds the same edits as the original" (the same server, a second server, a server started after the first quit) | before: `the same server: the copy holds the original's edit: actual: 'Layer 0.1'`; after: `✔`. Review `n7-duplicate.ts` before: same `copy after open: B0N1=Layer 0.1` (log deleted), other `B0N1=Layer 0.1` (log left stale); after: same, other, dead: `copy after open: B0N1=E1`, log folded | |
| 4. LOW: without the lock a log is never recovered or deleted. reconcileLoad tries the lock once; when another Canvas holds it, a load that has a snapshot keeps it (ReloadLater) and a first load leaves the log as it is (saves whole, nothing retired); the writer waits for the lock off the main thread (settleLater) and loads again holding it. A retire happens only under the lock | 13f2843 | "a log is never recovered or deleted without the lock" | before: `ENOENT ... .document.json.canvas-log` (deleted at 5 s while the other process held the lock); after: `✔` (log untouched and no recovery copy for 6 s, settled once the lock was free). Review `c3-race.ts` before: `saw recovery copy at 5201 ms`, `C's log still there before C lets go: false`, `disk B3N2=Layer 3.2` (B timed out, recovered unlocked and deleted C's fresh log with its acknowledged EC); after: `C: saw recovery copy at 15000 ms` (none made), `disk B3N2=EC`, C's log kept | |
| 5. LOW: no synchronous 5 s wait for the lock on the server's load path. The wait is async (lockLog, polled with setTimeout); in the server, the remaining synchronous waits (the plain `saveDoc`) are capped at 200 ms and then fail and say so | 13f2843 | "a log is never recovered ...: the server keeps answering", "an edit while the lock is held: answered at once" | before: `the edit answered in 4768 ms`; after: `✔` (`/health` slowest under 1 s for 6 s of a held lock). Review `n3-lock-held.ts` (HOLD=20000) before: `u2 during hold 200 at 5038 ms`, `health probes: 40 worst ms: 4924`; after: `u2 during hold 200 at 27 ms`, `health probes: 88 worst ms: 11 >1s: 0`, `disk: B0N1=E1 B1N1=E2 B5N6=OUT` | |
| 6. (Log on and off) after a package is renamed, an edit sent to the old path is refused with "Big.canvas was moved or deleted while open in Canvas, so this edit was not made. Open it from its new place." (409, and a saveproblem toast on every page showing it), instead of 200 then a 503 flush and a loss at quit. A state whose file is gone with nothing but compaction left stops retrying (its log went along with the document) | 13f2843, 0cb70f2 | "an edit sent to the old path fails loudly" (log on, log off) | before: `log 1: an edit to a file that is not there is refused: actual: 200`; after: `✔`. Review `n1-rename.ts live` before: `u2 old path 200`, `flush old path 503`, reopened `B1N1=Layer 1.1` (lost silently); after: `u2 old path 409 {"error":"Big.canvas was moved or deleted while open in Canvas, ..."}`, `flush old path 200`, reopened `B0N1=E1 B2N1=E3-newpath`; `kill` mode the same | |

Runs on the final commit (`CANVAS_SAVE_LOG=1` where the log matters):

- `node --test test/doclog-safety.test.ts test/doclog.test.ts` (both set the log on themselves; also run with `CANVAS_SAVE_LOG=1`): `tests 30, pass 30, fail 0`.
- `CANVAS_SAVE_LOG=1 node --test test/docwriter-safety.test.ts`: `tests 63, pass 63, fail 0`.
- Review scripts, all against this branch: `t1-two-writers.ts`: `after compaction ... B0N1: A-edit-1 B1N1: B-edit-1 B2N1: A-edit-2`; `t2-fuzz.ts` SEED 1, 2, 3 x 4 rounds: `PASS seed 1`, `PASS seed 2`, `PASS seed 3`; `t3-scenarios.ts` A to F as after the first review (B: `reopened in new build: B0N1 = Layer 0.1`, E: `still there ...: true`); `t4-kill-compaction.ts` N=12: `PASS 12 kills around compaction`; `t5-same-bytes-reload.ts` NUDGES=80 EVERY=40, 15, 3: `x on disk 480, expected 480 -> OK` (41, 820 and 6,316 rewrites); `t6-control-c.ts`: `1.97 MB: flush 200; final B0N1=NEW-BUILD-EDIT B5N6=OLD-BUILD-EDIT`; `n2-outside-delete.ts` all five modes: the logged edit on disk or in a recovery copy / kept save log (`has E1=true`); `n4-dead-holder.ts`: `while held: refused`, `after kill -9 of holder: lock taken in 0 ms`; `n8-two-server-fuzz.ts` SEED 1 to 4: `153 to 156 ids acked, 0 wrong on disk`; `c4-saveas.ts`: `copy by B: B0N1=E1`, `copy by A: B0N1=E1 B1N1=E2`.
- `CANVAS_SAVE_LOG=1 node qa/release.ts --quick --only crash`: `2 pass, 0 fail` (`4 kill -9s ... 4 with edits in the save log ... all 1281 answered edits survived the restart`).
- `pnpm -s typecheck`: clean. `pnpm -s test`: `tests 1690, pass 1690, fail 0` (one earlier full run failed `doclog.test.ts` "edits pause: the log is folded", whose 60 ms compaction window ran before the flush under the full suite's load; that file passed 15 of 15 in three runs on its own and in the rerun of the suite).
- `pnpm qa`: `115 pass, 0 fail, 0 skip in 96 s on 9 workers`.

Not covered here (Codex findings outside this list, unchanged): `saveDoc` skipping the lock when its load saw no log, the `.held` fallback lock on volumes without flock, Save As by a server that never opened the source, and an in-place restore of the exact base bytes with the original mtime.
