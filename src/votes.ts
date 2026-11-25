import { randomUUID } from "node:crypto";
import fs from "node:fs";
import type http from "node:http";
import path from "node:path";
import { applyOp, checkEnvelope, isVoteOp, type CommentsFile, type OpEnvelope, type Vote, type VoteOp } from "../cloud/protocol.ts";
import { readBodyText } from "./body.ts";
import { CommentsError, emptyComments, readCommentsFile, writeCommentsFile } from "./comments-file.ts";
import { packageOf } from "./comments.ts";
import { fileInfo } from "./cloud-files.ts";
import { isShared, NIL_DOC, voteOpsForShare } from "./cloud-sync.ts";
import { currentDoc } from "./docwriter.ts";
import { findNode, type CanvasDoc, type DocNode } from "./engine.ts";
import { turnedBox } from "./groupfit.ts";
import { listPages } from "./pages.ts";
import { BOARD_GAP, cardBoxes, clearCardSpot, topBox } from "./placement.ts";
import { cleanName } from "./settings.ts";
import type { StructureBody } from "./structure.ts";
import { TOKENS } from "./tokens.ts";
import { stateDir } from "./usage-counts.ts";

function voterId() {
  const dir = stateDir(), file = path.join(dir, "whiteboard-voter");
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try { fs.writeFileSync(file, randomUUID(), { flag: "wx", mode: 0o600 }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  return fs.readFileSync(file, "utf8").trim();
}

const docNode = (doc: CanvasDoc, id: string) => {
  try { return findNode(doc, id); } catch { return null; }
};
const idsOf = (doc: CanvasDoc) => doc.children.map(n => String(n.id));
const pageOf = (docFile: string, doc: CanvasDoc, page: string) => listPages(docFile, () => idsOf(doc)).pages.find(p => p.id === page);
const onPage = (found: NonNullable<ReturnType<typeof docNode>>, page: NonNullable<ReturnType<typeof pageOf>>) =>
  page.boards.includes(String((found.ancestors[0] ?? found.node).id));

function validateTarget(docFile: string, doc: CanvasDoc, votes: Vote[], op: VoteOp) {
  if (op.kind === "vote.start") {
    const page = pageOf(docFile, doc, op.scope.page);
    if (!page) return "This page is no longer available";
    if (op.scope.frame !== undefined) {
      const frame = docNode(doc, op.scope.frame);
      if (!frame || frame.node.type !== "frame" || !onPage(frame, page)) return "Select a frame on this page";
    }
  }
  if (op.kind === "vote.cast") {
    const vote = votes.find(v => v.id === op.vote);
    if (!vote) return "No such vote";
    const page = pageOf(docFile, doc, vote.scope.page), target = docNode(doc, op.layer);
    if (!page || !target || !onPage(target, page) || [...target.ancestors, target.node].some(n => n.enabled === false)) return "That object is outside this vote";
    if (vote.scope.frame && ![...target.ancestors, target.node].some(n => n.id === vote.scope.frame)) return "That object is outside the selected frame";
    if (vote.on === "stickies" && target.node.type !== "sticky") return "Only stickies can receive votes";
  }
  return null;
}

export function voteResults(vote: Vote, doc: CanvasDoc) {
  const totals = new Map<string, { layer: string; count: number; names: Set<string> }>();
  for (const { layer, voter } of vote.ballots) {
    const row = totals.get(layer) ?? { layer, count: 0, names: new Set<string>() };
    row.count++;
    if (voter.name) row.names.add(voter.name);
    totals.set(layer, row);
  }
  const counts = [...totals.values()].sort((a, b) => b.count - a.count);
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

export function visibleVotes(file: CommentsFile, id: string, doc: CanvasDoc) {
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
      mine: mine.length, host: v.host.id === id,
      scopeName: (scope.frame && docNode(doc, scope.frame)?.node.name) || "",
      pendingConclusion: file.voteConclusions?.includes(v.id) ?? false,
      ...(live ? {} : { results: voteResults(v, doc), total: v.ballots.length }),
    };
  });
}

const resultColor = TOKENS.light;
const conclusionId = (voteId: string) => "vote-conclusion-" + voteId;

