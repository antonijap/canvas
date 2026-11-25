# A team's own Canvas server

This Worker runs in your team's Cloudflare account. Canvas hosts nothing. Phase 1 stores comments, people rules, and document registrations in SQLite Durable Objects. It has no file hosting or R2 storage.

## Costs and limits

Free-plan planning baseline: Workers allows 100,000 requests a day per account; SQLite Durable Objects and hibernating WebSockets are available on the free plan; Cloudflare Access is free for up to 50 users. Checked 2026-11-17, check current limits. These figures are the supplied setup baseline, not a live pricing check by this offline implementation.

Request, compute, database, and storage limits still apply. Hibernation reduces idle socket costs; active messages and database work count toward quotas. Free does not mean unlimited. Review the account's current [Workers limits](https://developers.cloudflare.com/workers/platform/limits/), [Durable Objects pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/), and [Access plans](https://www.cloudflare.com/plans/zero-trust-services/) before deployment.

## Manual setup and deployment

Use your own Cloudflare account and the installed dependencies. Run these commands yourself from this directory. No deployment is part of local tests.

1. Set `OWNER_EMAILS` in `wrangler.jsonc` to the team's initial owner addresses. These are fixed owner overrides, so keep the list narrow. Never put API tokens or private keys in this file.
2. Authenticate Wrangler with `pnpm exec wrangler login`. Enable a `workers.dev` subdomain for the account if needed.
3. Run `pnpm exec wrangler deploy` to obtain the `https://canvas-server.<account>.workers.dev` address. Until Access is configured, the Worker refuses requests without valid Access identity.
4. In Workers & Pages, select this Worker. Under Settings, Domains & Routes, enable Cloudflare Access on its `workers.dev` address. Open the resulting self-hosted application in Zero Trust, Access, Applications. Protect the entire hostname, including `/v1/*`. Set the Access application's cookie to SameSite Lax or Strict.
5. Under Zero Trust login methods, enable One-time PIN (email one-time-code login). Select that login method for this Access application. Add an Allow policy for the team's email addresses or domain. Access proves identity; the server's people rules separately grant permissions.
6. Copy the application's Audience (AUD) tag and the account's Access team domain into `ACCESS_AUD` and `ACCESS_TEAM_DOMAIN`. Deploy again with `pnpm exec wrangler deploy`.
7. Sign in through Access and request `/v1/info` and `/v1/me`. Confirm that the configured owner has role `owner`. Use `PUT /v1/people` to allow other people, then register document UUIDs with `POST /v1/docs`.

The checked-in compatibility date is `2026-08-22`, the newest date supported by the installed workerd binary. Update it with a runtime upgrade and rerun the tests.

`workers_dev: true` provides the hostname used by this Access setup. `preview_urls: false` disables alternate preview hostnames that this Access application does not protect.

## Configuration

| Variable | Meaning |
| --- | --- |
| `ACCESS_TEAM_DOMAIN` | Access team hostname only, such as `studio.cloudflareaccess.com`. The issuer and JWKS URL are derived only from this setting. |
| `ACCESS_AUD` | Audience tag for this Access application. |
| `OWNER_EMAILS` | Comma-separated bootstrap owners. Trimmed and lowercased; these addresses remain owners above people rules, including deny rules. |
| `SERVER_VERSION` | Server version returned in info and socket welcome. Initially `0.1.0`. |
| `DEV` | Optional local-only bypass. Must equal `1`, with request hostname `localhost` or `127.0.0.1`. Leave unset in production. |

`TEAM` binds one SQLite Durable Object named `team`. `ROOM` binds one SQLite object per registered document UUID. The `v1` migration creates both SQLite classes.

`GET /v1/people` returns the editable rule list. `PUT /v1/people` replaces it with a JSON array, for example:

```json
[
  { "match": "@example.com", "role": "commenter" },
  { "match": "reviewer@example.com", "role": "viewer" }
]
```

A deny wins over exact and domain rules. Otherwise, an exact email wins over its domain. Bootstrap owners override these rules. They are deliberately separate from the editable list. To move an owner entirely into rules, first add another owner, then remove the bootstrap override from configuration and redeploy. Without bootstrap owners, replacing rules must leave an effective owner or returns `409 conflict`. A domain owner rule represents owners in that domain; exact denies may exclude individual addresses.

People and export endpoints require an owner. Owners and editors may register documents. All members can comment and vote. Authors can edit their own comments. Owners and editors may delete anyone's comments or threads and manage votes. Comments-only rooms use the page and layer map an editor publishes when starting a vote.

## Local development

```sh
pnpm dev --local --var DEV:1
```

This sets Worker variable `DEV=1`. Use `x-canvas-dev-email: owner@example.com` with `http://localhost:8787` or `http://127.0.0.1:8787`, matching a configured owner or allowed rule. Setting a shell variable alone does not create a Worker binding. The dev header is ignored on every other hostname and when `DEV` is unset or differs from `1`.

