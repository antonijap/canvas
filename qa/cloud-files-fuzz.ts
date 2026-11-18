// Fuzz run for Cloud files (plan Section 9). `--memory`: 2 to 5 Macs and one file room in this process on the memory
// adapter. Each seed makes random actions on each Mac's view (set, text, insert, remove, move, reorder, group,
// component use, page and board moves, variables, cards, media with uploads, undo style preconditions), steps the
// sockets in random order, drops sockets, flips roles, keeps Macs offline for stretches, crashes Macs before and
// after their commits, crashes the room inside its transactions, builds snapshots and compacts. Then everything is
// delivered and every Mac's confirmed copy is compared with the room's rows, byte for byte.
//
// Run: node qa/cloud-files-fuzz.ts --memory [--seeds 10000] [--from 1] [--steps 80]
// Writes qa/out/cloud-files-metrics.json, and qa/out/cloud-fuzz/<signature>.json per distinct failure.

import { mkdirSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { Sim, seedDocument, FILE, type SimClient } from "./cloud-files-sim.ts";
import { buildSnapshot, compact } from "../cloud/core/files/snapshots.ts";
import { collectGarbage } from "../cloud/core/files/gc.ts";
import { reserveUpload, putUpload, StorageLedger } from "../cloud/core/files/uploads.ts";
import { NodeSqlStore } from "../cloud/core/files/memory.ts";
import { Divergence } from "../cloud/core/files/replica.ts";
import type { MemoryTree } from "../cloud/core/files/tree-memory.ts";
import type { FileOp, Json, DocNode } from "../cloud/core/files/seam.ts";
import type { Role } from "../cloud/core/files/messages.ts";

const args = process.argv.slice(2);
const opt = (name: string, def: number) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? Number(args[i + 1]) : def;
};
if (!args.includes("--memory")) {
  console.error("only --memory is built so far (--servers and --adapter cloudflare come with Phases 3 and 5)");
  process.exit(2);
}
const SEEDS = opt("seeds", 10_000), FROM = opt("from", 1), STEPS = opt("steps", 80);
const OUT = (() => {
  const i = args.indexOf("--out");
  return i >= 0 ? args[i + 1] : "qa/out/cloud-files-metrics.json";
})();

function prng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const PEOPLE = ["anna", "ben", "cleo", "dan", "eve"].map((p) => ({ id: `${p}@studio.test`, name: p[0].toUpperCase() + p.slice(1) }));
const COLORS = ["#ff0000", "#00ff00", "#0000ff", "#222222", "#abcdef"];
const IMAGES = [0, 1, 2].map((i) => {
  const b = new Uint8Array(64);
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  b[20] = i;
  return { bytes: b, sha: createHash("sha256").update(b).digest("hex"), path: `media/img${i}.png` as const };
});

type Metrics = {
  seeds: number; divergence: number; lost: number; doubles: number; errors: number; actions: number; applied: number;
  rejects: Record<string, number>; samples: Record<string, string>; reasons: Record<string, number>; localRejects: number; serverCrashes: number; clientCrashes: number; snapshots: number; snapshotWelcomes: number;
  rowsWritten: number; ms: number; failures: string[];
};

function liveNodes(v: MemoryTree): { id: string; type: string; parent: string | null; props: Record<string, Json> }[] {
  const out: { id: string; type: string; parent: string | null; props: Record<string, Json> }[] = [];
  const walk = (p: string | null) => {
    for (const id of v.children(p)) {
      const n = v.node(id)!;
      out.push({ id, type: n.type, parent: p, props: n.props });
      if (n.type === "frame" || n.type === "group") walk(id);
    }
  };
  walk(null);
  return out;
}

