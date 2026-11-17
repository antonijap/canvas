// End to end for a Cloud hosted on a Mac (docs/cloud/hosting.md): two Canvas servers, Anna's hosting and Ben's
// joining, with the fake tunnel helper (test/fixtures/fake-tunnel.ts) standing in for the real one, so it runs
// anywhere with no network. The real tunnel is checked by hand (docs/cloud/hosting.md, "Checking the real tunnel").
//   Anna turns on hosting; her own Canvas is connected as owner on loopback.
//   She invites Ben; Ben joins with the link; the same link is dead after that.
//   Anna shares a file; Ben's comment reaches her comments.json in under a second.
//   Anna's Cloud stops answering (its process paused, as a Mac asleep): Ben reads "down", his comment waits in the
//   outbox, and arrives when the Cloud is back.
//   Anna removes Ben: his socket closes and he reads "removed".
//   The editor port is 127.0.0.1 only; the Cloud port serves no editor route; nothing is left running at the end.
// Run: node qa/cloud-hosted-e2e.ts
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { ROOT, sleep, startServer, type Scratch } from "./lib.ts";
import { shareLocal } from "../src/cloud-sync.ts";

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "canvas-cloud-hosted-")));
const fakeDir = path.join(tmp, "tunnels");
fs.mkdirSync(fakeDir);
let failed = 0;
const line = (ok: boolean, what: string) => { console.log(`${ok ? "PASS" : "FAIL"} ${what}`); if (!ok) failed++; };
const until = async (what: string, ok: () => boolean | Promise<boolean>, ms = 8000) => {
  const t0 = Date.now();
  for (;;) {
    if (await ok()) return Date.now() - t0;
    if (Date.now() - t0 > ms) throw new Error(`timed out (${ms} ms) waiting for ${what}`);
    await sleep(50);
  }
};
const pgrep = (pattern: string) => { try { return execFileSync("pgrep", ["-f", pattern], { encoding: "utf8" }).trim().split("\n").filter(Boolean); } catch { return []; } };
const DOC = { version: "2.21", children: [{ type: "frame", id: "Scr01", name: "Screen", x: 0, y: 0, width: 390, height: 844, children: [{ type: "text", id: "Ttl01", name: "Title", content: "Hi", fontSize: 20 }] }] };
const anchor = { nodeId: "Ttl01", x: 0.25, y: 0.5, board: "Scr01" };
const NIL = "00000000-0000-4000-8000-000000000000";
const op = (o: unknown) => ({ opId: crypto.randomUUID(), doc: NIL, at: new Date().toISOString(), op: o });
const env = (who: string): Record<string, string> => ({
  CANVAS_TUNNEL_BIN: path.join(ROOT, "test", "fixtures", "fake-tunnel.sh"),
  CANVAS_FAKE_TUNNEL_DIR: fakeDir,
  CANVAS_FAKE_TUNNEL_NODE: process.execPath,
  CANVAS_FAKE_TUNNEL_ANY_PORT: "1",
  CANVAS_CLOUD_HOST_PORT: "0",
  CANVAS_CLOUD_SECRETS_FILE: path.join(tmp, `${who}-secrets.json`),
  CANVAS_CLOUD_WATCH_MS: "1000",
  CANVAS_COMMENT_NAME: who,
});
const scratch: Scratch[] = [];
let paused: string[] = [];

