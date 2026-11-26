import { applyVote, type Author, type Vote, type VoteDesign, type VoteOp, type VoteTarget, type VoteTotal, type VoteView } from "../protocol.ts";
import { sha256Hex } from "./files/sha256.ts";
import type { TreeAccess } from "./files/apply.ts";

export function validateVoteTarget(design: VoteDesign, vote: Pick<Vote, "scope" | "on"> | undefined, op: VoteOp): string | null {
  if (op.kind === "vote.start") {
    if (!design.page(op.scope.page)) return "This page is no longer available";
    if (op.scope.frame) {
      const frame = design.node(op.scope.frame);
      if (frame?.type !== "frame" || frame.page !== op.scope.page || frame.disabled) return "Select a frame on this page";
    }
  }
  if (op.kind === "vote.cast") {
    if (!vote) return "No such vote";
    const target = design.node(op.layer);
    if (!design.page(vote.scope.page) || target?.page !== vote.scope.page || target.disabled) return "That object is outside this vote";
    if (vote.scope.frame && !target.chain.includes(vote.scope.frame)) return "That object is outside the selected frame";
    if (vote.on === "stickies" && target.type !== "sticky") return "Only stickies can receive votes";
  }
  return null;
}

export function voteDesignForTree(tree: TreeAccess): VoteDesign {
  const pages = tree.pages() ?? [];
  return {
    page: id => pages.length ? pages.some(page => page.id === id) : id === "page-1",
    node: id => {
      const node = tree.node(id);
      if (!node) return;
      const chain = [id, ...tree.ancestors(id, 256)];
      const page = pages.find(p => p.boards.includes(chain.at(-1)!))?.id ?? pages[0]?.id ?? "page-1";
      if (page) return { page, type: node.type, chain, disabled: chain.some(key => tree.node(key)?.props.enabled === false) };
    },
  };
}

export interface VoteTopology { pages: string[]; nodes: [string, VoteTarget][] }
const layerId = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 200;

export function readVoteTopology(input: unknown): VoteTopology | null {
  if (!input || typeof input !== "object") return null;
  const { pages, nodes } = input as VoteTopology;
  if (!Array.isArray(pages) || pages.length > 1000 || pages.some(p => !layerId(p)) || !Array.isArray(nodes) || nodes.length > 20_000) return null;
  const known = new Set(pages), ids = new Set<string>();
  for (const pair of nodes) {
    if (!Array.isArray(pair) || pair.length !== 2) return null;
    const [id, node] = pair;
    if (!layerId(id) || ids.has(id) || !node || !known.has(node.page) || !layerId(node.type) ||
        !Array.isArray(node.chain) || node.chain.length > 256 || node.chain[0] !== id || node.chain.some(key => !layerId(key)) ||
        (node.disabled !== undefined && typeof node.disabled !== "boolean")) return null;
    ids.add(id);
  }
  const byId = new Map(nodes);
  for (const [, node] of nodes) {
    const parent = node.chain[1];
    if (!parent) continue;
    const ancestor = byId.get(parent);
    if (ancestor?.page !== node.page || ancestor.chain.length + 1 !== node.chain.length ||
        !ancestor.chain.every((id, index) => id === node.chain[index + 1]) ||
        (ancestor.disabled && !node.disabled)) return null;
  }
  return { pages: [...known], nodes: nodes.map(([id, { page, type, chain, disabled }]) => [id, { page, type, chain, ...(disabled && { disabled }) }]) };
}

export function voteDesignForTopology(topology: VoteTopology): VoteDesign {
  const pages = new Set(topology.pages), nodes = new Map(topology.nodes);
  return { page: id => pages.has(id), node: id => nodes.get(id) };
}

export type StoredVote = Vote & { anonymousKey?: string };

export function forgetAnonymousBallots(vote: StoredVote) {
  if (!vote.anonymous) return;
  delete vote.anonymousKey;
  delete vote.retracted;
  vote.host = { id: crypto.randomUUID() };
  vote.ballots = vote.ballots.map(({ layer }) => ({ id: crypto.randomUUID(), layer, voter: { id: crypto.randomUUID() } }));
}

const encoder = new TextEncoder();
const fromHex = (hex: string) => Uint8Array.from(hex.match(/../g) ?? [], pair => Number.parseInt(pair, 16));
function anonymousId(key: string, vote: string, id: string) {
  // HMAC-SHA256. A vote key exists only as long as its ballots can be changed.
  const data = encoder.encode(JSON.stringify([vote, id]));
  const secret = fromHex(key), inner = new Uint8Array(64 + data.length).fill(0x36), outer = new Uint8Array(96).fill(0x5c);
  for (let i = 0; i < secret.length; i++) { inner[i] ^= secret[i]; outer[i] ^= secret[i]; }
  inner.set(data, 64);
  outer.set(fromHex(sha256Hex(inner)), 64);
  return sha256Hex(outer);
}

