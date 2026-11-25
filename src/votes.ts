import { randomUUID } from "node:crypto";
import type http from "node:http";
import path from "node:path";
import { applyOp, checkEnvelope, isVoteOp, mayApply, UPDATE_VOTE_HOST, type Author, type CommentsFile, type OpEnvelope, type Role, type Vote, type VoteOp, type VoteView } from "../cloud/protocol.ts";
import { readBodyText } from "./body.ts";
import { CommentsError, emptyComments, readCommentsFile, writeCommentsFile } from "./comments-file.ts";
import { packageOf } from "./comments.ts";
import { completeFileVoteConclusion, fileInfo, filePeers, hasConfirmedFileLayer, queueFileVote } from "./cloud-files.ts";
import { isShared, NIL_DOC } from "./cloud-sync.ts";
import { currentDoc } from "./docwriter.ts";
import { findNode, type CanvasDoc, type DocNode } from "./engine.ts";
import { turnedBox } from "./groupfit.ts";
import { listPages } from "./pages.ts";
import { BOARD_GAP, cardBoxes, clearCardSpot, topBox } from "./placement.ts";
import { cleanName } from "./settings.ts";
import type { StructureBody } from "./structure.ts";
import { TOKENS } from "./tokens.ts";
import { legacyVoteClockOffset, queueLegacyVote } from "./cloud.ts";
import { validateVoteTarget, voteTotals } from "../cloud/core/votes.ts";
import { ownLocalVotes, voterId } from "./vote-state.ts";

const docNode = (doc: CanvasDoc, id: string) => {
  try { return findNode(doc, id); } catch { return null; }
};
const idsOf = (doc: CanvasDoc) => doc.children.map(n => String(n.id));
const pageOf = (docFile: string, doc: CanvasDoc, page: string) => listPages(docFile, () => idsOf(doc)).pages.find(p => p.id === page);
const onPage = (found: NonNullable<ReturnType<typeof docNode>>, page: NonNullable<ReturnType<typeof pageOf>>) =>
  page.boards.includes(String((found.ancestors[0] ?? found.node).id));

function validateTarget(docFile: string, doc: CanvasDoc, votes: Pick<Vote, "id" | "scope" | "on">[], op: VoteOp) {
  return validateVoteTarget({
    page: id => !!pageOf(docFile, doc, id),
    node: id => {
      const found = docNode(doc, id);
      if (!found) return;
      const chain = [found.node, ...found.ancestors];
      const page = listPages(docFile, () => idsOf(doc)).pages.find(p => onPage(found, p));
      if (page) return { page: page.id, chain: chain.map(n => String(n.id)), type: found.node.type ?? "unknown", disabled: chain.some(n => n.enabled === false) };
    },
  }, votes.find(v => v.id === op.vote), op);
}

export function voteResults(vote: Vote | VoteView, doc: CanvasDoc) {
  const totals = "host" in vote ? voteTotals(vote) : vote.totals ?? [];
  const counts = [...totals].sort((a, b) => b.count - a.count);
  let rank = 1;
  return counts.map(({ layer, count, names }, i) => {
    if (i && count !== counts[i - 1].count) rank = i + 1;
    const node = docNode(doc, layer)?.node;
    const text = typeof node?.content === "string" ? node.content : Array.isArray(node?.content)
      ? node.content.map(s => s && typeof s === "object" && "content" in s ? s.content : "").join("")
      : "";
    const label = typeof node?.name === "string" ? node.name : "";
    const type = typeof node?.type === "string" ? node.type : "Deleted layer";
    const name = (text || label || type).replace(/\s+/g, " ").trim().slice(0, 120) || "Untitled sticky";
    return { layer, count, name, rank, names: vote.anonymous ? [] : [...names], ...(node?.type === "sticky" && { color: node.color }) };
  });
}

