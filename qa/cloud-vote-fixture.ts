import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { VoteOp } from "../cloud/protocol.ts";

export async function votePost(base: string, route: string, body: unknown) {
  const r = await fetch(base + route, { method: "POST", headers: { "x-canvas": "1", "content-type": "application/json" }, body: JSON.stringify(body) });
  const answer = await r.json();
  assert.ok(r.ok, `${route.split("?")[0]} returned ${r.status}: ${answer.error ?? answer.message ?? answer.code ?? ""}`);
  return answer;
}

export async function cloudVoteFiles(owner: string, viewer: string) {
  const host = await votePost(owner, "/api/cloud/host/start", { name: "Studio", label: "Anna" });
  const invite = await votePost(owner, "/api/cloud/host/invite", { hostId: host.hostId, label: "Ben", role: "viewer" });
  const joined = await votePost(viewer, "/api/cloud/join", { link: invite.link, device: "Test Mac" });
  const opened = await votePost(owner, "/api/cloud/files/create", { cloud: host.url, name: "Whiteboard" });
  await votePost(owner, "/api/structure?file=" + encodeURIComponent(opened.file), { file: opened.file, op: "add", nodes: [
    { id: "Board", type: "frame", width: 640, height: 480, fill: "#ffffff", layout: "none", children: [
      { id: "BallotTarget", type: "rectangle", x: 90, y: 90, width: 140, height: 110, fill: "#aa66bb" },
    ] },
  ] });
  const peer = await votePost(viewer, "/api/cloud/files/open", { cloud: joined.url, id: opened.id });
  return { owner: opened.file as string, viewer: peer.file as string, hostId: host.hostId as string, cloud: host.url as string };
}

export async function viewerComment(base: string, file: string) {
  const query = "?file=" + encodeURIComponent(file);
  const { doc } = await (await fetch(base + "/api/comments" + query)).json();
  await votePost(base, "/api/comments/ops" + query, { ops: [{ doc, opId: randomUUID(), at: new Date().toISOString(), op: {
    kind: "thread.create", thread: randomUUID(), comment: randomUUID(), anchor: { x: 0, y: 0 }, body: "A viewer can comment",
  } }] });
}

export function whiteboardOp(base: string, file: string, op: VoteOp) {
  return fetch(base + "/api/votes?file=" + encodeURIComponent(file), {
    method: "POST", headers: { "x-canvas": "1", "content-type": "application/json" },
    body: JSON.stringify({ name: "Anna", envelope: {
      doc: "00000000-0000-4000-8000-000000000000", opId: randomUUID(), at: new Date().toISOString(), op,
    } }),
  });
}

export const viewerTimerControls = "[data-timer-pause], [data-timer-resume], [data-timer-extend], [data-timer-stop]";