async function main() {
  const dirA = path.join(tmp, "anna"), dirB = path.join(tmp, "ben");
  fs.mkdirSync(dirA); fs.mkdirSync(dirB);
  const pkgA = path.join(dirA, "design.canvas");
  fs.mkdirSync(pkgA);
  fs.writeFileSync(path.join(pkgA, "document.json"), JSON.stringify(DOC));
  const sa = await startServer(dirA, env("Anna"));
  const sb = await startServer(dirB, env("Ben"));
  scratch.push(sa, sb);
  const call = async (s: Scratch, p: string, body: unknown = {}) => {
    const r = await fetch(s.base + p, { method: "POST", headers: { "x-canvas": "1", "content-type": "application/json" }, body: JSON.stringify(body) });
    return { status: r.status, j: (await r.json()) as any };
  };
  const status = async (s: Scratch) => (await (await fetch(`${s.base}/api/cloud/status?fresh=1`)).json()) as any;
  const comments = async (s: Scratch, file: string) => (await (await fetch(`${s.base}/api/comments?file=${encodeURIComponent(file)}`)).json()) as any;
  const postOps = (s: Scratch, file: string, ops: unknown[]) => call(s, `/api/comments/ops?file=${encodeURIComponent(file)}`, { ops });

  // 1. Anna hosts.
  const started = await call(sa, "/api/cloud/host/start", { name: "Studio Cloud", label: "Anna" });
  line(started.status === 200 && started.j.hosting && started.j.tunnel === "up", `hosting is on, tunnel ${started.j.tunnel}`);
  const cloudPort = started.j.port;
  const stA = await status(sa);
  line(stA.status === "connected" && stA.role === "owner" && stA.hosted, `Anna's own Canvas is connected to her Cloud as ${stA.role}`);

  // 2. Isolation: the editor port is loopback only; the Cloud port has no editor routes.
  const lan = Object.values(os.networkInterfaces()).flat().find((i) => i && i.family === "IPv4" && !i.internal)?.address;
  if (lan) {
    const reached = await new Promise<boolean>((r) => { const c = net.connect(sa.port, lan); c.on("connect", () => { c.destroy(); r(true); }); c.on("error", () => r(false)); });
    line(!reached, `the editor port is not reachable on ${"the Mac's network address"}`);
    const cloudLan = await new Promise<boolean>((r) => { const c = net.connect(cloudPort, lan); c.on("connect", () => { c.destroy(); r(true); }); c.on("error", () => r(false)); });
    line(!cloudLan, "the Cloud port is not reachable on the Mac's network address either");
  }
  const editorThroughCloud = await Promise.all(["/api/state", "/api/comments", "/mcp", "/", "/api/cloud/host"].map(async (p) => (await fetch(`http://127.0.0.1:${cloudPort}${p}`)).status));
  line(editorThroughCloud.every((s) => s === 401), `editor routes on the Cloud port: ${editorThroughCloud.join(", ")} (no token: nothing said)`);

  // 3. Invite and join, once.
  const inv = await call(sa, "/api/cloud/host/invite", { label: "ben@studio.test", role: "editor" });
  const link = inv.j.link as string;
  line(inv.status === 200 && link.startsWith("canvas://cloud/join?"), "Anna has an invite link");
  const joined = await call(sb, "/api/cloud/join", { link, device: "Ben's MacBook" });
  line(joined.status === 200 && joined.j.hostId === started.j.hostId, `Ben joined with it${joined.status === 200 ? "" : `: ${joined.j.error}`}`);
  const again = await call(sb, "/api/cloud/join", { link, device: "Ben's other Mac" });
  line(again.status !== 200 && /already used|expired/.test(again.j.error), "the same link does not work twice");
  const people = (await (await fetch(`${sa.base}/api/cloud/host`)).json() as any).people;
  line(people.some((p: any) => p.label === "ben@studio.test" && p.devices.length === 1 && p.devices[0].name === "Ben's MacBook"), "Anna sees Ben joined from Ben's MacBook");
  await until("Ben connected", async () => (await status(sb)).status === "connected");
  line(true, `Ben is connected as ${(await status(sb)).role}`);
  const secrets = fs.readFileSync(path.join(tmp, "Ben-secrets.json"), "utf8");
  line(secrets.length > 0, "and it is there");

  // 4. Share and sync.
  const t1 = crypto.randomUUID(), c1 = crypto.randomUUID();
  await postOps(sa, pkgA, [op({ kind: "thread.create", thread: t1, anchor, comment: c1, body: "First, before sharing" })]);
  const before = JSON.parse(fs.readFileSync(path.join(pkgA, "comments.json"), "utf8"));
  const shared = await call(sa, `/api/cloud/share?file=${encodeURIComponent(pkgA)}`);
  line(shared.status === 200 && shared.j.url === `canvas-cloud://${started.j.hostId}`, `shared to ${shared.j.url?.replace(/[0-9a-f-]{36}/, "<host id>")}: the file names the Cloud by its id, not an address`);
  const diskA = () => JSON.parse(fs.readFileSync(path.join(pkgA, "comments.json"), "utf8"));
  await until("Anna's outbox to empty", () => diskA().outbox.length === 0);
  const pkgB = path.join(dirB, "design.canvas");
  fs.cpSync(pkgA, pkgB, { recursive: true });
  fs.writeFileSync(path.join(pkgB, "comments.json"), JSON.stringify(shareLocal({ ...before, server: undefined }, shared.j.url, { name: "Ben" }, [])));
  const diskB = () => JSON.parse(fs.readFileSync(path.join(pkgB, "comments.json"), "utf8"));
  await comments(sb, pkgB);
  await until("Ben's copy connected", async () => (await comments(sb, pkgB)).sync?.status === "connected");
  await until("Ben has Anna's thread", () => diskB().threads.some((t: any) => t.id === t1));
  const bt = crypto.randomUUID();
  const t0 = Date.now();
  await postOps(sb, pkgB, [op({ kind: "thread.create", thread: bt, anchor, comment: crypto.randomUUID(), body: "From Ben" })]);
  await until("Ben's comment at Anna's", () => diskA().threads.some((t: any) => t.id === bt), 2000);
  const ms = Date.now() - t0;
  const author = diskA().threads.find((t: any) => t.id === bt).comments[0].author;
  line(ms < 1000 && author.email === "ben@studio.test" && typeof author.id === "string", `Ben's comment reached Anna in ${ms} ms, by person ${author.id ? "id" : "?"}`);

  // 5. The Cloud stops answering (its process paused, like a Mac asleep with the lid closed).
  paused = pgrep(path.join("cloud", "node", "main.ts"));
  for (const pid of paused) process.kill(Number(pid), "SIGSTOP");
  const downAfter = await until("Ben reads down", async () => (await comments(sb, pkgB)).sync?.status === "down", 30_000);
  line(true, `Ben's status reads "down" ${downAfter} ms after the Cloud stopped answering`);
  const st = await status(sb);
  line(st.status === "down", `and Settings reads ${st.status}`);
  const bt2 = crypto.randomUUID();
  await postOps(sb, pkgB, [op({ kind: "thread.create", thread: bt2, anchor, comment: crypto.randomUUID(), body: "Written while the Cloud was down" })]);
  line(diskB().outbox.length === 1, "Ben's comment waits in his outbox");
  for (const pid of paused) process.kill(Number(pid), "SIGCONT");
  paused = [];
  const back = await until("Anna gets the comment written while down", () => diskA().threads.some((t: any) => t.id === bt2), 70_000);
  line(true, `the Cloud is back; Anna got it ${back} ms later`);
  await until("Ben's outbox empty", () => diskB().outbox.length === 0);

  // 6. Anna removes Ben.
  const ben = (await (await fetch(`${sa.base}/api/cloud/host`)).json() as any).people.find((p: any) => p.label === "ben@studio.test");
  await call(sa, "/api/cloud/host/remove", { personId: ben.id });
  await until("Ben removed", async () => (await comments(sb, pkgB)).sync?.status === "removed", 15_000);
  line(true, "Ben's socket closed and he reads \"removed\"");
  const keys = JSON.parse(fs.readFileSync(path.join(fakeDir, fs.readdirSync(fakeDir).find((f) => f.endsWith(".json") && JSON.parse(fs.readFileSync(path.join(fakeDir, f), "utf8")).allow)!), "utf8")).allow;
  line(Array.isArray(keys) && keys.length === 0, "the member tunnel no longer lets his Mac's key in");
  await sleep(4000);
  line((await comments(sb, pkgB)).sync?.status === "removed", "and he still reads \"removed\", not \"down\", once the tunnel shuts him out");

  const files = (fs.readdirSync(dirB, { recursive: true }) as string[]).map((f) => path.join(dirB, f)).filter((f) => fs.statSync(f).isFile());
  line(!files.some((f) => /ccd_|ccj_|"tc[A-Za-z0-9_-]{20}/.test(fs.readFileSync(f, "latin1"))), `no token, code or tunnel address in Ben's ${files.length} files`);

  // 7. Stop hosting, quit: nothing left running.
  await call(sa, "/api/cloud/host/stop");
  await call(sb, "/api/cloud/leave", { url: shared.j.url });
  await sleep(500);
  for (const s of scratch) await s.stop();
  scratch.length = 0;
  await sleep(1500);
  const left = [...pgrep(path.join("cloud", "node", "main.ts")), ...pgrep("fake-tunnel.ts")].filter((pid) => {
    try { return execFileSync("ps", ["-o", "command=", "-p", pid], { encoding: "utf8" }).includes(ROOT); } catch { return false; }
  });
  line(left.length === 0, `no Cloud process or tunnel helper left running (${left.length})`);
}

try {
  await main();
} catch (e) {
  console.log(`FAIL ${(e as Error).message}`);
  failed++;
} finally {
  for (const pid of paused) { try { process.kill(Number(pid), "SIGCONT"); } catch { /* gone */ } }
  for (const s of scratch) await s.stop().catch(() => {});
  fs.rmSync(tmp, { recursive: true, force: true });
}
console.log(failed ? `${failed} check(s) failed` : "all checks passed");
process.exit(failed ? 1 : 0);