class Gen {
  private r: () => number;
  private n = 0;
  constructor(r: () => number) {
    this.r = r;
  }
  int(n: number) {
    return Math.floor(this.r() * n);
  }
  pick<T>(xs: readonly T[]): T | undefined {
    return xs.length ? xs[this.int(xs.length)] : undefined;
  }
  chance(p: number) {
    return this.r() < p;
  }
  id(c: SimClient) {
    return `${c.replica.author.id.split("@")[0]}-${this.n++}`;
  }
  subtree(c: SimClient, components: string[]): DocNode {
    const k = this.int(6);
    if (k === 0) return { id: this.id(c), type: "text", content: this.pick(["One", "Two words", "Three more words"])!, x: this.int(100) };
    if (k === 1 && components.length) return { id: this.id(c), type: "ref", ref: this.pick(components)!, x: this.int(100) };
    if (k === 2) return { id: this.id(c), type: "frame", name: "Comp", reusable: true, width: 50, height: 50, children: [{ id: this.id(c), type: "rectangle", width: 10, height: 10 }] };
    if (k === 3) return { id: this.id(c), type: "group", children: [{ id: this.id(c), type: "ellipse", width: 5, height: 5 }, { id: this.id(c), type: "text", content: "In a group" }] };
    return { id: this.id(c), type: "rectangle", width: 10 + this.int(90), height: 10 + this.int(90), fill: this.pick(COLORS)! };
  }