function pendingCloudVotes(file: CommentsFile): VoteView[] {
  const votes = structuredClone(file.cloudVotes ?? []);
  for (const { op } of file.outbox) {
    if (!isVoteOp(op)) continue;
    const vote = votes.find(v => v.id === op.vote);
    if (op.kind === "vote.start" && !vote) {
      const { scope, on, perPerson, hidden, anonymous } = op;
      votes.push({ id: op.vote, scope, on, perPerson, hidden, anonymous, state: "active", ballots: [] });
    }
    if (vote?.state !== "active") continue;
    if (op.kind === "vote.cast" && vote.ballots.length < vote.perPerson && !vote.ballots.some(b => b.id === op.ballot))
      vote.ballots.push({ id: op.ballot, layer: op.layer });
    if (op.kind === "vote.retract") vote.ballots = vote.ballots.filter(b => b.id !== op.ballot);
  }
  return votes;
}

function visibleCloudVotes(file: CommentsFile, doc: CanvasDoc, role: Role | undefined, people: Author[]) {
  const host = role === "owner" || role === "editor";
  return pendingCloudVotes(file).filter(v => v.state !== "dismissed").map(v => {
    const live = v.state === "active";
    const pendingEnd = file.outbox.some(({ op }) => op.kind === "vote.end" && op.vote === v.id);
    const progress = new Map((v.progress ?? []).map(p => [p.id, p]));
    if (live && !v.anonymous) for (const person of people) {
      const id = person.id || person.email;
      if (id && !progress.has(id) && ![...progress.values()].some(p => p.name === person.name)) progress.set(id, { id, name: person.name, done: false });
    }
    const { id, scope, on, perPerson, hidden, anonymous, state, timer } = v;
    return {
      id, scope, on, perPerson, hidden, anonymous, state, timer, mine: v.ballots.length, host, pendingEnd,
      scopeName: (scope.frame && docNode(doc, scope.frame)?.node.name) || "",
      pendingConclusion: file.voteConclusions?.includes(id) ?? false,
      ballots: live ? v.ballots.map(b => ({ ...b, own: true })) : [],
      ...(live ? {
        people: [...progress.values()].slice(0, 8), done: v.done ?? 0,
        ...(v.totals && { peerTotals: v.totals.map(({ layer, count }) => ({ layer, count })) }),
      } : { results: voteResults(v, doc), total: totalOf(v), voters: v.voters }),
    };
  });
}

const totalOf = (vote: Vote | VoteView) => "host" in vote ? vote.ballots.length : (vote.totals ?? []).reduce((n, row) => n + row.count, 0);

export function visibleVotes(file: CommentsFile, id: string, doc: CanvasDoc, local = false) {
  return (file.votes ?? []).filter(v => v.state !== "dismissed").map(v => {
    const mine = v.ballots.filter(b => b.voter.id === id);
    const live = v.state === "active";
    const visible = live ? (v.hidden ? mine : v.ballots).map(b => ({
      layer: b.layer, own: b.voter.id === id, ...(b.voter.id === id && { id: b.id }),
      ...(!v.anonymous && !v.hidden && b.voter.name && { name: b.voter.name }),
    })) : [];
    const { scope, on, perPerson, hidden, anonymous, state, timer } = v;
    return {
      id: v.id, scope, on, perPerson, hidden, anonymous, state, timer, ballots: visible,
      mine: mine.length, host: local || v.host.id === id,
      scopeName: (scope.frame && docNode(doc, scope.frame)?.node.name) || "",
      pendingConclusion: file.voteConclusions?.includes(v.id) ?? false,
      ...(live ? {} : { results: voteResults(v, doc), total: v.ballots.length }),
    };
  });
}

const resultColor = TOKENS.light;
const conclusionId = (voteId: string) => "vote-conclusion-" + voteId;

