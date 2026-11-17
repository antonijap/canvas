How comments work locally and on a team's own Canvas server. The types and the shared rules are code in [cloud/protocol.ts](../../cloud/protocol.ts); this page says why. Canvas hosts no server: a team deploys `cloud/cloudflare` to its own Cloudflare account.

## Identity of things

- Every document, thread, comment and op has a UUID that never changes and is never reused.
- A document's comment identity is `doc` in its `comments.json`. Save As mints a new one (a fork). A copy made by a sync folder keeps it (the same document).
- Deletes are tombstones: a deleted comment keeps its id and loses its body; a deleted thread marks all its comments deleted. A replay or an old copy can never bring one back.

## Ops

Every change is an op (`thread.create`, `comment.add`, `comment.edit`, `comment.delete`, `thread.resolve`, `thread.move`, `thread.delete`) inside an envelope with an `opId`.

- The server applies ops in one order and numbers them (`seq`). Everyone sees that order.
- The same `opId` twice is applied once and acknowledged with its first `seq` (safe retries).
- `applyOp` in `cloud/protocol.ts` is the one implementation of what an op does, used by the app and the server.
- Conflicts: an edit, reply, resolve or move on a deleted thread or comment is rejected with `conflict`. Edits and resolves on live items: the later `seq` wins.
- Permissions (`mayApply`): viewers cannot comment; authors edit and delete their own comments; owners and editors may delete any comment or thread.

## The local file

`comments.json` in the `.canvas` package (`CommentsFile`): the threads, the last applied `seq`, an `outbox` of ops not yet acknowledged, and `rejected` ops the server refused (kept and shown, never silently dropped). A file never shared has an empty outbox and `seq` 0. Each comment shows local, pending or synced.

## Anchors

A thread pins to a layer id and a point on that layer as fractions of its box, so it moves with the layer. If the layer is deleted the thread stays, shown on its board with the stored `preview` and "layer deleted". A thread is never reattached to another layer by itself. Web review threads also carry the published `revision` they were made on.

## Who gets in (on the server)

- Cloudflare Access in front of the Worker proves identity (email). The Worker validates the Access token itself: signature against the team's keys, algorithm, issuer, audience and expiry.
- The server decides permissions from its people rules (`PeopleRule`): exact emails and whole domains, each with a role or `deny`. A deny always wins; otherwise an exact email beats its domain.
- Every op is checked against the sender's role at the time it arrives. Removing someone closes their open sockets.

## Transport

- REST: `GET /v1/info`, `GET /v1/me`, `GET /v1/docs/:doc/threads?since=seq`, `POST /v1/docs/:doc/ops`, owner-only `GET|PUT /v1/people` and `GET /v1/export`.
- The room socket `/v1/docs/:doc/socket`: `hello {since}` → `welcome` (with all threads when `since` is 0 or too old) → `ops` / `applied`, `ack`, `reject`.

## Limits

`LIMITS` in `cloud/protocol.ts`: body length, ops per message and per minute, threads per document, comments per thread, sockets per person. Both sides enforce them; the server is the one that counts.