  /** One random action on what `c` sees. */
  action(c: SimClient, v: MemoryTree): FileOp[] {
    const nodes = liveNodes(v);
    const containers = nodes.filter((n) => n.type === "frame" || n.type === "group");
    const components = nodes.filter((n) => n.props.reusable === true).map((n) => n.id);
    const any = () => this.pick(nodes);
    const afterIn = (parent: string | null, not?: string) => (this.chance(0.3) ? null : this.pick(v.children(parent).filter((x) => x !== not)) ?? null);
    const k = this.int(100);
    if (k < 28) {
      const n = any();
      if (!n) return [];
      const key = this.pick(n.type === "group" ? ["name", "opacity"] : n.type === "ref" ? ["x", "y", "name", "descendants"] : n.type === "text" ? ["x", "y", "name", "content", "opacity"] : ["x", "y", "width", "height", "opacity", "fill", "name"])!;
      const props: Record<string, { v: Json } | null> = {};
      if (key === "descendants") {
        const comp = v.subtree(n.props.ref as string);
        const inner = comp && Array.isArray(comp.children) ? this.pick(comp.children.map((x) => x.id as string)) : undefined;
        if (!inner) return [];
        props[`descendants/${inner}`] = this.chance(0.2) ? null : { v: { fill: this.pick(COLORS)! } };
      } else if (key === "fill") props.fill = { v: this.pick(COLORS)! };
      else if (key === "name") props.name = this.chance(0.2) ? null : { v: `Layer ${this.int(9)}` };
      else if (key === "content") props.content = { v: this.pick(["Hi", "Hello there", "A longer sentence of text"])! };
      else if (key === "opacity") props.opacity = { v: this.int(11) / 10 };
      else props[key] = { v: this.int(500) };
      const op: FileOp = { k: "set", id: n.id, props };
      if (this.chance(0.2) && !key.startsWith("desc")) op.if = { [key]: v.ver(`n:${n.id}:${key}`) };
      return [op];
    }
    if (k < 40) {
      const t = this.pick(nodes.filter((n) => n.type === "text" && c.replica.canType(n.id, v)));
      if (!t) return [];
      const s = t.props.content as string;
      const from = this.int(s.length + 1), del = this.int(Math.min(4, s.length - from) + 1);
      return [{ k: "text", id: t.id, baseSeq: 0, from, del, ins: this.pick(["", "x", "yz", " new "])! }];
    }
    if (k < 54) {
      const parent = this.chance(0.2) ? null : this.pick(containers)?.id ?? null;
      return [{ k: "insert", parent, after: afterIn(parent), node: this.subtree(c, components) }];
    }
    if (k < 62) {
      const n = any();
      if (!n) return [];
      return [{ k: "remove", id: n.id, ...(this.chance(0.2) ? { if: v.ver(`t:${n.id}`) } : {}) }];
    }
    if (k < 72) {
      const n = any();
      if (!n) return [];
      const parent = this.chance(0.5) ? n.parent : this.chance(0.2) ? null : this.pick(containers)?.id ?? null;
      return [{ k: "move", id: n.id, parent, after: afterIn(parent, n.id) }];
    }
    if (k < 76) {
      // Group two siblings: insert a group, move both in.
      const p = this.pick(containers);
      const kids = p ? v.children(p.id) : [];
      if (kids.length < 2) return [];
      const g = this.id(c);
      return [{ k: "insert", parent: p!.id, after: kids[0], node: { id: g, type: "group", children: [] } }, { k: "move", id: kids[0], parent: g, after: null }, { k: "move", id: kids[1], parent: g, after: kids[0] }];
    }
    if (k < 80) return [{ k: "doc", key: `variables/v${this.int(3)}`, value: this.chance(0.2) ? null : { v: { type: "number", value: this.int(100) } } }];
    if (k < 85) {
      const id = `w${this.int(4)}`;
      const ids = v.widgetIds();
      return [{ k: "widget", id, value: this.chance(0.2) ? null : { v: { id, kind: "note", config: { text: `n${this.int(9)}` } } }, ...(this.chance(0.5) ? {} : { after: this.pick(ids.filter((x) => x !== id)) ?? null }) }] as FileOp[];
    }
    if (k < 90) {
      const pages = v.pages() ?? [];
      if (this.chance(0.5)) {
        const id = `p${this.int(3)}`;
        return [{ k: "page", id, value: this.chance(0.25) ? null : { v: { name: `Page ${this.int(9)}` } } }];
      }
      const board = this.pick(v.children(null));
      const page = this.pick(pages);
      if (!board || !page) return [];
      return [{ k: "pageOf", board, page: page.id }];
    }
    if (k < 95) {
      const img = this.pick(IMAGES)!;
      const n = this.pick(nodes.filter((x) => x.type === "rectangle" || x.type === "frame"));
      if (!n) return [];
      return [{ k: "blob", path: img.path, sha256: img.sha, bytes: img.bytes.length, type: "image/png" }, { k: "set", id: n.id, props: { fill: { v: { type: "image", url: img.path, mode: "fill" } } } }];
    }
    if (k < 97) return [{ k: "meta", key: "brief", value: { v: `Brief ${this.int(9)}` } }];
    // Reorder within the same parent, then undo style: set back with a precondition.
    const n = any();
    if (!n) return [];
    return [{ k: "move", id: n.id, parent: n.parent, after: afterIn(n.parent, n.id) }, { k: "set", id: n.id, props: { x: { v: this.int(50) } }, if: { x: v.ver(`n:${n.id}:x`) } }];
  }
}

let uploads = 0;
/** Before a Mac adds an image: its bytes are uploaded, unless the file or a live upload holds them (uploads expire). */
async function ensureUpload(sim: Sim, ledger: StorageLedger, sha: string): Promise<void> {
  const have = sim.store.sql.exec("SELECT 1 FROM blobs WHERE sha256 = ? UNION SELECT 1 FROM uploads WHERE sha256 = ? AND state IN ('stored', 'used')", sha, sha).toArray().length;
  if (have) return;
  const img = IMAGES.find((x) => x.sha === sha)!;
  const id = `up-fuzz-${String(++uploads).padStart(6, "0")}`;
  reserveUpload(sim.room, ledger, { author: PEOPLE[0], role: "owner" }, { id, sha256: sha, bytes: img.bytes.length, type: "image/png" });
  await putUpload(sim.room, ledger, id, img.bytes);
}