function conclusion(docFile: string, doc: CanvasDoc, vote: Vote | VoteView): StructureBody {
  const rows = voteResults(vote, doc);
  const width = 424, rowHeight = 38, height = 80 + Math.max(1, rows.length) * rowHeight;
  const page = pageOf(docFile, doc, vote.scope.page);
  const boards = doc.children.filter(node => page?.boards.includes(String(node.id)));
  const boardBox = (node: DocNode) => {
    const { x, y, w, h } = topBox(node);
    const { x0, y0, x1, y1 } = turnedBox(node, x, y, w, h);
    return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
  };
  const boxes = boards.map(boardBox);
  boxes.push(...cardBoxes(docFile, page?.id ?? null, listPages(docFile, () => idsOf(doc)).pages[0]?.id === page?.id));
  const frame = vote.scope.frame && docNode(doc, vote.scope.frame);
  const origin = frame ? boardBox(frame.ancestors[0] ?? frame.node) : boxes[0];
  const { x, y } = clearCardSpot({ x: origin ? origin.x + origin.w + BOARD_GAP : 0, y: origin?.y ?? 0, w: width, h: height }, boxes);
  const text = (content: string, x: number, y: number, width: number, size: number, fill: string, weight = "500", align = "left"): DocNode =>
    ({ type: "text", content, x, y, width, height: rowHeight, textGrowth: "fixed-width-height", textAlign: align, textAlignVertical: "middle", fontFamily: "system-ui", fontSize: size, fontWeight: weight, fill });
  const children: DocNode[] = [
    text("Vote conclusion", 20, 12, width - 40, 22, resultColor.fg, "700"),
    text(totalOf(vote) === 1 ? "1 vote" : `${totalOf(vote)} votes`, 20, 39, width - 40, 13, resultColor.mutedFg),
  ];
  for (const [i, row] of rows.entries()) {
    const rowY = 72 + i * rowHeight, winner = row.rank === 1;
    if (winner) children.push({ type: "frame", layout: "none", x: 12, y: rowY, width: width - 24, height: rowHeight - 2, fill: resultColor.componentSoft, cornerRadius: 8 });
    children.push(text(`${row.rank}. ${row.name}`, 24, rowY, width - 95, 14, resultColor.fg, winner ? "700" : "500"));
    children.push(text(String(row.count), width - 65, rowY, 43, 14, winner ? resultColor.selInk : resultColor.fg, "700", "right"));
  }
  if (!rows.length) children.push(text("No votes cast", 20, 72, width - 40, 14, resultColor.mutedFg));
  return {
    op: "add", page: page?.id, place: { parent: null }, nodes: [{
      type: "frame", id: conclusionId(vote.id), name: "Vote conclusion", x, y, width, height, layout: "none",
      fill: resultColor.popover, stroke: resultColor.line, strokeWidth: 1, cornerRadius: 16, children,
    }],
  };
}

type VoteDeps = {
  changed: (file: string) => void;
  place: (file: string, body: StructureBody) => Promise<unknown>;
};
const placing = new Map<string, Promise<void>>();

async function placeConclusion(file: string, pkg: string, docFile: string, vote: Vote | VoteView, deps: VoteDeps) {
  const key = pkg + "/" + vote.id;
  const running = placing.get(key);
  if (running) return running;
  const inCloudFile = !!fileInfo(file, false);
  const work = (async () => {
    const doc = currentDoc(docFile).doc;
    // A retry after an interrupted save can find the card already on the canvas.
    if (!docNode(doc, conclusionId(vote.id))) await deps.place(file, conclusion(docFile, doc, vote));
    if (inCloudFile) {
      if (hasConfirmedFileLayer(file, conclusionId(vote.id))) completeFileVoteConclusion(file, vote.id);
      return;
    }
    const latest = readCommentsFile(pkg);
    if (!latest) return;
    latest.voteConclusions = latest.voteConclusions?.filter(id => id !== vote.id);
    if (!latest.voteConclusions?.length) delete latest.voteConclusions;
    latest.cloudVotes = latest.cloudVotes?.filter(v => v.state !== "dismissed" || v.id !== vote.id);
    writeCommentsFile(pkg, latest);
  })();
  placing.set(key, work);
  try { await work; } finally { placing.delete(key); }
}

