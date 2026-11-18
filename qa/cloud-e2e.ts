// End to end for comments sync through a team's own Canvas server, with the real server (cloud/cloudflare) run
// locally in DEV mode. Two Canvas servers with their own scratch state, one per person:
//   anna (owner) shares a file; ben (commenter) opens a copy; a comment of ben's reaches anna's comments.json;
//   anna goes offline (her connection to the server is cut), comments, the comment waits, then arrives when she is back;
//   ben is removed from the people rules and is disconnected.
// Run: node qa/cloud-e2e.ts      (cleans up after itself; needs `pnpm install --frozen-lockfile` in cloud/cloudflare)
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { freePort, ROOT, sleep, startServer, type Scratch } from "./lib.ts";
import { shareLocal } from "../src/cloud-sync.ts";

const SERVER = path.join(ROOT, "cloud", "cloudflare");
const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "canvas-cloud-e2e-")));
let failed = 0;
const line = (ok: boolean, what: string) => { console.log(`${ok ? "PASS" : "FAIL"} ${what}`); if (!ok) failed++; };
const until = async (what: string, ok: () => boolean | Promise<boolean>, ms = 8000) => {
  const t0 = Date.now();
  for (;;) {
    if (await ok()) return Date.now() - t0;
    if (Date.now() - t0 > ms) throw new Error(`timed out (${ms} ms) waiting for ${what}`);
    await sleep(40);
  }
};

const DOC = {
  version: "2.21",
  children: [{ type: "frame", id: "Scr01", name: "Screen", x: 0, y: 0, width: 390, height: 844, children: [{ type: "text", id: "Ttl01", name: "Title", content: "Hi", fontSize: 20 }] }],
};
const uuid = () => crypto.randomUUID();
const anchor = { nodeId: "Ttl01", x: 0.25, y: 0.5, board: "Scr01", preview: { name: "Title", type: "text" } };

/** A TCP relay in front of the team server: closing it is "anna lost her connection". */
function relay(target: number, port: number) {
  let srv: net.Server | null = null;
  const socks = new Set<net.Socket>();
  const open = () => new Promise<void>((res) => {
    srv = net.createServer((c) => {
      const up = net.connect(target, "127.0.0.1");
      socks.add(c); socks.add(up);
      c.pipe(up); up.pipe(c);
      const end = () => { c.destroy(); up.destroy(); socks.delete(c); socks.delete(up); };
      c.on("error", end); up.on("error", end); c.on("close", end); up.on("close", end);
    });
    srv.listen(port, "127.0.0.1", () => res());
  });
  const cut = async () => { for (const s of socks) s.destroy(); socks.clear(); await new Promise<void>((r) => (srv ? srv.close(() => r()) : r())); srv = null; };
  return { open, cut };
}

const procs: ChildProcess[] = [];
const scratch: Scratch[] = [];
async function cleanup() {
  for (const s of scratch) await s.stop().catch(() => {});
  for (const p of procs) { try { if (p.pid) process.kill(-p.pid, "SIGTERM"); } catch { /* gone */ } }
  await sleep(300);
  for (const p of procs) { try { if (p.pid) process.kill(-p.pid, "SIGKILL"); } catch { /* gone */ } }
  fs.rmSync(tmp, { recursive: true, force: true });
}

