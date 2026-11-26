import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { launchChrome, type Chrome } from "../fidelity/cdp.ts";
import { sc, T } from "./harness.ts";
import { cloudVoteFiles, viewerComment, viewerTimerControls, whiteboardOp, votePost } from "./cloud-vote-fixture.ts";
import { openTab, ROOT, sleep, startServer, type Scratch } from "./lib.ts";

sc("sticky", "Sticky text presence and stickers replicate on a Cloud file", {
  covers: ["sticky:cloud", "sticker:cloud"],
  skip: { visual: "Checks two live canvases and the data their Cloud file saves." },
}, async (t: T) => {
  const dir = fs.mkdtempSync(path.join(path.dirname(t.file), "whiteboard-cloud-"));
  const tunnels = path.join(dir, "tunnels");
  fs.mkdirSync(tunnels);
  const servers: Scratch[] = [];
  let localTab: Awaited<ReturnType<typeof openTab>> | undefined;
  let peerChrome: Chrome | undefined;
  async function person(name: string) {
    const home = path.join(dir, name);
    fs.mkdirSync(home);
    const server = await startServer(home, {
      HOME: home, CANVAS_STATE_DIR: path.join(home, "state"), CANVAS_CLOUD_SECRETS_FILE: path.join(home, "secrets.json"),
      CANVAS_COMMENT_NAME: name, CANVAS_TUNNEL_BIN: path.join(ROOT, "test/fixtures/fake-tunnel.sh"),
      CANVAS_FAKE_TUNNEL_DIR: tunnels, CANVAS_FAKE_TUNNEL_NODE: process.execPath, CANVAS_FAKE_TUNNEL_ANY_PORT: "1",
      CANVAS_CLOUD_HOST_PORT: "0",
    });
    servers.push(server);
    return server;
  }
  async function post<T>(server: Scratch, route: string, body: unknown): Promise<T> {
    const response = await fetch(server.base + route, { method: "POST", headers: { "x-canvas": "1", "content-type": "application/json" },
      body: JSON.stringify(body) });
    const answer = await response.json();
    t.ok(response.ok, `${route} returned ${response.status} ${JSON.stringify(answer)}`);
    return answer as T;
  }
  try {
    const anna = await person("Anna");
    const ben = await person("Ben");
    const host = await post<{ url: string; hostId: string }>(anna, "/api/cloud/host/start", { name: "Studio", label: "Anna" });
    const invite = await post<{ link: string }>(anna, "/api/cloud/host/invite", { hostId: host.hostId, label: "Ben", role: "editor" });
    const joined = await post<{ url: string }>(ben, "/api/cloud/join", { link: invite.link, device: "Test Mac" });
    const home = await post<{ id: string; file: string }>(anna, "/api/cloud/files/create", { cloud: host.url, name: "Whiteboard" });
    const remote = await post<{ file: string }>(ben, "/api/cloud/files/open", { cloud: joined.url, id: home.id });
    localTab = await openTab(t.chromePort);
    peerChrome = await launchChrome();
    const local = new T(localTab.page, home.file, anna), peer = new T(await peerChrome.newPage(), remote.file, ben);
    await post(anna, "/api/structure?file=" + encodeURIComponent(home.file), { file: home.file, op: "add",
      nodes: [{ id: "Board", type: "frame", width: 640, height: 480, fill: "#ffffff", layout: "none", children: [] }] });
    await local.open();
    await peer.open();
    await peer.waitFor('window.canvasHost.worldRectOf("Board")', "the board on the peer");
    await local.page.send("Page.bringToFront");
    await local.focus("Board");
    const point = await local.center("Board");
    await local.io.key("s");
    await local.io.click(point.x, point.y);
    await local.waitFor("window.canvasHost.textEdit.active", "the shared sticky editor");
    const [id] = await local.sel(), node = JSON.stringify(id);
    await peer.waitFor(`window.canvasHost.worldRectOf(${node})`, "the peer sees the inserted sticky");
    const plain = "Typing together";
    await local.io.type(plain);
    await peer.waitFor(`window.canvasHost.engineView.textLines(${node})?.lines.some(line => line.right > line.x + 12)`, "unsaved text drawn on the peer");
    t.eq(peer.node(id)?.content, "", "live preview leaves the stored note untouched");
    await local.io.key("Escape");
    const deadline = Date.now() + 8000;
    while (peer.node(id)?.content !== plain && Date.now() < deadline) await sleep(40);
    t.eq(peer.node(id)?.content, plain, "text committed to the peer's file");
    await local.waitFor('document.querySelector(".sticky-author")?.getAttribute("aria-pressed") === "true"', "the author toggle");
    const author = await local.ev<{ x: number; y: number }>(`(() => {
      const r = document.querySelector(".sticky-author").getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.top + r.height / 2 };
    })()`);
    await local.io.click(author.x, author.y);
    await local.flush();
    const waitForAuthor = async (name?: string) => {
      const until = Date.now() + 8000;
      while (peer.node(id)?.author?.name !== name && Date.now() < until) await sleep(40);
      t.eq(peer.node(id)?.author?.name, name, "the shared sticky author on disk");
    };
    await waitForAuthor();
    await local.undo();
    await waitForAuthor("Anna");
    const center = await local.center(id);
    await local.io.key("s", { shift: true });
    await local.io.click(center.x + 65, center.y - 65);
    await local.flush();
    const [seal] = await local.sel();
    await peer.waitFor('document.querySelector("[data-sticker-seal]:not([hidden])")', "sticker drawn on the peer");
    t.eq([peer.node(seal)?.type, peer.node(seal)?.on?.layer, peer.node(seal)?.by?.name], ["sticker", id, "Anna"], "sticker saved with its anchor and name");
  } finally {
    await Promise.allSettled([localTab?.close(), peerChrome?.stop()]);
    await Promise.allSettled(servers.map((server) => server.stop()));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

sc("vote", "Cloud vote and timer let a viewer vote and comment without revealing hidden ballots", {
  covers: ["vote:cloud", "vote:cloud-privacy", "vote:cloud-viewer", "vote:cloud-private-presence", "vote:cloud-cache", "vote:cloud-design", "timer:cloud", "timer:expiry"],
  skip: { visual: "Checks the two live canvases and the synchronized results." },
}, async (t: T) => {
  const dir = fs.mkdtempSync(path.join(path.dirname(t.file), "vote-cloud-"));
  const tunnels = path.join(dir, "tunnels");
  fs.mkdirSync(tunnels);
  const servers: Scratch[] = [];
  let tab: Awaited<ReturnType<typeof openTab>> | undefined;
  let chrome: Chrome | undefined;
  try {
    for (const name of ["Anna", "Ben"]) {
      const home = path.join(dir, name);
      fs.mkdirSync(home);
      servers.push(await startServer(home, {
        HOME: home, CANVAS_STATE_DIR: path.join(home, "state"), CANVAS_CLOUD_SECRETS_FILE: path.join(home, "secrets.json"),
        CANVAS_COMMENT_NAME: name, CANVAS_TUNNEL_BIN: path.join(ROOT, "test/fixtures/fake-tunnel.sh"),
        CANVAS_FAKE_TUNNEL_DIR: tunnels, CANVAS_FAKE_TUNNEL_NODE: process.execPath, CANVAS_FAKE_TUNNEL_ANY_PORT: "1",
        CANVAS_CLOUD_HOST_PORT: "0",
      }));
    }
    const [a, b] = servers;
    const files = await cloudVoteFiles(a.base, b.base);
    tab = await openTab(t.chromePort);
    chrome = await launchChrome();
    const anna = new T(tab.page, files.owner, a), ben = new T(await chrome.newPage(), files.viewer, b);
    await anna.open();
    await ben.open();
    await anna.page.send("Page.bringToFront");
    await anna.io.key("d", { shift: true });
    await anna.waitFor('document.querySelector("[data-vote-sheet]:not([hidden])")', "start sheet");
    await anna.ev('document.querySelector(\'[data-vote-mode="anything"]\').click()');
    await anna.ev('document.querySelector(\'[aria-label="Fewer votes"]\').click(); document.querySelector(\'[aria-label="Fewer votes"]\').click(); document.querySelector("[data-vote-start]").click()');
    await ben.waitFor('document.querySelector(".vote-bar:not([hidden])")', "the viewer sees the live vote");
    await ben.page.send("Page.bringToFront");
    await ben.focus("Board");
    const point = await ben.center("BallotTarget");
    await ben.ev('window.canvasHost.presence.update({cursor:{x:310,y:220},sel:["BallotTarget"]})');
    await ben.waitFor('window.canvasHost.votes.privatePresence === true', "private voting disables presence");
    t.eq(await anna.ev('document.querySelectorAll(".cp-cursor,.cp-selection").length'), 0, "the owner sees no ballot pointers");
    await ben.io.click(point.x, point.y);
    await ben.waitFor('document.querySelector("[data-vote-mark]")', "the viewer sees their dot");
    await anna.waitFor('document.querySelector("[data-vote-progress-done]")?.parentElement.title === "Ben, done voting"', "the owner sees who is done");
    t.eq(await anna.ev('document.querySelectorAll("[data-vote-mark]").length'), 0, "the owner cannot see the viewer's dot");
    fs.writeFileSync("qa/out/vote-cloud-progress.png", await anna.shot());
    const query = "?file=" + encodeURIComponent(files.viewer);
    await votePost(b.base, "/api/cloud/files/disconnect" + query, {});
    await ben.ev('document.querySelector("[data-vote-mark]").click()');
    await ben.waitFor('!document.querySelector("[data-vote-mark]")', "the offline retract is visible locally");
    await votePost(b.base, "/api/cloud/files/reconnect" + query, {});
    await anna.waitFor('!document.querySelector("[data-vote-progress-done]")', "the retract reached the host");
    await ben.io.click(point.x, point.y);
    await anna.waitFor('document.querySelector("[data-vote-progress-done]")', "the second vote reached the host");
    await viewerComment(b.base, files.viewer);
    await anna.waitFor('document.querySelector(".cm-pin")', "the viewer comment reaches the owner");
    const denied = await fetch(b.base + "/api/structure" + query, { method: "POST", headers: { "x-canvas": "1", "content-type": "application/json" },
      body: JSON.stringify({ file: files.viewer, op: "add", nodes: [{ id: "ViewerEdit", type: "rectangle", width: 20, height: 20 }] }) });
    t.eq(denied.status, 403, "the same viewer cannot change the drawing");
    await anna.ev('document.querySelector("[data-vote-end]").click()');
    await ben.waitFor('document.querySelector("[data-vote-count]")?.textContent.trim() === "1"', "the viewer sees the result");
    await ben.waitFor('[...window.canvasHost.boards.keys()].some(id => id.startsWith("vote-conclusion-"))', "the conclusion replicates");
    await anna.waitFor('document.querySelector("[data-vote-clear]")', "the ender can clear the revealed vote");
    await anna.ev('document.querySelector("[data-vote-clear]").click()');
    await ben.waitFor('!document.querySelector("[data-vote-count]")', "clear removes the viewer's counts");
    t.eq(await ben.ev('[...window.canvasHost.boards.keys()].filter(id => id.startsWith("vote-conclusion-")).length'), 1,
      "clearing leaves exactly one conclusion card");

    const timer = randomUUID();
    const startTimer = { kind: "timer.set", action: "start", standalone: true, vote: timer, ms: 60_000 } as const;
    t.eq((await whiteboardOp(b.base, files.viewer, startTimer)).status, 403, "the viewer cannot start a timer");
    t.eq((await whiteboardOp(a.base, files.owner, startTimer)).status, 200, "the owner starts a timer");
    const readout = '[data-timer-bar] [data-timer-countdown]';
    await ben.waitFor(`document.querySelector(${JSON.stringify(readout)})?.textContent`, "the viewer sees the standalone timer");
    t.eq(await ben.ev(`document.querySelectorAll(${JSON.stringify(viewerTimerControls)}).length`), 0, "the viewer has no timer controls");
    await anna.waitFor('document.querySelector("[data-timer-pause]")', "owner can pause the timer");
    await anna.ev('document.querySelector("[data-timer-pause]").click()');
    const paused = `document.querySelector("[data-timer-bar]").textContent.includes("Paused") && document.querySelector(${JSON.stringify(readout)}).textContent`;
    t.eq(await ben.waitFor(paused, "viewer sees the timer pause"), await anna.waitFor(paused, "owner sees the timer pause"), "both see the same countdown");
    t.eq((await whiteboardOp(b.base, files.viewer, { ...startTimer, action: "stop", ms: undefined })).status, 403, "the viewer cannot stop it");
    await anna.ev('document.querySelector("[data-timer-stop]").click()');
    await ben.waitFor('document.querySelector("[data-timer-bar]").hidden', "the viewer sees the timer stop");

    const timedVote = randomUUID();
    const page = await anna.ev<string>("window.canvasHost.page");
    t.eq((await whiteboardOp(a.base, files.owner, { kind: "vote.start", vote: timedVote, scope: { page }, on: "anything",
      perPerson: 1, hidden: true, anonymous: false, timerMs: 7000 })).status, 200, "the owner starts a timed vote");
    await ben.waitFor('document.querySelector(".timer-urgent")', "the viewer sees the last ten seconds styling");
    await ben.io.click(point.x, point.y);
    await ben.waitFor('document.querySelector("[data-vote-mark]")', "the viewer votes before the deadline");
    await ben.waitFor(`document.querySelector(".vote-bar").textContent.includes("Time's up")`, "the idle host ends the vote");
    await ben.waitFor('document.querySelector("[data-vote-count]")?.textContent.trim() === "1"', "expiry reveals the result");
    await ben.waitFor('[...window.canvasHost.boards.keys()].filter(id => id.startsWith("vote-conclusion-")).length === 2', "one more conclusion card");

    await anna.waitFor('document.querySelector("[data-vote-clear]")?.textContent === "Vote again"', "the owner can start another vote");
    await anna.ev('document.querySelector("[data-vote-clear]").click()');
    await anna.waitFor('document.querySelector("[data-vote-sheet]:not([hidden])")', "Vote again opens the start sheet");

    // A comments-only room shares its design out of band, as a synced folder would.
    const local = path.join(dir, "Anna", "Shared.canvas"), copy = path.join(dir, "Ben", "Shared.canvas");
    fs.mkdirSync(local);
    const design = { version: "2.21", children: [{ type: "frame", id: "SharedBoard", width: 300, height: 200, children: [] as object[] }] };
    fs.writeFileSync(path.join(local, "document.json"), JSON.stringify(design));
    const shared = await votePost(a.base, "/api/cloud/share?file=" + encodeURIComponent(local) + "&url=" + encodeURIComponent(files.cloud), {});
    fs.cpSync(local, copy, { recursive: true });
    const api = (route: string, file: string) => route + "?file=" + encodeURIComponent(file);
    await fetch(b.base + api("/api/comments", copy));
    async function waitVote(server: Scratch, file: string, ready: (value: any) => boolean, label: string) {
      const until = Date.now() + 8000;
      while (Date.now() < until) {
        const response = await fetch(server.base + api("/api/votes", file));
        if (response.ok && ready(await response.json())) return;
        await sleep(125);
      }
      throw new Error(label);
    }
    await waitVote(a, local, data => data.canVote === true, "Owner did not connect to the comments room");
    const vote = randomUUID();
    const send = (server: Scratch, file: string, op: object) => votePost(server.base, api("/api/votes", file), {
      name: file === local ? "Anna" : "Ben", envelope: { doc: shared.doc, opId: randomUUID(), at: new Date().toISOString(), op },
    });
    await send(a, local, { kind: "vote.start", vote, scope: { page: "page-1" }, on: "anything", perPerson: 1, hidden: true, anonymous: true });
    await waitVote(b, copy, data => data.votes.some((v: any) => v.id === vote), "Viewer did not receive the comments-only vote");
    const newLayer = "AddedWhileVoting";
    design.children[0].children.push({ type: "rectangle", id: newLayer, width: 40, height: 40 });
    for (const file of [local, copy]) fs.writeFileSync(path.join(file, "document.json"), JSON.stringify(design));
    await sleep(700);
    const ballot = randomUUID();
    await send(b, copy, { kind: "vote.cast", vote, ballot, layer: newLayer });
    await waitVote(a, local, data => data.votes.some((v: any) => v.id === vote && v.done === 1), "Host did not accept the cast on the added object");
    t.ok(!fs.readFileSync(path.join(copy, "comments.json"), "utf8").includes(newLayer), "the synced package contains no hidden target");
    t.ok(!fs.readFileSync(path.join(copy, "comments.json"), "utf8").includes(ballot), "the synced package contains no personal ballot ID");
    await waitVote(b, copy, data => data.votes.some((v: any) => v.ballots.some((b: any) => b.id === ballot)), "Viewer lost their private ballot");

  } finally {
    await Promise.allSettled([tab?.close(), chrome?.stop()]);
    await Promise.allSettled(servers.map(server => server.stop()));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