function conclusion(docFile: string, doc: CanvasDoc, vote: Vote): StructureBody {
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
    text(vote.ballots.length === 1 ? "1 vote" : `${vote.ballots.length} votes`, 20, 39, width - 40, 13, resultColor.mutedFg),
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

async function placeConclusion(file: string, pkg: string, docFile: string, vote: Vote, deps: VoteDeps) {
  const key = pkg + "/" + vote.id;
  const running = placing.get(key);
  if (running) return running;
  const work = (async () => {
    const doc = currentDoc(docFile).doc;
    // A retry after an interrupted save can find the card already on the canvas.
    if (!docNode(doc, conclusionId(vote.id))) await deps.place(file, conclusion(docFile, doc, vote));
    const latest = readCommentsFile(pkg);
    if (!latest) return;
    latest.voteConclusions = latest.voteConclusions?.filter(id => id !== vote.id);
    if (!latest.voteConclusions?.length) delete latest.voteConclusions;
    writeCommentsFile(pkg, latest);
  })();
  placing.set(key, work);
  try { await work; } finally { placing.delete(key); }
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
    if (req.method === "GET") {
      const sidecar = readCommentsFile(pkg);
      return reply(200, { votes: sidecar?.votes?.length ? visibleVotes(sidecar, voterId(), currentDoc(docFile).doc) : [] });
    }
    if (req.method !== "POST") return reply(405, { error: "Method not allowed" });
    if (req.headers["x-canvas"] !== "1" || req.headers["x-canvas-source"] === "mcp") return reply(403, { error: "Open the canvas to vote." });
    if (shared && shared.role !== "owner" && shared.role !== "editor") return reply(403, { error: "This Cloud file is read only." });
    const raw = await readBodyText(req, 8192);
    if (raw === null) return reply(413, { error: "The vote request is too large." });
    let body: { envelope?: unknown; name?: unknown };
    try { body = JSON.parse(raw); } catch { return reply(400, { error: "The request body must be JSON." }); }
    const invalid = checkEnvelope(body?.envelope);
    if (invalid) return reply(400, { error: invalid });
    const { op, doc: addressed } = body.envelope as OpEnvelope;
    if (!isVoteOp(op)) return reply(400, { error: "Expected a vote operation." });
    const sidecar = readCommentsFile(pkg) ?? emptyComments();
    const votes = sidecar.votes ??= [];
    const doc = currentDoc(docFile).doc, id = voterId();
    if (addressed !== NIL_DOC && addressed !== sidecar.doc) return reply(409, { error: "This vote is for a different file." });
    const targetError = validateTarget(docFile, doc, votes, op);
    if (targetError) return reply(409, { error: targetError });
    const previous = votes.find(v => v.id === op.vote)?.state;
    if (op.kind === "vote.clear" && sidecar.voteConclusions?.includes(op.vote)) return reply(409, { error: "Place the conclusion before clearing the vote." });
    const at = new Date().toISOString();
    const error = applyOp(sidecar.threads, sidecar.doc, op, { id, name: cleanName(body.name) }, at, votes);
    if (error) return reply(409, { error });
    const vote = votes.find(v => v.id === op.vote)!;
    if (op.kind === "vote.end" && previous === "active") (sidecar.voteConclusions ??= []).push(vote.id);
    if (shared || isShared(sidecar)) {
      sidecar.outbox = sidecar.outbox.filter(e => !isVoteOp(e.op) || e.op.vote !== vote.id);
      sidecar.outbox.push(...voteOpsForShare(vote).map(op => ({ opId: randomUUID(), doc: sidecar.doc, at, op })));
    }
    writeCommentsFile(pkg, sidecar);
    try {
      if (op.kind === "vote.end" && sidecar.voteConclusions?.includes(vote.id)) await placeConclusion(file, pkg, docFile, vote, deps);
    } finally {
      deps.changed(file);
    }
    const latest = readCommentsFile(pkg) ?? sidecar;
    return reply(200, { votes: visibleVotes(latest, id, currentDoc(docFile).doc) });
  } catch (error) {
    if (error instanceof CommentsError) return reply(error.status, { error: error.message });
    return reply(500, { error: (error as Error).message });
  }
}