export async function syncVoteConclusions(file: string, deps: VoteDeps) {
  const pkg = packageOf(file), sidecar = readCommentsFile(pkg);
  if (!sidecar?.cloudVotes?.some(v => v.needsConclusion || sidecar.voteConclusions?.includes(v.id))) return;
  const shared = fileInfo(file, false);
  if (!shared && !isShared(sidecar)) return;
  const role = shared?.role ?? sidecar.voteRole;
  if (!(shared?.voting ?? sidecar.voteCapable) || (role !== "owner" && role !== "editor")) return;
  const docFile = path.join(pkg, "document.json");
  for (const vote of sidecar.cloudVotes) {
    if (shared && !fileInfo(file, false)) return;
    if (sidecar.voteConclusions?.includes(vote.id)) {
      const before = docNode(currentDoc(docFile).doc, conclusionId(vote.id));
      const confirmed = !shared || hasConfirmedFileLayer(file, conclusionId(vote.id));
      await placeConclusion(file, pkg, docFile, vote, deps);
      // A pending design write will send another file event when the room applies it.
      if (!before || confirmed) deps.changed(file);
    } else if (vote.needsConclusion && !sidecar.outbox.some(({ op }) => op.kind === "vote.end" && op.vote === vote.id)) {
      const envelope = { doc: sidecar.doc, opId: randomUUID(), at: new Date().toISOString(), op: { kind: "vote.end", vote: vote.id, expired: true } } as const;
      if (shared) queueFileVote(file, envelope);
      else {
        const latest = readCommentsFile(pkg);
        if (latest) queueLegacyVote(pkg, file, latest, envelope);
      }
    }
  }
}