async function main() {
  if (!fs.existsSync(path.join(SERVER, "node_modules"))) throw new Error("run `pnpm install --frozen-lockfile` in cloud/cloudflare first");
  // 1. the team server, locally, in DEV mode (the dev email header stands in for Cloudflare Access)
  const wport = await freePort();
  const wlog: string[] = [];
  const w = spawn("pnpm", ["exec", "wrangler", "dev", "--local", "--ip", "127.0.0.1", "--port", String(wport), "--persist-to", path.join(tmp, "wrangler-state"), "--var", "DEV:1", "--var", "OWNER_EMAILS:anna@studio.test"], {
    cwd: SERVER, detached: true, stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, WRANGLER_LOG_PATH: path.join(tmp, "wrangler-logs"), WRANGLER_SEND_METRICS: "false", CI: "1", NO_COLOR: "1" },
  });
  procs.push(w);
  w.stdout!.on("data", (d) => wlog.push(String(d)));
  w.stderr!.on("data", (d) => wlog.push(String(d)));
  const direct = `http://127.0.0.1:${wport}`;
  const dev = (email: string) => ({ "x-canvas-dev-email": email });
  await until("the team server", async () => { try { return (await fetch(`${direct}/v1/info`, { headers: dev("anna@studio.test") })).ok; } catch { return false; } }, 90_000)
    .catch((e) => { console.log(wlog.join("").slice(-1500)); throw e; });
  line(true, `team server answers on ${direct}`);

  // 2. anna adds ben as a commenter
  const put = await fetch(`${direct}/v1/people`, { method: "PUT", headers: { ...dev("anna@studio.test"), "content-type": "application/json" }, body: JSON.stringify([{ match: "ben@studio.test", role: "commenter" }]) });
  line(put.ok, "anna (owner) made ben a commenter through PUT /v1/people");

  // 3. Local threads, a deleted reply and a deleted thread, made before sharing. Keep a copy from before deletion.
  const proxyPort = await freePort();
  const annaRelay = relay(wport, proxyPort);
  await annaRelay.open();
  const annaUrl = `http://127.0.0.1:${proxyPort}`;
  const dirA = path.join(tmp, "anna"), dirB = path.join(tmp, "ben");
  fs.mkdirSync(dirA, { recursive: true }); fs.mkdirSync(dirB, { recursive: true });
  const pkgA = path.join(dirA, "design.canvas");
  fs.mkdirSync(pkgA);
  fs.writeFileSync(path.join(pkgA, "document.json"), JSON.stringify(DOC));
  const sa = await startServer(dirA, { CANVAS_CLOUD_URL: annaUrl, CANVAS_CLOUD_DEV_EMAIL: "anna@studio.test", CANVAS_COMMENT_NAME: "Anna" });
  scratch.push(sa);
  const post = async (s: Scratch, p: string, body: unknown, file: string) => {
    const r = await fetch(`${s.base}${p}${p.includes("?") ? "&" : "?"}file=${encodeURIComponent(file)}`, { method: "POST", headers: { "x-canvas": "1", "content-type": "application/json" }, body: JSON.stringify(Array.isArray(body) ? { ops: body } : body) });
    return { status: r.status, j: (await r.json()) as any };
  };
  const get = async (s: Scratch, file: string) => (await (await fetch(`${s.base}/api/comments?file=${encodeURIComponent(file)}`)).json()) as any;
  const NIL = "00000000-0000-4000-8000-000000000000";
  const op = (o: unknown) => ({ opId: uuid(), doc: NIL, at: new Date().toISOString(), op: o });
  const t1 = uuid(), c1 = uuid(), c2 = uuid(), t2 = uuid(), c3 = uuid(), c4 = uuid(), t3 = uuid(), c5 = uuid(), c6 = uuid();
  const fileA = pkgA;
  const first = await post(sa, "/api/comments/ops", [
    op({ kind: "thread.create", thread: t1, anchor, comment: c1, body: "First, before any server" }),
    op({ kind: "comment.add", thread: t1, comment: c2, body: "A reply" }),
    op({ kind: "thread.create", thread: t2, anchor, comment: c3, body: "Resolved one" }),
    op({ kind: "thread.resolve", thread: t2, resolved: true }),
    op({ kind: "comment.add", thread: t2, comment: c4, body: "Deleted reply" }),
    op({ kind: "thread.create", thread: t3, anchor, comment: c5, body: "Thread before deletion" }),
    op({ kind: "comment.add", thread: t3, comment: c6, body: "Reply before deletion" }),
  ], fileA);
  if (first.status !== 200 || first.j.rejected?.length) console.log(JSON.stringify(first));
  const diskA = () => JSON.parse(fs.readFileSync(path.join(pkgA, "comments.json"), "utf8"));
  const oldCopy = diskA();
  await post(sa, "/api/comments/ops", [op({ kind: "comment.delete", comment: c4 }), op({ kind: "thread.delete", thread: t3 })], fileA);
  line(diskA().threads.length === 3 && !diskA().server, "anna's file has 3 local threads, including tombstones, and no server");

  // 4. anna signs in (dev header) and shares the file
  const st = (await (await fetch(`${sa.base}/api/cloud/status?url=${encodeURIComponent(annaUrl)}`)).json()) as any;
  line(st.status === "connected" && st.email === "anna@studio.test" && st.role === "owner", `status says connected as ${st.email}, ${st.role}`);
  const shared = await post(sa, "/api/cloud/share", {}, fileA);
  line(shared.status === 200 && shared.j.ops === 9, `share sent ${shared.j.ops} ops, including the deleted reply and thread`);
  await until("the outbox to empty", () => diskA().outbox.length === 0 && diskA().seq >= 9);
  const da = diskA();
  line(da.server.url === annaUrl && da.seq === 9, `comments.json has server.url and seq ${da.seq}`);
  line(da.threads.map((t: any) => t.id).sort().join() === [t1, t2, t3].sort().join(), "the same thread ids are on the server");
  line(da.threads.find((t: any) => t.id === t1).comments.map((c: any) => c.id).join() === [c1, c2].join(), "the same comment ids too");
  line(da.threads.find((t: any) => t.id === t1).anchor.nodeId === "Ttl01" && !!da.threads.find((t: any) => t.id === t2).resolvedAt, "anchors and the resolved state came across");
  line(da.threads[0].comments[0].author.email === "anna@studio.test", "the server's author (anna@studio.test) is on the comments");
  const tombstones = (f: any) => {
    const reply = f.threads.find((t: any) => t.id === t2)?.comments.find((c: any) => c.id === c4);
    const thread = f.threads.find((t: any) => t.id === t3);
    return !!reply?.deletedAt && reply.body === "" && !!thread?.deletedAt
      && thread.comments.length === 2 && thread.comments.every((c: any) => !!c.deletedAt && c.body === "");
  };
  line(tombstones(da), "confirmed comments.json keeps the deleted reply and every comment of the deleted thread");
  const history = await (await fetch(`${direct}/v1/docs/${da.doc}/threads?since=1`, { headers: dev("anna@studio.test") })).json() as any;
  line(history.entries?.some((e: any) => e.op.kind === "comment.delete" && e.op.comment === c4)
    && history.entries?.some((e: any) => e.op.kind === "thread.delete" && e.op.thread === t3), "server history contains the shared comment.delete and thread.delete ops");

  // 5. ben opens a copy (the same document, as a sync folder would give him) and points it at the server directly
  const pkgB = path.join(dirB, "design.canvas");
  fs.cpSync(pkgA, pkgB, { recursive: true });
  const cb = shareLocal(oldCopy, direct, { email: "ben@studio.test", name: "Ben" });
  fs.writeFileSync(path.join(pkgB, "comments.json"), JSON.stringify(cb));
  const sb = await startServer(dirB, { CANVAS_CLOUD_URL: direct, CANVAS_CLOUD_DEV_EMAIL: "ben@studio.test", CANVAS_COMMENT_NAME: "Ben" });
  scratch.push(sb);
  const diskB = () => JSON.parse(fs.readFileSync(path.join(pkgB, "comments.json"), "utf8"));
  await get(sb, pkgB); // opening the file's comments connects it
  await until("ben connected", async () => (await get(sb, pkgB)).sync?.status === "connected");
  line(true, "ben's copy connected to the same document");
  await until("the old copy's outbox to empty", () => diskB().outbox.length === 0);
  line(tombstones(diskB()) && tombstones(diskA()), "syncing an old comments.json cannot resurrect the deleted reply or thread");
  line(diskB().rejected?.some((r: any) => r.code === "conflict" && r.envelope.op.comment === c4)
    && diskB().rejected?.some((r: any) => r.code === "conflict" && r.envelope.op.thread === t3), "the server refuses old creates and replies that reuse deleted ids");

  // 6. ben comments; it is in anna's comments.json within a second
  const bt = uuid(), bc = uuid();
  const t0 = Date.now();
  const r = await post(sb, "/api/comments/ops", [op({ kind: "thread.create", thread: bt, anchor, comment: bc, body: "From Ben" })], pkgB);
  line(r.j.sync?.pending?.length === 1 || r.j.sync?.pending?.length === 0, "ben's comment shows at once (pending or already sent)");
  await until("ben's comment on anna's disk", () => diskA().threads.some((t: any) => t.id === bt), 1000);
  const ms = Date.now() - t0;
  const ac = diskA().threads.find((t: any) => t.id === bt).comments[0];
  line(ms <= 1000 && ac.author.email === "ben@studio.test", `ben's comment reached anna's comments.json in ${ms} ms, authored by ${ac.author.email}`);
  await until("ben's outbox empty", () => diskB().outbox.length === 0);
  line(true, "ben's outbox emptied after the ack");

  // 7. anna offline: her connection is cut; she comments; it waits; she is back; ben gets it
  await annaRelay.cut();
  await until("anna offline", async () => (await get(sa, fileA)).sync?.status !== "connected", 8000);
  const offlineStatus = (await get(sa, fileA)).sync.status;
  const at = uuid(), ac1 = uuid();
  const o = await post(sa, "/api/comments/ops", [op({ kind: "thread.create", thread: at, anchor, comment: ac1, body: "Written offline" })], fileA);
  const g = await get(sa, fileA);
  line(offlineStatus === "offline" && g.threads.some((t: any) => t.id === at) && g.sync.pending.some((p: any) => p.comment === ac1), `offline (${offlineStatus}): anna's comment is shown and pending`);
  line(diskA().outbox.length === 1 && !diskA().threads.some((t: any) => t.id === at), "it sits in the outbox, not in the confirmed threads");
  await sleep(1200);
  line(!diskB().threads.some((t: any) => t.id === at), "ben has not got it yet");
  await annaRelay.open();
  const back = await until("ben gets anna's offline comment", () => diskB().threads.some((t: any) => t.id === at), 20_000);
  line(true, `anna reconnected and ben got it ${back} ms after the connection came back`);
  await until("anna's outbox empty", () => diskA().outbox.length === 0);
  line(diskA().seq === diskB().seq, `both files are at seq ${diskA().seq}`);

  // 8. ben is removed from the rules: his socket is closed and he cannot send
  const del = await fetch(`${direct}/v1/people`, { method: "PUT", headers: { ...dev("anna@studio.test"), "content-type": "application/json" }, body: JSON.stringify([]) });
  line(del.ok, "anna removed ben from the people rules");
  const gone = await until("ben disconnected", async () => (await get(sb, pkgB)).sync?.status !== "connected", 10_000);
  const bs = (await get(sb, pkgB)).sync.status;
  line(bs === "forbidden", `ben is disconnected ${gone} ms after the change (status ${bs})`);
  const after = uuid();
  await post(sb, "/api/comments/ops", [op({ kind: "thread.create", thread: after, anchor, comment: uuid(), body: "After removal" })], pkgB);
  await sleep(1500);
  line(!diskA().threads.some((t: any) => t.id === after) && diskB().outbox.length === 1, "his later comment stays in his outbox and never reaches anna");
}

try {
  await main();
} catch (e) {
  console.log(`FAIL ${(e as Error).message}`);
  failed++;
} finally {
  await cleanup();
}
console.log(failed ? `${failed} check(s) failed` : "all checks passed");
process.exit(failed ? 1 : 0);