async function runSeed(seed: number, m: Metrics): Promise<void> {
  const r = prng(seed);
  const g = new Gen(r);
  let faults = 0;
  const faultRate = g.chance(0.5) ? 0 : 0.02;
  let clock = Date.parse("2026-11-01T00:00:00Z");
  const sim = new Sim({ now: () => clock, fault: () => { if (r() < faultRate) { faults++; throw new Error("crash: room killed in its transaction"); } } });
  await sim.init();
  const ledger = new StorageLedger(new NodeSqlStore(), 1e9);
  IMAGES.forEach((img, i) => reserveUpload(sim.room, ledger, { author: PEOPLE[0], role: "owner" }, { id: `up-seed-${i}`, sha256: img.sha, bytes: img.bytes.length, type: "image/png" }));
  for (const [i, img] of IMAGES.entries()) await putUpload(sim.room, ledger, `up-seed-${i}`, img.bytes);
  const count = 2 + g.int(4);
  const cs: SimClient[] = [];
  for (let i = 0; i < count; i++) cs.push(await sim.addClient(PEOPLE[i]));
  for (const c of cs) sim.connect(c);
  await sim.quiesce();
  const offline = new Map<SimClient, number>();
  let clientCrashes = 0, snaps = 0;
  try {
    for (let step = 0; step < STEPS; step++) {
      const c = g.pick(cs)!;
      // Time passes: mostly seconds, sometimes days, so versions, the log and receipts age out mid run.
      clock += g.chance(0.06) ? (1 + g.int(6)) * 86_400_000 : 1000 * (1 + g.int(120));
      const e = g.int(100);
      if (e < 40) {
        const ops = g.action(c, c.replica.view());
        if (ops.length) {
          for (const op of ops) if (op.k === "blob") await ensureUpload(sim, ledger, op.sha256);
          sim.propose(c, ops);
        }
      } else if (e < 58) {
        if (c.socket && c.replica.needHello) {
          sim.drop(c);
          sim.connect(c);
        }
        sim.flush(c);
        for (let i = g.int(3); i >= 0; i--) sim.serverStep(c);
      } else if (e < 80) {
        for (let i = g.int(3); i >= 0; i--) await sim.clientStep(c, g.chance(0.03));
      } else if (e < 84) {
        sim.drop(c);
        offline.set(c, step + g.int(15));
      } else if (e < 88) {
        for (const [x, until] of offline) if (until <= step) {
          offline.delete(x);
          if (!x.socket) sim.connect(x);
        }
        if (!c.socket && !offline.has(c)) sim.connect(c);
      } else if (e < 90) {
        sim.crashClient(c);
        clientCrashes++;
      } else if (e < 91) {
        sim.crashServer();
      } else if (e < 94) {
        c.conn.role = (g.pick(["editor", "editor", "viewer", "commenter", "owner"]) as Role);
      } else if (e < 97) {
        await buildSnapshot(sim.room);
        snaps++;
        if (g.chance(0.5)) compact(sim.room);
        if (g.chance(0.3)) await collectGarbage(sim.room, ledger);
      } else {
        // Everyone in flight at once: drain every socket in a random order.
        for (const x of [...cs].sort(() => r() - 0.5)) {
          sim.flush(x);
          while (sim.serverStep(x));
        }
      }
    }
    for (const c of cs) c.conn.role = "editor";
    await sim.quiesce(400);
    const div = sim.divergences(), lost = sim.lost(), dbl = sim.doubles();
    // Also a Mac that opens the file fresh from the last snapshot plus the tail matches.
    await buildSnapshot(sim.room);
    const late = await sim.addClient({ id: "late@studio.test", name: "Late" });
    sim.connect(late);
    await sim.quiesce();
    div.push(...sim.divergences().filter((d) => d.startsWith("late@")));
    if (div.length) record(m, seed, "divergence", div[0]);
    if (lost.length) record(m, seed, "lost", lost[0]);
    if (dbl.length) record(m, seed, "double", dbl[0]);
    m.divergence += div.length ? 1 : 0;
    m.lost += lost.length;
    m.doubles += dbl.length;
  } catch (e) {
    const kind = e instanceof Divergence ? "divergence" : "error";
    if (kind === "divergence") m.divergence++;
    else m.errors++;
    record(m, seed, kind, (e as Error).stack ?? String(e));
  }
  for (const c of sim.clients) {
    m.actions += c.made.size;
    m.localRejects += c.localRejects;
    for (const x of c.replica.refused) {
      m.rejects[x.code] = (m.rejects[x.code] ?? 0) + 1;
      if (!m.samples[x.code]) m.samples[x.code] = x.message;
      const why = `${x.code}: ${x.message.replace(/"[^"]*"/g, "\"…\"").replace(/\d+/g, "#")}`;
      m.reasons[why] = (m.reasons[why] ?? 0) + 1;
    }
  }
  m.applied += new Set(sim.log.map((a) => a.id)).size;
  m.serverCrashes += sim.serverCrashes;
  m.clientCrashes += clientCrashes;
  m.snapshots += snaps;
  m.snapshotWelcomes += sim.snapshotWelcomes;
  m.rowsWritten += sim.rowsWritten;
  void faults;
}