Local SQLite data stays under `.wrangler/state`. Do not commit it. Local use needs neither Access nor a live JWKS request when the permitted dev header is present.

## API notes

All routes validate Access identity, including `/v1/info`. Other routes also require a team role. Names use the email local part. Every non-GET request must use `Content-Type: application/json` (an optional charset is accepted). A present Origin must equal the request URL's origin, otherwise the server returns `403 forbidden`. Native clients may omit Origin.

- `POST /v1/docs` accepts `{ "doc": "<uuid>" }`, returns `{ "doc": "<uuid>" }`, and registers once. Teams may register 1,000 documents; further new registrations return `409 quota`. Registering an existing UUID still succeeds.
- `GET /v1/docs/:doc/threads?since=n` returns `{ "entries": [...], "seq": current }` with applied entries after `n` when replayable. Zero, omitted, future, or pruned cursors return `{ "threads": [...], "seq": current }`, matching socket hello. A current cursor returns an empty entries list.
- `POST /v1/docs/:doc/ops` accepts `{ "ops": [...] }`, returns `{ "acks": [...], "rejected": [...] }`, and broadcasts accepted entries to sockets.
- `GET /v1/docs/:doc/socket` upgrades to a WebSocket. Send protocol `hello` before ops. A present Origin must equal the request URL's origin. Native clients may omit Origin.
- `GET /v1/export?cursor=<doc>` returns `{ "rules": [...], "docs": [...], "cursor": "<next>" }`, at most 50 documents ordered by UUID. Omit cursor on the first page; pass the returned cursor for the next page. A null cursor marks the last page. Each document includes `doc`, `createdBy`, `createdAt`, `seq`, and `threads`, including tombstones. Bootstrap owners remain configuration, not editable rules.

The shared contract is `../../protocol.ts`. A retry of an accepted opId acknowledges its original sequence without reapplying or rebroadcasting. Each successful op atomically updates its thread, comment-to-thread index, byte count, history, and retry receipt. Rejected ops change none of these. A document may store 20 MiB of UTF-8 thread JSON plus op JSON and compact retry receipts (op ID bytes plus eight sequence bytes); writes exceeding it are rejected with `quota`. Rooms retain at most the last 10,000 ops, pruning older entries on writes and wake. Older replay cursors get a full snapshot; tombstones, comment IDs, and receipts remain. Receipts preserve safe retries after pruning and their quota charge bounds growth.

Team-wide limits per email: 120 HTTP requests and socket messages combined per minute, plus 120 submitted ops per minute across rooms and transports. Invalid, rejected, oversized-batch, and duplicate ops consume the op budget. Admission precedes payload validation and database work after identity verification. Every socket message counts, including hello and malformed messages. A socket also permits 60 messages per minute; exceeding either message limit sends `error quota` then closes it. Team counters are in memory and reset on Team restart; socket counters survive Room hibernation in attachments. Request JSON and socket text are additionally bounded to 8 MiB.

Rule changes atomically advance the Team's rules generation. Rooms cache that generation and each socket's role, check before every message and broadcast, and poll Team at most once per five seconds. A changed generation refreshes roles and closes sockets with a lower or removed role. Push revocation runs in the background in batches of 50; failures are logged and do not fail the owner's PUT. Generation checks provide a fallback within five seconds of subsequent activity when a push fails. REST op batches recheck the current role at the Room. Attachments preserve socket identity, role, and handshake state across hibernation.

JWT signatures are verified before decoding claims. Emails are capped at 254 characters before validation. Unknown key IDs trigger at most one JWKS refetch per Access domain per 60 seconds, including misses with varying IDs; failed key loads also back off for 60 seconds.

Exports read up to 50 rooms sequentially per page; pages are not one transaction across all rooms. Teams should schedule a quiet period if they require an export at a single logical instant. Monitor the account's storage quotas.

## Checks

```sh
pnpm typecheck
pnpm test
pnpm qa
```

`qa` runs the typecheck and runtime tests. Tests use Vitest and the installed `@cloudflare/vitest-pool-workers` in real workerd, with SQLite and hibernating sockets. RSA keys are generated locally. The injectable JWKS fetcher serves local test responses; unexpected runtime outbound requests are blocked. No credentials, network dependency, or deployment is needed. The runner needs permission to bind loopback ports. The installed pool package prints its rename notice; this implementation keeps the supplied dependencies.

## Shared contract follow-up

The shared helper now rejects reused initial comment IDs, validates plain bounded anchors, and caps `at` at 40 characters. Tests use ISO times. It still does not validate ISO timestamp syntax.

The contract files are unchanged. Follow-up needed: define the REST snapshot/replay response union, export cursor shape, server storage limits, and five-second fallback revocation window. Registration and people-list response shapes remain server choices documented above. Safe retries still work after history pruning through quota-accounted receipts.
