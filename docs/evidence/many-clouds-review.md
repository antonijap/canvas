# Many Clouds review verification

Every finding below has a regression that failed with its fix disabled and passed with the fix restored. The Claude review and the supplied finding list were checked. The Codex review was absent at its supplied temporary path.

| Finding | Regression |
| --- | --- |
| Duplicate share-picker titles select the wrong Cloud | `CloudPickerTests`: three repeated names, all rows retained, each selection maps to its Cloud |
| Stale port in tunnel follow | `a stopped follow run cannot repeat against the restarted process while its follow is pending`: no old-port helper before the new helper is ready |
| Second follow run crosses a restart | Same test: the old run returns and only one new member helper starts |
| Legacy hosted or stopped-hosted Cloud missing from Settings and Delete | `a Cloud an older version hosted (now stopped) is listed by its id, as the first slot, and kept`; `legacy data without tunnel keys is listed stopped and can be deleted`; Swift `reviewFixes` and migration checks |
| Delete races a start | `Delete while a start of the same Cloud is under way: the start finishes first, then nothing of it is left` |
| Removal after target still sends credentials | `removed right after target answered (before the request goes): nothing is sent, nothing is kept`; `a room socket is not opened for a Cloud removed right after target answered` |
| Join lacks generation checks and serialization | `a Cloud removed while its join waits for the answer: nothing is saved and the removal stands`; `two joins into one Cloud at once: this Mac joins once, the other is told it is already in`; added checks before redemption and while queued |
| Newer shell revision clears removal holds | `a Cloud added here counts until a newer list; removed here, it stays out until a newer list names it`: includes a newer stale list retaining the removed Cloud |
| Dev email change leaves old generations and sockets | `a new development email closes the socket and connects again as the new person` |
| Delete ignores wipe or removal failures | Swift `reviewFixes`: failed wipe, failed remove, and missing response keep the entry and return the error |
| A copied outbox can send as the current person | `a copy that arrives with ops waiting sends none of them as this person: they wait as refused, Retry sends them` |
| Already shared message ignores Cloud status | Swift `reviewFixes`: connected, signed out, and down messages |

The ninth hosted Cloud is refused by `at most 8 Clouds on one Mac: the ninth is refused with a reason`. Swift `adapters` checks the clamped limit, the union of hosted ids, and Alpha badge eligibility. `TestLocalTarget` permits only ports 5190 through 5197.

Native QA covers sheet ordering and copy, Cloudflare badges in Home and Settings, the Home notice, and absent badges on Mac-hosted and joined Clouds. Scenarios added or extended, not run.

The merge's stale single-Cloud file-tab setting was also corrected. The minimum-macOS Swift compilation test covers that integration.

Validation:

- Typecheck passed.
- Full test suite: 1,933 tests in 422 suites, all passed, four workers.
- Swift unit tests: 1,400 checks in 10 suites, all passed.
- Optimized Swift app and bundled tunnel helper build passed.
- Tunnel Go tests: one test passed.
- Headless QA: 143 passed, zero failed or skipped, four workers. Shared-machine write p95 was 163 ms against the 100 ms budget, reported as advisory at this worker count.
- Native QA scenarios were not run, as requested.
- Release scrub: zero current-tree failures; two pre-existing history-only notices remain.