const seen = new Set<string>();
function record(m: Metrics, seed: number, kind: string, detail: string) {
  const sig = createHash("sha256").update(`${kind}:${detail.split("\n")[0].replace(/[0-9a-f]{8,}|\d+/g, "#")}`).digest("hex").slice(0, 12);
  m.failures.push(`${kind} seed ${seed}: ${detail.split("\n")[0]}`);
  if (seen.has(sig)) return;
  seen.add(sig);
  mkdirSync("qa/out/cloud-fuzz", { recursive: true });
  writeFileSync(`qa/out/cloud-fuzz/${sig}.json`, JSON.stringify({ kind, seed, steps: STEPS, detail, rerun: `node qa/cloud-files-fuzz.ts --memory --from ${seed} --seeds 1 --steps ${STEPS}` }, null, 2));
}

const m: Metrics = { seeds: 0, divergence: 0, lost: 0, doubles: 0, errors: 0, actions: 0, applied: 0, rejects: {}, samples: {}, reasons: {}, localRejects: 0, serverCrashes: 0, clientCrashes: 0, snapshots: 0, snapshotWelcomes: 0, rowsWritten: 0, ms: 0, failures: [] };
const t0 = Date.now();
void FILE;
void seedDocument;
for (let s = FROM; s < FROM + SEEDS; s++) {
  await runSeed(s, m);
  m.seeds++;
  if (m.seeds % 250 === 0) console.log(`${m.seeds} seeds, divergence ${m.divergence}, lost ${m.lost}, doubles ${m.doubles}, errors ${m.errors}, ${Math.round((Date.now() - t0) / 1000)} s`);
}
m.ms = Date.now() - t0;
mkdirSync("qa/out", { recursive: true });
writeFileSync(OUT, JSON.stringify({ ...m, failures: m.failures.slice(0, 50), rowsPerAction: m.applied ? +(m.rowsWritten / m.applied).toFixed(1) : 0 }, null, 2));
console.log(JSON.stringify({ seeds: m.seeds, divergence: m.divergence, lost: m.lost, doubles: m.doubles, errors: m.errors, actions: m.actions, applied: m.applied, rejects: m.rejects, samples: m.samples, localRejects: m.localRejects, serverCrashes: m.serverCrashes, clientCrashes: m.clientCrashes, snapshots: m.snapshots, snapshotWelcomes: m.snapshotWelcomes, seconds: Math.round(m.ms / 1000) }));
for (const [why, count] of Object.entries(m.reasons).sort((a, b) => b[1] - a[1]).slice(0, 25)) console.log(`${String(count).padStart(6)}  ${why}`);
for (const f of m.failures.slice(0, 10)) console.log(f);
process.exit(m.divergence || m.lost || m.doubles || m.errors ? 1 : 0);
