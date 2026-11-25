import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { isVoteOp, type CommentsFile, type OpEnvelope, type Role, type Vote, type VoteOp, type VoteView } from "../cloud/protocol.ts";
import type { VoteTopology } from "../cloud/core/votes.ts";
import type { CanvasDoc } from "./engine.ts";
import { listPages } from "./pages.ts";
import { stateDir } from "./usage-counts.ts";

export function voterId() {
  const dir = stateDir(), file = path.join(dir, "whiteboard-voter");
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try { fs.writeFileSync(file, randomUUID(), { flag: "wx", mode: 0o600 }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  return fs.readFileSync(file, "utf8").trim();
}

export function ownLocalVotes(votes: Vote[]): Vote[] {
  const own = votes.some(v => v.ballots.length) ? voterId() : undefined;
  return votes.map(({ retracted, ...vote }) => ({ ...vote, ballots: vote.ballots.filter(b => b.voter.id === own) }));
}

export function voteOpsForShare(file: CommentsFile, own: string, now = new Date(), id = randomUUID): OpEnvelope[] {
  // Confirmed Cloud views are tied to their original room. Local votes use this Mac's voter ID.
  if (file.server || file.cloudVotes) return [];
  const out: OpEnvelope[] = [];
  const add = (op: VoteOp) => out.push({ doc: file.doc, opId: id(), at: now.toISOString(), op });
  for (const v of file.votes ?? []) {
    if (v.state === "dismissed") continue;
    add({ kind: "vote.start", vote: v.id, scope: v.scope, on: v.on, perPerson: v.perPerson, hidden: v.hidden,
      anonymous: v.anonymous, showName: v.host.id === own && !!v.host.name });
    for (const b of v.ballots) if (b.voter.id === own) {
      add({ kind: "vote.cast", vote: v.id, ballot: b.id, layer: b.layer, showName: !!b.voter.name });
    }
    if (v.state === "ended") add({ kind: "vote.end", vote: v.id });
  }
  return out;
}

export function sendableCommentOps(outbox: OpEnvelope[], role: Role | undefined, voting: boolean | undefined) {
  return voting ? outbox : role === "viewer" ? [] : outbox.filter(e => !isVoteOp(e.op));
}

export function receiveVoteViews(file: CommentsFile, votes: VoteView[], pending: readonly OpEnvelope[] = file.outbox) {
  const confirmed: string[] = [];
  for (const v of votes) {
    if (!v.conclusionOp || !pending.some(e => e.opId === v.conclusionOp && e.op.kind === "vote.end" && e.op.vote === v.id)) continue;
    file.voteConclusions ??= [];
    if (!file.voteConclusions.includes(v.id)) file.voteConclusions.push(v.id);
    confirmed.push(v.id);
  }
  // A cleared vote can still carry the counts needed to finish placing this client's conclusion.
  file.cloudVotes = votes.filter(v => v.state !== "dismissed" || v.needsConclusion || file.voteConclusions?.includes(v.id));
  return confirmed;
}

export function voteTopology(docFile: string, doc: CanvasDoc): VoteTopology {
  const { pages } = listPages(docFile, () => doc.children.map(n => String(n.id)));
  const nodes: VoteTopology["nodes"] = [];
  const visit = (layers: CanvasDoc["children"], page: string, ancestors: string[], disabled = false) => {
    for (const n of layers) {
      const id = String(n.id), chain = [id, ...ancestors], off = disabled || n.enabled === false;
      nodes.push([id, { page, type: n.type ?? "unknown", chain, ...(off && { disabled: true }) }]);
      if (n.children?.length) visit(n.children, page, chain, off);
    }
  };
  const pageByBoard = new Map(pages.flatMap(page => page.boards.map(id => [id, page.id] as const)));
  for (const board of doc.children) {
    const page = pageByBoard.get(String(board.id));
    if (page) visit([board], page, []);
  }
  return { pages: pages.map(page => page.id), nodes };
}
