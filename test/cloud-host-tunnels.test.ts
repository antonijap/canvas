// Hosting's tunnels (src/cloud-host.ts) under a storm of invites, joins and removals: exactly one member tunnel with
// exactly the enrolled keys, an enrolment tunnel only while a code waits, and nothing left after Stop hosting. The
// stand-in helper (test/fixtures/fake-tunnel.ts) writes what each serve was started with, so the test can read it.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";

const ROOT = path.resolve(import.meta.dirname, "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "canvas-cloud-tunnels-"));
const tunnels = path.join(tmp, "tunnels");
fs.mkdirSync(tunnels);
Object.assign(process.env, {
  CANVAS_FAKE_TUNNEL_DIR: tunnels,
  CANVAS_FAKE_TUNNEL_NODE: process.execPath,
  CANVAS_FAKE_TUNNEL_ANY_PORT: "1",
  CANVAS_TUNNEL_BIN: path.join(ROOT, "test", "fixtures", "fake-tunnel.sh"),
  CANVAS_CLOUD_SECRETS_FILE: path.join(tmp, "secrets.json"),
  CANVAS_STATE_DIR: path.join(tmp, "state"),
  CANVAS_CLOUD_HOST_PORT: "0",
});
const Host = await import("../src/cloud-host.ts");
const Tn = await import("../src/cloud-tunnel.ts");
after(async () => { await Host.stopHosting().catch(() => {}); Tn.stopHelpers(); fs.rmSync(tmp, { recursive: true, force: true }); });

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const served = () => fs.readdirSync(tunnels).filter((f) => f.endsWith(".json")).map((f) => JSON.parse(fs.readFileSync(path.join(tunnels, f), "utf8")) as { allow: string[] | null; pid: number });
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

test("after a storm of invites, joins and removals: one member tunnel with exactly the enrolled keys, one enrolment tunnel while a code waits, none after Stop", async () => {
  await Host.startHosting({ name: "Studio Cloud", label: "Anna" });
  const st = await Host.hostStatus() as any;
  assert.equal(st.tunnel, "up");
  // Devices joining with their own tunnel keys, through the enrolment tunnel, while invites and removals race.
  const bin = Tn.helperPath()!;
  const joinOne = async (who: string) => {
    const link = await Host.invite(who);
    const q = new URL(link).searchParams;
    const key = await Tn.genkey(bin, "client");
    const f = await Tn.forward(bin, key.key, q.get("tc")!);
    const r = await fetch(`${f.origin}/v1/join`, { method: "POST", headers: { authorization: `Bearer ${q.get("code")}`, "content-type": "application/json" }, body: JSON.stringify({ token: `ccd_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}.${"t".repeat(43)}`, device: who, key: key.public }) });
    f.helper.stop();
    assert.equal(r.status, 200, `${who} joined`);
    return key.public;
  };
  const keys = await Promise.all(["ben@studio.test", "cy@studio.test", "dee@studio.test", "eli@studio.test"].map(joinOne));
  const people = () => (Host.hostStatus() as Promise<any>).then((s) => s.people as { id: string; label: string }[]);
  const byLabel = async (l: string) => (await people()).find((p) => p.label === l)!.id;
  // Removals and fresh invites at once (one invite stays pending).
  await Promise.all([
    Host.removePerson(await byLabel("cy@studio.test")),
    Host.removePerson(await byLabel("eli@studio.test")),
    Host.invite("fay@studio.test"),
    Host.invite("gus@studio.test"),
    Host.hostStatus(), Host.hostStatus(),
  ]);
  await sleep(500);
  await Host.hostStatus();
  const h = Host.hostHelpers();
  const expected = [keys[0], keys[2]].sort();
  assert.ok(h.member && alive(h.member), "a member tunnel runs");
  assert.deepEqual([...(h.allow ?? [])].sort(), expected, "it lets in exactly the enrolled keys");
  assert.ok(h.enrol && alive(h.enrol), "the enrolment tunnel runs: invites wait");
  assert.deepEqual(Tn.runningHelpers().sort(), [h.member!, h.enrol!].sort(), "no other helper runs");
  const s = served();
  assert.equal(s.length, 2, `two served addresses (${s.length})`);
  assert.deepEqual([...(s.find((x) => x.allow)!.allow ?? [])].sort(), expected, "the running member tunnel has the current list");
  // Stop hosting: none left.
  await Host.stopHosting();
  await sleep(1500);
  assert.deepEqual(Tn.runningHelpers(), [], "no helper after Stop hosting");
  assert.ok(!alive(h.member!) && !alive(h.enrol!), "both helper processes are gone");
});

test("several Clouds hosted at once: each its own id, port, folder, people and tunnels; stop, restart and delete one leave the others", async () => {
  const bin = Tn.helperPath()!;
  const a = await Host.startHosting({ name: "Studio", label: "Anna" });
  const b = await Host.startHosting({ name: "Client review", label: "Anna" });
  assert.notEqual(a, b, "a new Cloud gets its own id");
  const sa = await Host.hostStatus(a) as any, sb = await Host.hostStatus(b) as any;
  assert.ok(sa.hosting && sb.hosting && sa.port !== sb.port, "two processes on two ports");
  assert.notEqual(sa.fingerprint, sb.fingerprint, "two tunnel identities");
  assert.equal(Host.localHost(a)!.hostId, a);
  assert.equal(Host.localHost(b)!.hostId, b);
  assert.equal(Host.localHost(), null, "with two running, no call goes to one by default");
  // An invite to b names b, and the person who joins with it is in b only.
  const link = await Host.invite("ben@studio.test", undefined, b);
  const q = new URL(link).searchParams;
  assert.equal(q.get("host"), b);
  const key = await Tn.genkey(bin, "client");
  const f = await Tn.forward(bin, key.key, q.get("tc")!);
  const r = await fetch(`${f.origin}/v1/join`, { method: "POST", headers: { authorization: `Bearer ${q.get("code")}`, "content-type": "application/json" }, body: JSON.stringify({ token: `ccd_0123456789abcdef.${"t".repeat(43)}`, device: "Ben's MacBook", key: key.public }) });
  f.helper.stop();
  assert.equal(r.status, 200);
  const labels = async (id: string) => ((await Host.hostStatus(id)) as any).people.map((p: any) => p.label).sort();
  assert.deepEqual(await labels(b), ["Anna", "ben@studio.test"]);
  assert.deepEqual(await labels(a), ["Anna"], "the other Cloud has nobody new");
  // Each Cloud has its own enrolment tunnel.
  const linkA = await Host.invite("cy@studio.test", undefined, a);
  assert.notEqual(new URL(linkA).searchParams.get("tc"), q.get("tc"), "each Cloud its own enrolment tunnel");
  // Stop a: b runs on; a starts again under the same id with its people.
  await Host.stopHosting(a);
  assert.equal(Host.localHost(a), null);
  assert.ok(Host.localHost(b), "b still runs");
  assert.equal(await Host.startHosting({ name: "Studio", label: "Anna", hostId: a }), a, "the same Cloud again");
  assert.deepEqual(await labels(a), ["Anna", "cy@studio.test"], "with its people (the invite still waiting)");
  // Delete b: its folder, slot and keys go; a new Cloud never takes its id.
  const all = await Host.hostStatusAll();
  const known = all.clouds.map((c: any) => c.hostId);
  assert.ok(known.includes(a) && known.includes(b), "both are listed with the Clouds this Mac hosts");
  await Host.wipeHosting(b);
  assert.equal(Host.localHost(b), null);
  assert.ok(!(await Host.hostsHere(b)), "b is forgotten");
  await assert.rejects(Host.startHosting({ name: "x", label: "Anna", hostId: b }), /does not host/);
  const c = await Host.startHosting({ name: "Third", label: "Anna" });
  assert.ok(c !== a && c !== b, "a new Cloud gets a new id");
  // Starting several at once never gives two the same slot or id.
  const many = await Promise.all([1, 2, 3].map((i) => Host.startHosting({ name: `Team ${i}`, label: "Anna" })));
  assert.equal(new Set([...many, a, c]).size, 5);
  await Host.stopHosting();
  await sleep(1000);
  assert.deepEqual(Tn.runningHelpers(), [], "no helper after stopping them all");
});

const waitFor = async (ok: () => boolean | Promise<boolean>, what: string, ms = 10_000) => {
  const t0 = Date.now();
  while (!(await ok())) { if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}`); await sleep(25); }
};
const cloudPids = () => { try { return execFileSync("pgrep", ["-P", String(process.pid), "-f", "cloud/adapters/mac/main.ts"], { encoding: "utf8" }).trim().split("\n").filter(Boolean); } catch { return []; } };

test("a tunnel start that finishes after Stop and Start again never serves the old port", async () => {
  const a = await Host.startHosting({ name: "Gate", label: "Anna" });
  const oldPort = ((await Host.hostStatus(a)) as any).port as number;
  const gate = path.join(tmp, "gate");
  const waiting = () => fs.readdirSync(tmp).filter((f) => f.startsWith("gate.waiting.")).length;
  process.env.CANVAS_FAKE_TUNNEL_GATE = gate;
  try {
    // An invite starts the enrolment tunnel; the helper is held at the gate.
    const inv = Host.invite("ben@studio.test", undefined, a).catch((e) => e);
    await waitFor(() => waiting() >= 1, "the enrolment tunnel to wait at the gate");
    // Meanwhile the Cloud stops and starts again, on another port; its own tunnels wait at the gate too.
    await Host.stopHosting(a);
    const restart = Host.startHosting({ name: "Gate", label: "Anna", hostId: a });
    await waitFor(() => waiting() >= 2, "the restarted Cloud's tunnel to wait");
    fs.writeFileSync(gate, "");
    await restart;
    await inv;
    await sleep(500);
    await Host.hostStatus(a);
    await sleep(500);
    const newPort = ((await Host.hostStatus(a)) as any).port as number;
    assert.notEqual(newPort, oldPort, "started again on another port");
    const s = (served() as unknown as { port: number; pid: number }[]).filter((x) => alive(x.pid));
    assert.ok(s.length > 0 && s.every((x) => x.port === newPort), `every served tunnel goes to the new port (${s.map((x) => x.port)}; old ${oldPort})`);
    const h = Host.hostHelpers(a);
    assert.deepEqual(Tn.runningHelpers().sort(), [h.member, h.enrol].filter(Boolean).sort(), "no helper from the old run left running");
  } finally {
    delete process.env.CANVAS_FAKE_TUNNEL_GATE;
    await Host.stopHosting(a);
  }
});

test("Delete while a start of the same Cloud is under way: the start finishes first, then nothing of it is left", async () => {
  const x = await Host.startHosting({ name: "Gone", label: "Anna" });
  await Host.stopHosting(x);
  const gate = path.join(tmp, "wipe-start");
  process.env.CANVAS_FAKE_TUNNEL_GATE = gate;
  const start = Host.startHosting({ name: "Gone", label: "Anna", hostId: x });
  await waitFor(() => fs.readdirSync(tmp).some((f) => f.startsWith("wipe-start.waiting.")), "the start to wait for its member tunnel");
  let deleted = false;
  const wipe = Host.wipeHosting(x).then(() => { deleted = true; });
  try {
    await sleep(500);
    assert.equal(deleted, false, "Delete waits for the in-progress start");
  } finally {
    fs.writeFileSync(gate, "");
    delete process.env.CANVAS_FAKE_TUNNEL_GATE;
    await start;
    await wipe;
  }
  await sleep(800);
  assert.equal(Host.localHost(x), null, "not running");
  assert.ok(!(await Host.hostsHere(x)), "not kept");
  assert.ok(!(await Host.hostStatusAll()).clouds.some((c: any) => c.hostId === x), "not listed");
  const runningNow = (await Host.hostStatusAll()).clouds.filter((c: any) => c.hosting).length;
  await waitFor(() => cloudPids().length === runningNow, `no Cloud process left behind for it (${cloudPids().length} running, ${runningNow} hosting)`);
  const ix = JSON.parse(fs.readFileSync(path.join(tmp, "state", "cloud-hosts.json"), "utf8"));
  assert.ok(!Object.values(ix).includes(x), "not in the index");
});

test("at most 8 Clouds on one Mac: the ninth is refused with a reason", async () => {
  const known = (await Host.hostStatusAll()).clouds.length;
  const made: string[] = [];
  for (let i = known; i < Host.MAX_HOSTED; i++) made.push(await Host.startHosting({ name: `Team ${i}`, label: "Anna" }));
  assert.equal((await Host.hostStatusAll()).clouds.length, 8);
  await assert.rejects(Host.startHosting({ name: "Ninth", label: "Anna" }), /8 Clouds at most/);
  assert.equal(Host.MAX_HOSTED, 8);
  assert.deepEqual(Host.HOST_PORTS, { first: 5190, last: 5197 }, "one port each, and the helper serves no other");
  // Deleting one makes room again.
  await Host.wipeHosting(made[0] ?? (await Host.hostStatusAll()).clouds[0].hostId as string);
  const again = await Host.startHosting({ name: "Room again", label: "Anna" });
  assert.ok(again);
  await Host.stopHosting();
});

test("a stopped follow run cannot repeat against the restarted process while its follow is pending", async () => {
  // The prior limit test keeps eight stopped Clouds. Resume one by id.
  const a = (await Host.hostStatusAll()).clouds[0]?.hostId as string || await Host.startHosting({ name: "Gate", label: "Host" });
  await Host.startHosting({ name: "Gate", label: "Host", hostId: a });
  const oldPort = Host.localHost(a)!.origin;
  const oldGate = path.join(tmp, "old-run"), newGate = path.join(tmp, "new-run");
  const waiting = (gate: string) => fs.readdirSync(tmp).filter((f) => f.startsWith(path.basename(gate) + ".waiting.")).length;
  process.env.CANVAS_FAKE_TUNNEL_GATE = oldGate;
  let settled = false;
  const inv = Host.invite("next@studio.test", undefined, a).catch(() => {}).finally(() => { settled = true; });
  await waitFor(() => waiting(oldGate) === 1, "old enrolment start");
  const oldStatus = Host.hostStatus(a);
  await Host.stopHosting(a);
  process.env.CANVAS_FAKE_TUNNEL_GATE = newGate;
  const restart = Host.startHosting({ name: "Gate", label: "Host", hostId: a });
  await waitFor(() => waiting(newGate) === 1, "new member start");
  const newStatus = Host.hostStatus(a); // Requests a second pass for the new process only.
  try {
    fs.writeFileSync(oldGate, "");
    await waitFor(() => settled || waiting(newGate) > 1, "the old run to finish without duplicating the new helper");
    await waitFor(() => !(served() as unknown as { port: number; pid: number }[]).some((x) => alive(x.pid) && oldPort.endsWith(`:${x.port}`)), "no helper serving the stopped process port before the new helper is ready");
    assert.equal(settled, true, "old follow returns instead of following the new process again");
    assert.equal(waiting(newGate), 1, "only the new run starts a member helper");
  } finally {
    fs.writeFileSync(newGate, "");
    await Promise.all([inv, oldStatus, restart, newStatus]);
    delete process.env.CANVAS_FAKE_TUNNEL_GATE;
    await Host.stopHosting(a);
  }
});
