# Host a Cloud on your Mac

A Cloud keeps a file's comments in sync between people. You can host one on your own Mac: no account, nothing to deploy. While your Mac is open, everyone you invited can comment together. When you close the lid, the Cloud is down until you open it again; comments written meanwhile wait on each Mac and send on their own.

## Start hosting

1. Open Settings > Cloud and turn on **Host a Cloud**.
2. Under **Add person**, type the person's name or email and click **Copy Invite**. The invite link is now on your clipboard. Canvas never shows it on screen.
3. Send it to them the way you like (a message, an email). It works once, within 48 hours.
4. They open the link (or paste it into Settings > Cloud on their Mac). Canvas asks them first and shows the Cloud's name and a short **fingerprint**. Read yours from Settings > Cloud: they should match.

Their Mac then appears under your Cloud's people as "Joined from" its name. To remove someone, click **Remove**: their Macs lose access at once and any invite still waiting for them stops working.

## Same Wi-Fi or anywhere

It works the same everywhere: on the same Wi-Fi, from home, from a café. Canvas connects the two Macs with an encrypted tunnel (WireGuard, from the open source tailcat library, built into Canvas). It finds a direct path when it can, including on the same Wi-Fi. When no direct path works, traffic goes through a relay run by Tailscale for free. The relay passes encrypted traffic along: it sees which Macs connect and when, not what is said. You do not need a Tailscale account or anything else installed.

Canvas never sends comments over plain, unencrypted network connections. The Cloud on your Mac only listens on the Mac itself; the tunnel is the only way in, and every request also needs the person's own token.

## What to know

- Everyone in a Cloud can read the comments on every file shared to it.
- Deleting a comment empties it, but its text stays in the Cloud's history, and each person keeps their own copy of the comments they already have.
- Removing someone stops their access from then on. It cannot take back what they already have on their Mac.
- While you host, your Mac does not go to sleep on its own. Closing the lid still sleeps it, and then the Cloud is down.
- The Cloud's data is on your Mac in `~/Library/Application Support/Canvas/cloud-host` (only your user can read it). Time Machine backs it up like your other files.
- Tokens and tunnel keys are kept in the macOS Keychain, where apps running as you can read them.

## Stop hosting, delete the data

Turning **Host a Cloud** off stops the Cloud and the tunnel, and ends everyone's access: if you host again, they need a new invite. The comments stay on your Mac until you click **Delete** next to **Hosted data**, which removes them, the people and the history. Copies other people keep, and your backups, are not touched.

## Leave a Cloud you joined

Settings > Cloud > **Leave** forgets the invite on this Mac and stops its tunnel. Your files keep their comments.

## For developers

- The Cloud on a Mac is its own process (`cloud/node/main.ts`) with only the Cloud API, on `127.0.0.1:5190`. Canvas's editor server (`127.0.0.1:5189`) starts it, talks to it over the process's IPC channel and nothing else, and it stops when Canvas quits. The room and team logic is `cloud/core`, the same code the Cloudflare Worker runs.
- The tunnel helper is `canvas-tunnel` (`cloud/tunnel`, Go, the tailcat library pinned in `go.mod` and `go.sum`). `apps/macos/build.sh` builds it when Go is installed; without Go, Host a Cloud is off in that build. A release build fails without it. Orders go to the helper on stdin, never on its command line (`src/cloud-tunnel.ts`).
- Two tunnels serve port 5190: the member tunnel lets in only the tunnel keys of Macs that joined, and the enrolment tunnel runs only while an invite is waiting. Both keys are made once and kept in the Keychain, so their addresses survive restarts.
- People and devices: a person has a random id (who they are) and a label (shown, never trusted). An invite is a single-use join code; the joining Mac makes its own device token and its own tunnel key and sends them once with the code. Tokens and codes are stored as hashes and compared in constant time.
- A shared file names a hosted Cloud by its id (`canvas-cloud://<id>` in `comments.json`), never by an address.
- Tests: `test/cloud-host.test.ts` (the Cloud process, enrolment, removal, screening, framing), `test/cloud-hosted.test.ts` (address rules, invites, the helper's life), `node qa/cloud-hosted-e2e.ts` (two Canvas servers through the fake helper, `test/fixtures/fake-tunnel.ts`).

### Checking the real tunnel

The tests use a stand-in for the tunnel. The same end to end runs through the real one on a single Mac (it needs the network for the relays, and 127.0.0.1:5190 free):

```sh
cd cloud/tunnel && go build -mod=readonly -trimpath -o /tmp/canvas-tunnel . && cd ../..
CANVAS_E2E_TUNNEL=/tmp/canvas-tunnel node qa/cloud-hosted-e2e.ts
```

It hosts, invites, joins, syncs comments both ways, moves a pin, pauses the Cloud (the joining side reads "Cloud down", then catches up), removes the person (their socket closes and their tunnel key no longer gets in), and checks nothing is left running. It prints whether the traffic went directly or through a relay. Two Macs on different networks (a phone hotspot works) are the last check: comment from both sides, close the host's lid, and the other Mac reads "Cloud down" within about half a minute and catches up when the lid opens.

`apps/macos/build.sh` finds Go on the PATH or through mise (`mise exec go@1.27`).
