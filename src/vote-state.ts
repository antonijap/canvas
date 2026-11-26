import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { isVoteOp, needsCloudTimers, LIMITS, type Author, type CommentsFile, type OpEnvelope, type Role, type Vote, type VoteDesign, type VoteOp, type VoteTimer, type VoteView } from "../cloud/protocol.ts";
import { validateVoteTarget, type VoteTopology } from "../cloud/core/votes.ts";
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

export const voteAccount = (me?: Author) => me?.id || me?.email?.toLowerCase();
const privateVotePath = (origin: string, doc: string, account: string) =>
  path.join(stateDir(), "cloud-votes", createHash("sha256").update(JSON.stringify([origin, doc, account])).digest("hex") + ".json");

type PrivateVotes = Pick<CommentsFile, "cloudVotes" | "cloudTimer" | "timerCapable" | "voteConclusions" | "voteCapable" | "voteRole" | "outbox" | "rejected">;
export function withPrivateVotes(file: CommentsFile, account: string): CommentsFile {
  if (!file.server) return file;
  const location = privateVotePath(file.server.url, file.doc, account);
  if (!fs.existsSync(location)) return file;
  const votes: PrivateVotes = JSON.parse(fs.readFileSync(location, "utf8"));
  return { ...file, ...votes, outbox: [...file.outbox, ...votes.outbox],
    rejected: [...(file.rejected ?? []), ...(votes.rejected ?? [])] };
}
export function savePrivateVotes(file: CommentsFile, account: string) {
  if (!file.server) return;
  const { cloudVotes, cloudTimer, timerCapable, voteConclusions, voteCapable, voteRole } = file;
  const votes: PrivateVotes = { cloudVotes, cloudTimer, timerCapable, voteConclusions, voteCapable, voteRole,
    outbox: file.outbox.filter(e => isVoteOp(e.op)), rejected: file.rejected?.filter(r => isVoteOp(r.envelope.op)) };
  const location = privateVotePath(file.server.url, file.doc, account), tmp = location + "." + randomUUID();
  fs.mkdirSync(path.dirname(location), { recursive: true, mode: 0o700 });
  try {
    fs.writeFileSync(tmp, JSON.stringify(votes), { flag: "wx", mode: 0o600, flush: true });
    fs.renameSync(tmp, location);
  } finally { fs.rmSync(tmp, { force: true }); }
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
  const transferTimer = (timer: VoteTimer, vote: string, standalone?: true) => {
    const ms = timer.pausedAt ? timer.remainingMs : Date.parse(timer.endsAt ?? "") - now.getTime();
    if (!ms || ms <= 0) return;
    add({ kind: "timer.set", vote, standalone, action: "start", ms });
    if (timer.pausedAt) add({ kind: "timer.set", vote, standalone, action: "pause" });
  };
  if (file.timer && !file.timer.endedAt) transferTimer(file.timer, file.timer.id, true);
  for (const v of file.votes ?? []) {
    if (v.state === "dismissed") continue;
    add({ kind: "vote.start", vote: v.id, scope: v.scope, on: v.on, perPerson: v.perPerson, hidden: v.hidden,
      anonymous: v.anonymous, showName: v.host.id === own && !!v.host.name });
    for (const b of v.ballots) if (b.voter.id === own) {
      add({ kind: "vote.cast", vote: v.id, ballot: b.id, layer: b.layer, showName: !!b.voter.name });
    }
    if (v.state === "ended" || (v.timer?.endsAt && Date.parse(v.timer.endsAt) <= now.getTime() && !v.timer.pausedAt))
      add({ kind: "vote.end", vote: v.id });
    else if (v.timer) transferTimer(v.timer, v.id);
  }
  return out;
}

export function voteOpsForMove(file: CommentsFile, own: string, design: VoteDesign) {
  if (file.server || file.cloudVotes) return { ops: [] };
  const votes = (file.votes ?? []).filter(v => v.state !== "dismissed");
  if (votes.some(v => v.ballots.some(ballot => ballot.voter.id !== own))) {
    throw Object.assign(new Error("This file contains ballots from other voters. The local file was kept so their votes are preserved."),
      { status: 409, code: "vote_history" });
  }
  // An ended vote is briefly active during import. Import those before filling the active-vote slots.
  const ops = voteOpsForShare({ ...file, votes: [...votes.filter(v => v.state === "ended"), ...votes.filter(v => v.state === "active")] }, own);
  const accepted = new Set<string>(), pages = new Set<string>();
  let active = 0, skippedBallots = 0, skippedVotes = 0;
  const voteById = new Map(votes.map(v => [v.id, v]));
  const filtered = ops.filter(({ op }) => {
    if (!isVoteOp(op) || (op.kind === "timer.set" && op.standalone)) return true;
    const vote = voteById.get(op.vote)!;
    if (op.kind === "vote.start") {
      if (pages.has(vote.scope.page) || (vote.state === "active" && active >= LIMITS.openVotesPerDoc) ||
          accepted.size >= LIMITS.votesPerDoc || validateVoteTarget(design, vote, op)) {
        skippedVotes++;
        return false;
      }
      active += Number(vote.state === "active");
      accepted.add(op.vote);
      pages.add(vote.scope.page);
      return true;
    }
    if (!accepted.has(op.vote) || validateVoteTarget(design, vote, op)) {
      if (op.kind === "vote.cast") skippedBallots++;
      return false;
    }
    return true;
  });
  const skipped = [
    ...(skippedVotes ? [`${skippedVotes} ${skippedVotes === 1 ? "vote session" : "vote sessions"}`] : []),
    ...(skippedBallots ? [`${skippedBallots} ${skippedBallots === 1 ? "ballot" : "ballots"}`] : []),
  ];
  return { ops: filtered, notice: skipped.length ? `Moved to Cloud. Skipped ${skipped.join(" and ")} because the target was unavailable or the Cloud vote limit was reached.` : undefined };
}

export function sendableCommentOps(outbox: OpEnvelope[], role: Role | undefined, voting: boolean | undefined, timers?: boolean) {
  if (!voting) return role === "viewer" ? [] : outbox.filter(e => !isVoteOp(e.op));
  if (timers) return outbox;
  const waitingVotes = new Set(outbox.flatMap(({ op }) => op.kind === "vote.start" && needsCloudTimers(op) ? [op.vote] : []));
  return outbox.filter(({ op }) => !needsCloudTimers(op) && !(isVoteOp(op) && waitingVotes.has(op.vote)));
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
