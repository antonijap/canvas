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
4. In Workers & Pages, select this Worker. Under Settings, Domains & Routes, enable Cloudflare Access on its `workers.dev` address. Open the resulting self-hosted application in Zero Trust, Access, Applications. Protect the entire hostname, including `/v1/*`. Disable preview URLs or protect those too.
5. Under Zero Trust login methods, enable One-time PIN (email one-time-code login). Select that login method for this Access application. Add an Allow policy for the team's email addresses or domain. Access proves identity; the server's people rules separately grant permissions.
6. Copy the application's Audience (AUD) tag and the account's Access team domain into `ACCESS_AUD` and `ACCESS_TEAM_DOMAIN`. Deploy again with `pnpm exec wrangler deploy`.
7. Sign in through Access and request `/v1/info` and `/v1/me`. Confirm that the configured owner has role `owner`. Use `PUT /v1/people` to allow other people, then register document UUIDs with `POST /v1/docs`.

The checked-in compatibility date is `2026-08-22`, the newest date supported by the installed workerd binary. Update it with a runtime upgrade and rerun the tests.

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

People and export endpoints require an owner. Owners and editors may register documents. Viewers may read comments. Commenters may edit their own comments; owners and editors may delete anyone's comments or threads. Editors cannot edit another author's text.

## Local development

```sh
pnpm dev --local --var DEV:1
```

This sets Worker variable `DEV=1`. Use `x-canvas-dev-email: owner@example.com` with `http://localhost:8787` or `http://127.0.0.1:8787`, matching a configured owner or allowed rule. Setting a shell variable alone does not create a Worker binding. The dev header is ignored on every other hostname and when `DEV` is unset or differs from `1`.

Local SQLite data stays under `.wrangler/state`. Do not commit it. Local use needs neither Access nor a live JWKS request when the permitted dev header is present.

## API notes

All routes first validate Access identity, including `/v1/info`. Other routes also require a team role. Names use the email local part.

- `POST /v1/docs` accepts `{ "doc": "<uuid>" }`, returns `{ "doc": "<uuid>" }`, and registers once.
- `GET /v1/docs/:doc/threads?since=n` returns `{ "threads": [...], "seq": n }`. This phase returns a full snapshot even with a cursor. Socket replay is incremental.
- `POST /v1/docs/:doc/ops` accepts `{ "ops": [...] }`, returns `{ "acks": [...], "rejected": [...] }`, and broadcasts accepted entries to sockets.
- `GET /v1/docs/:doc/socket` upgrades to a WebSocket. Send protocol `hello` before ops. A present Origin must equal the request URL's origin. Native clients may omit Origin.
- `GET /v1/export` returns `{ "rules": [...], "docs": [...] }`. Each document includes `doc`, `createdBy`, `createdAt`, `seq`, and `threads`, including tombstones. Bootstrap owners remain configuration, not editable rules.

The shared contract is `../protocol.ts`. A retry of an accepted opId acknowledges its original sequence without reapplying or rebroadcasting. Each successful op atomically updates its thread and appends history. Rejected ops do neither. History is retained in phase 1; a replay cursor older than retained history gets a full snapshot. Rate limits are per person per room, held in memory and reset on hibernation or restart. Request JSON and socket text are additionally bounded to 8 MiB.

Rule changes close existing sockets when the person's role decreases or disappears. Every socket message and each REST op batch rechecks the current team role. Socket attachments preserve identity and handshake state across hibernation; email tags permit targeted closure.

Exports collect rooms individually; they are not one transaction across all rooms. Teams should schedule a quiet period if they require an export at a single logical instant. Database history and tombstones are not pruned automatically in phase 1. Monitor the account's storage quotas.

## Checks

```sh
pnpm typecheck
pnpm test
pnpm qa
```

`qa` runs the typecheck and runtime tests. Tests use Vitest and the installed `@cloudflare/vitest-pool-workers` in real workerd, with SQLite and hibernating sockets. RSA keys are generated locally. The injectable JWKS fetcher serves local test responses; unexpected runtime outbound requests are blocked. No credentials, network dependency, or deployment is needed. The runner needs permission to bind loopback ports. The installed pool package prints its rename notice; this implementation keeps the supplied dependencies.

## Shared contract follow-up

The shared `applyOp` helper does not check whether the initial comment in `thread.create` reuses an existing comment UUID. This server adds a conflict check before applying it, because duplicate IDs could make author checks authorize changes to another comment. The shared helper should eventually enforce that check for every caller.

`checkEnvelope` validates `at` as a string and anchors by finite `x` and `y` only. It does not validate the timestamp format or optional anchor fields. Tests record both shared-helper gaps without changing the contract files. The contract also leaves REST registration, people-list, export, and incremental snapshot response shapes unspecified; the API notes above document this server's choices.
