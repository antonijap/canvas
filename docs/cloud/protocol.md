How comments work locally and on a team's own Canvas server. The types and the shared rules are code in [cloud/protocol.ts](../../cloud/protocol.ts); this page says why. Canvas hosts no server: a team deploys `cloud/adapters/cloudflare` to its own Cloudflare account.

## Identity of things

- Every document, thread, comment and op has a UUID that never changes and is never reused.
- A document's comment identity is `doc` in its `comments.json`. Save As mints a new one (a fork). A copy made by a sync folder keeps it (the same document).
- In the app only, an envelope whose `doc` is the nil uuid means "this file's own document" (before its first comment gives it one). The local server replaces it with the real `doc` before anything is stored or sent; a team server never sees it.
- Deletes are tombstones: a deleted comment keeps its id and loses its body; a deleted thread marks all its comments deleted. A replay or an old copy can never bring one back.

## Ops

Every change is an op (`thread.create`, `comment.add`, `comment.edit`, `comment.delete`, `thread.resolve`, `thread.move`, `thread.delete`) inside an envelope with an `opId`.

- The server applies ops in one order and numbers them (`seq`). Everyone sees that order.
- The same `opId` twice is applied once and acknowledged with its first `seq` (safe retries).
- `applyOp` in `cloud/protocol.ts` is the one implementation of what an op does, used by the app and the server.
- Conflicts: an edit, reply, resolve or move on a deleted thread or comment is rejected with `conflict`. Edits and resolves on live items: the later `seq` wins.
- Permissions (`mayApply`): all members can comment; authors edit and delete their own comments; owners and editors may delete any comment or thread. A thread is moved (`thread.move`: its pin dragged, or Pin to a layer) by its author or an owner, not by other editors. That rule is the server's alone: the op and the protocol version are unchanged, so an older app still syncs, and a move it sends for someone else's thread comes back `forbidden`.

## The local file

`comments.json` in the `.canvas` package (`CommentsFile`): the threads, the last applied `seq`, an `outbox` of ops not yet acknowledged, and `rejected` ops the server refused (kept and shown, never silently dropped). A file never shared has an empty outbox and `seq` 0. Each comment shows local, pending or synced.

## Votes

Local votes live in `comments.json`. Cloud votes use the comments stream and the same envelope, idempotent receipts and sequence. Owners and editors can start, end, clear or set the timer for a Cloud vote. Everyone can cast and retract their own dots. Viewers can comment and vote, and design editing requires an owner or editor.

The Mac file room validates pages, frames and eligible layers against the live design. Comments-only rooms accept a bounded page and layer map from an editor at `PUT /v1/docs/:doc/vote-design`. Both rooms enforce the same budgets and open-vote limit. When sharing or moving a local file, Canvas only sends this Mac's own ballots.

Rooms store ballots privately. Anonymous votes use a per-vote keyed hash of the voter ID. A hidden vote shows each member their own dots and, for named votes, who has finished. Ended votes show totals. Named votes also show voter display names where shared. Welcome, live updates and history carry the requesting member's filtered view and a sequence marker for each vote change. Save As, downloads and Cloud duplicates carry the design, including any placed conclusion card. Ballots stay in their room.

Canvas places a conclusion card after it receives the winning end receipt for an operation it queued. A timer uses the room clock, which `welcome.serverTime` reports. When a room closes an expired vote, the first owner or editor client to claim the conclusion places the card. Clearing removes the vote from the canvas overlay. Undo can remove the conclusion card as a design edit.

Clients and hosts advertise `cloud-votes` in `hello` and `welcome`. Hosts also list it in `/v1/info`. REST clients can negotiate it with `x-canvas-comments-capabilities` on comments-only rooms and `x-canvas-files-capabilities` on file rooms. Older clients keep their existing comment stream. New clients show an update message for voting and viewer comments when connected to an older host and hold incompatible queued work until a capable host answers.

## Anchors

A thread pins to a layer id and a point on that layer as fractions of its box, so it moves with the layer. If the layer is deleted the thread stays, shown on its board with the stored `preview` and "layer deleted". A thread is never reattached to another layer by itself. Dragging its pin moves it by hand: on the drop it gets the anchor a new comment at the pin's tip would get (the layer under it, else a page point), sent as one `thread.move`. Web review threads also carry the published `revision` they were made on.

## Who gets in (on the server)

- Cloudflare Access in front of the Worker proves identity (email). The Worker validates the Access token itself: signature against the team's keys, algorithm, issuer, audience and expiry.
- The server decides permissions from its people rules (`PeopleRule`): exact emails and whole domains, each with a role or `deny`. A deny always wins; otherwise an exact email beats its domain.
- Every op is checked against the sender's role at the time it arrives. Removing someone closes their open sockets.

## Transport

- REST: `GET /v1/info`, `GET /v1/me`, `GET /v1/docs/:doc/threads?since=seq`, `POST /v1/docs/:doc/ops`, owner-only `GET|PUT /v1/people` and `GET /v1/export`.
- The room socket `/v1/docs/:doc/socket`: `hello {since}` → `welcome` (with all threads when `since` is 0 or too old) → `ops` / `applied`, `ack`, `reject`.

## Limits

`LIMITS` in `cloud/protocol.ts`: body length, ops per message and per minute, threads per document, comments per thread, sockets per person, open votes and ballots per vote. Both sides enforce them; the server is the one that counts.

## Whiteboard support in Cloud files

Protocol 2 clients and hosts advertise `whiteboard` in the optional `capabilities` lists on `hello` and `welcome`. The Mac host also lists it at `GET /v1/info` so Canvas can check support before importing a local package. HTTP clients send `x-canvas-files-capabilities: whiteboard` when requesting a manifest or submitting file actions.

A legacy client can still edit files without stickies or stickers. A file that needs whiteboard support returns `update` with an upgrade message. A connected legacy client receives that error before the first incompatible action can reach it.