function personKey(key: string | undefined, vote: Pick<Vote, "anonymous" | "id">, person: Author) {
  const id = person.id || person.email || "";
  return vote.anonymous && id && key ? anonymousId(key, vote.id, id) : id;
}

export const CONCLUSION_LEASE_MS = 2 * 60_000;
export const conclusionId = (vote: string) => "vote-conclusion-" + vote;
const needsConclusion = (vote: Vote) => !vote.conclusion && !vote.conclusionConfirmed && !!(vote.timedOut || vote.conclusionPending);

export function updateRoomVote(votes: StoredVote[], key: string | undefined, op: VoteOp, opId: string, me: Author, at: string, design: VoteDesign) {
  const vote = votes.find(v => v.id === op.vote);
  const targetError = validateVoteTarget(design, vote, op);
  if (targetError) return targetError;
  const id = personKey(key, vote ?? { id: op.vote, anonymous: op.kind === "vote.start" && op.anonymous }, me);
  if ((op.kind === "vote.cast" || op.kind === "vote.retract") && vote?.timer?.endsAt && vote.timer.endsAt <= at) return "The vote has ended";
  if (op.kind === "vote.conclusion") {
    if (!vote || vote.conclusion?.opId !== op.claim || vote.conclusion.by !== (me.id || me.email))
      return "The conclusion claim has expired";
    if (design.node(conclusionId(vote.id))?.type !== "frame") return "Save the conclusion card first";
    delete vote.conclusion;
    delete vote.conclusionPending;
    vote.conclusionConfirmed = true;
    return null;
  }
  if (op.kind === "vote.end" && op.expired && !(vote?.timedOut || vote?.conclusionPending)) return "The vote has not expired";
  const active = vote?.state === "active";
  if (op.kind === "vote.clear" && vote?.state === "ended" && (vote.conclusion || vote.timedOut || vote.conclusionPending || vote.conclusionConfirmed))
    vote.clearedTotals = voteTotals(vote);
  const error = applyVote(votes, op, { id, name: me.name, agent: me.agent }, at, true);
  if (!error && op.kind === "vote.end" && vote && (active || needsConclusion(vote))) {
    vote.conclusion = { by: me.id || me.email || "", opId, expiresAt: new Date(Date.parse(at) + CONCLUSION_LEASE_MS).toISOString() };
    if (active) forgetAnonymousBallots(vote);
  }
  return error;
}

export function voteTotals(vote: Vote, ballots = vote.ballots): VoteTotal[] {
  const totals = new Map<string, { count: number; names: Set<string> }>();
  for (const { layer, voter } of ballots) {
    const total = totals.get(layer) ?? { count: 0, names: new Set<string>() };
    total.count++;
    if (!vote.anonymous && voter.name) total.names.add(voter.name);
    totals.set(layer, total);
  }
  return [...totals].map(([layer, { count, names }]) => ({ layer, count, names: [...names] }));
}

export function projectVotes(votes: StoredVote[], legacyKey: string | undefined, person: Author): VoteView[] {
  return votes.flatMap(vote => {
    const { id, scope, on, perPerson, hidden, anonymous, state, timer, conclusion } = vote;
    const mine = personKey(vote.anonymousKey ?? legacyKey, vote, person);
    const conclusionOp = conclusion?.by === (person.id || person.email) ? conclusion?.opId : undefined;
    const unclaimed = needsConclusion(vote);
    if (state === "dismissed" && !conclusionOp && !unclaimed) return [];
    const live = state === "active";
    const ballots = live ? vote.ballots.filter(b => b.voter.id === mine).map(({ id, layer }) => ({ id, layer })) : [];
    const people = new Map<string, { name?: string; count: number }>();
    for (const { voter } of vote.ballots) {
      const p = people.get(voter.id) ?? { count: 0 };
      p.count++;
      p.name ??= voter.name;
      people.set(voter.id, p);
    }
    return [{
      id, scope, on, perPerson, hidden, anonymous, state, timer, timedOut: vote.timedOut, ballots, conclusionOp, needsConclusion: unclaimed,
      ...(live && !anonymous && { progress: [...people].flatMap(([id, p], index) => p.name ? [{ id: id.includes("@") ? `${vote.id}:${index}` : id, name: p.name, done: p.count >= perPerson }] : []) }),
      ...(live && { done: [...people.values()].filter(p => p.count >= perPerson).length }),
      ...(!live && !anonymous && { voters: people.size }),
      ...(!live && { totals: vote.clearedTotals ?? voteTotals(vote) }),
      ...(live && !hidden && !anonymous && { totals: voteTotals(vote, vote.ballots.filter(b => b.voter.id !== mine)) }),
    }];
  });
}