export async function handleVotesRoute(req: http.IncomingMessage, res: http.ServerResponse, url: URL, deps: VoteDeps): Promise<boolean> {
  if (url.pathname !== "/api/votes") return false;
  const reply = (status: number, body: unknown): true => {
    res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store", "x-content-type-options": "nosniff" });
    res.end(JSON.stringify(body));
    return true;
  };
  try {
    const file = url.searchParams.get("file");
    if (!file) return reply(400, { error: "A file is required" });
    const shared = fileInfo(file);
    const pkg = packageOf(file), docFile = path.join(pkg, "document.json");
    const sidecar = readCommentsFile(pkg) ?? { ...emptyComments(), ...(shared && { doc: shared.file }) };
    const cloud = !!shared || isShared(sidecar);
    const capable = shared ? shared.voting : sidecar.voteCapable;
    const role = shared?.role ?? sidecar.voteRole;
    const me = shared?.author ?? sidecar.me;
    const present = [...(me?.name ? [me as Author] : []), ...filePeers(file).filter(p => !p.gone && !p.by.agent).map(p => ({ ...p.by, name: p.by.name ?? "Someone" }))];
    const people = [...new Map(present.map(p => [p.id || p.email || p.name, p])).values()];
    const cloudView = (f: CommentsFile) => ({
      votes: !capable && f.votes?.length && !f.cloudVotes?.length
        ? visibleVotes({ ...f, votes: ownLocalVotes(f.votes) },
          voterId(), currentDoc(docFile).doc).map(v => ({ ...v, host: false }))
        : visibleCloudVotes(f, currentDoc(docFile).doc, role, people),
      people: people.slice(0, 8).map(p => ({ id: p.id || p.email, name: p.name, done: false })),
      canStart: role === "owner" || role === "editor", canVote: capable === true, serverTime: shared?.serverTime,
      clockOffset: shared?.voteClockOffset ?? legacyVoteClockOffset(pkg),
      message: capable === false ? UPDATE_VOTE_HOST : capable === undefined ? "Connect to the Cloud to check for voting support." : undefined,
      pending: f.outbox.filter(e => isVoteOp(e.op)).length,
      rejected: (f.rejected ?? []).filter(r => isVoteOp(r.envelope.op)).map(r => ({ id: r.envelope.opId, message: r.message })),
    });
    if (req.method === "GET") {
      if (!cloud) return reply(200, { votes: sidecar.votes?.length ? visibleVotes(sidecar, voterId(), currentDoc(docFile).doc, true) : [] });
      if (sidecar.voteConclusions?.length || sidecar.cloudVotes?.some(v => v.needsConclusion))
        void syncVoteConclusions(file, deps).catch(() => {});
      return reply(200, cloudView(sidecar));
    }
    if (req.method !== "POST") return reply(405, { error: "Method not allowed" });
    if (req.headers["x-canvas"] !== "1" || req.headers["x-canvas-source"] === "mcp") return reply(403, { error: "Open the canvas to vote." });
    const raw = await readBodyText(req, 8192);
    if (raw === null) return reply(413, { error: "The vote request is too large." });
    let body: { envelope?: unknown; name?: unknown };
    try { body = JSON.parse(raw); } catch { return reply(400, { error: "The request body must be JSON." }); }
    const invalid = checkEnvelope(body?.envelope);
    if (invalid) return reply(400, { error: invalid });
    const { op, doc: addressed } = body.envelope as OpEnvelope;
    if (!isVoteOp(op)) return reply(400, { error: "Expected a vote operation." });
    const envelope = body.envelope as OpEnvelope;
    // The body read yields to the room socket, so validate and append against its latest state.
    const latestState = readCommentsFile(pkg) ?? sidecar;
    if (cloud) {
      const actualRole = fileInfo(file)?.role ?? latestState.voteRole;
      if (capable !== true) return reply(426, { error: cloudView(latestState).message });
      if (!actualRole || !mayApply(op, actualRole, me as Author, []))
        return reply(403, { error: "Only owners and editors can manage Cloud votes." });
      if (addressed !== NIL_DOC && addressed !== latestState.doc) return reply(409, { error: "This vote is for a different file." });
      const targetError = validateTarget(docFile, currentDoc(docFile).doc, pendingCloudVotes(latestState), op);
      if (targetError) return reply(409, { error: targetError });
      const showName = !!cleanName(body.name);
      const outgoing = { ...envelope, op: op.kind === "vote.start" || op.kind === "vote.cast" ? { ...op, showName } : op };
      if (shared) queueFileVote(file, outgoing);
      else queueLegacyVote(pkg, file, latestState, outgoing);
      deps.changed(file);
      return reply(200, cloudView(readCommentsFile(pkg) ?? latestState));
    }
    if (op.kind === "vote.end" && op.expired) return reply(409, { error: "Cloud timer required" });
    const votes = latestState.votes ??= [];
    const doc = currentDoc(docFile).doc, id = voterId();
    if (addressed !== NIL_DOC && addressed !== latestState.doc) return reply(409, { error: "This vote is for a different file." });
    const targetError = validateTarget(docFile, doc, votes, op);
    if (targetError) return reply(409, { error: targetError });
    const previous = votes.find(v => v.id === op.vote)?.state;
    if (op.kind === "vote.clear" && latestState.voteConclusions?.includes(op.vote)) return reply(409, { error: "Place the conclusion before clearing the vote." });
    const at = new Date().toISOString();
    const error = applyOp(latestState.threads, latestState.doc, op, { id, name: cleanName(body.name) }, at, votes, true);
    if (error) return reply(409, { error });
    const vote = votes.find(v => v.id === op.vote)!;
    if (op.kind === "vote.end" && previous === "active") (latestState.voteConclusions ??= []).push(vote.id);
    writeCommentsFile(pkg, latestState);
    try {
      if (op.kind === "vote.end" && latestState.voteConclusions?.includes(vote.id)) await placeConclusion(file, pkg, docFile, vote, deps);
    } finally {
      deps.changed(file);
    }
    const latest = readCommentsFile(pkg) ?? latestState;
    return reply(200, { votes: visibleVotes(latest, id, currentDoc(docFile).doc, true) });
  } catch (error) {
    if (error instanceof CommentsError) return reply(error.status, { error: error.message });
    if (error instanceof Error && "status" in error && typeof error.status === "number") return reply(error.status, { error: error.message });
    return reply(500, { error: (error as Error).message });
  }
}
