// Joining a hosted Cloud while something else happens (src/cloud.ts join): a removal while the Cloud answers keeps
// the removal and saves nothing; two joins into one Cloud at once enrol this Mac once. The host is another Canvas
// server (its own state and secrets), reached through the stand-in tunnel helper (test/fixtures/fake-tunnel.ts).

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { startServer, type Scratch } from "../qa/lib.ts";

const ROOT = path.resolve(import.meta.dirname, "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "canvas-join-races-"));
const tunnels = path.join(tmp, "tunnels");
fs.mkdirSync(tunnels);
Object.assign(process.env, {
  CANVAS_FAKE_TUNNEL_DIR: tunnels,
  CANVAS_FAKE_TUNNEL_NODE: process.execPath,
  CANVAS_FAKE_TUNNEL_ANY_PORT: "1",
  CANVAS_TUNNEL_BIN: path.join(ROOT, "test", "fixtures", "fake-tunnel.sh"),
  CANVAS_CLOUD_SECRETS_FILE: path.join(tmp, "joiner-secrets.json"),
  CANVAS_STATE_DIR: path.join(tmp, "joiner-state"),
});
delete process.env.CANVAS_CLOUD_URL;
const Cfg = await import("../src/cloud-config.ts");
const Cl = await import("../src/cloud.ts");
const Sec = await import("../src/cloud-secrets.ts");
const Tn = await import("../src/cloud-tunnel.ts");

const hostDir = path.join(tmp, "host");
fs.mkdirSync(hostDir);
const host: Scratch = await startServer(hostDir, { CANVAS_CLOUD_SECRETS_FILE: path.join(tmp, "host-secrets.json"), CANVAS_CLOUD_HOST_PORT: "0" });
after(async () => {
  Cl.testHooks.afterJoinAnswer = undefined;
  Cl.stopAll(); Tn.stopHelpers();
  await fetch(`${host.base}/api/cloud/host/stop`, { method: "POST", headers: { "x-canvas": "1", "content-type": "application/json" }, body: "{}" }).catch(() => {});
  await host.stop();
  fs.rmSync(tmp, { recursive: true, force: true });
});
const call = async (p: string, body: unknown = {}) => {
  const r = await fetch(host.base + p, { method: "POST", headers: { "x-canvas": "1", "content-type": "application/json" }, body: JSON.stringify(body) });
  return { status: r.status, j: (await r.json()) as any };
};
const started = await call("/api/cloud/host/start", { name: "Team Cloud", label: "Ben" });
const hostId: string = started.j.hostId;
const url = `canvas-cloud://${hostId}`;
const people = async () => ((await (await fetch(`${host.base}/api/cloud/host?hostId=${hostId}`)).json()) as any).people as { label: string; devices: unknown[] }[];

test("a Cloud removed while its join waits for the answer: nothing is saved and the removal stands", async () => {
  assert.equal(started.status, 200, JSON.stringify(started.j));
  const link = (await call("/api/cloud/host/invite", { label: "anna@studio.test" })).j.link;
  Cl.testHooks.afterJoinAnswer = (u) => { Cfg.removeCloud(u); };
  try {
    await assert.rejects(Cl.join(link, "Anna's Mac"), /removed while joining/);
  } finally { Cl.testHooks.afterJoinAnswer = undefined; }
  assert.equal(Cfg.isConfigured(url), false, "the late answer does not add the Cloud back");
  assert.equal(await Sec.readJoined(hostId), null, "no invite saved in the Keychain");
});

test("removal before redeeming a join sends no invite or device token", async () => {
  const link = (await call("/api/cloud/host/invite", { label: "before@studio.test" })).j.link;
  Cl.testHooks.beforeJoinRequest = (u) => { Cfg.removeCloud(u); };
  try {
    await assert.rejects(Cl.join(link, "A Mac"), /removed while joining/);
  } finally { Cl.testHooks.beforeJoinRequest = undefined; }
  assert.equal((await people()).find((p) => p.label === "before@studio.test")?.devices.length, 0, "the invite was never redeemed");
  assert.equal(await Sec.readJoined(hostId), null);
});

test("two joins into one Cloud at once: this Mac joins once, the other is told it is already in", async () => {
  const a = (await call("/api/cloud/host/invite", { label: "cy@studio.test" })).j.link;
  const b = (await call("/api/cloud/host/invite", { label: "dee@studio.test" })).j.link;
  const [ra, rb] = await Promise.allSettled([Cl.join(a, "Anna's Mac"), Cl.join(b, "Anna's Mac")]);
  const ok = [ra, rb].filter((r) => r.status === "fulfilled");
  const refused = [ra, rb].filter((r) => r.status === "rejected") as PromiseRejectedResult[];
  assert.equal(ok.length, 1, "one join");
  assert.match(String(refused[0]?.reason?.message), /already in that Cloud/);
  // (anna@studio.test is the device the test above enrolled on the host before its answer was dropped here.)
  const joined = (await people()).filter((p) => p.devices.length > 0 && (p.label === "cy@studio.test" || p.label === "dee@studio.test"));
  assert.equal(joined.length, 1, `one device enrolled for this Mac (${joined.map((p) => p.label)})`);
  const saved = await Sec.readJoined(hostId);
  assert.ok(saved, "and its token is the one saved");
  const t = await Cl.target(url);
  assert.ok(!("fail" in t), `the saved token reaches the Cloud (${JSON.stringify(t)})`);
});

test("removal while a join is queued cancels it before any invite is redeemed", async () => {
  const make = async (name: string) => {
    const h = await call("/api/cloud/host/start", { name, label: "Host" });
    const link = (await call("/api/cloud/host/invite", { hostId: h.j.hostId, label: "member@studio.test" })).j.link;
    return { id: h.j.hostId as string, url: h.j.url as string, link };
  };
  const first = await make("First"), next = await make("Next");
  let reached!: () => void, release!: () => void;
  const waiting = new Promise<void>((r) => { reached = r; });
  const gate = new Promise<void>((r) => { release = r; });
  Cl.testHooks.afterJoinAnswer = async (u) => { if (u === first.url) { reached(); await gate; } };
  const a = Cl.join(first.link, "A Mac");
  await waiting;
  const b = Cl.join(next.link, "A Mac");
  const refused = assert.rejects(b, /removed while joining/);
  Cfg.removeCloud(next.url);
  release();
  try {
    await a;
    await refused;
    const state = await (await fetch(`${host.base}/api/cloud/host?hostId=${next.id}`)).json() as any;
    const p = state.people;
    assert.equal(p.find((p: any) => p.label === "member@studio.test").devices.length, 0);
    assert.equal(await Sec.readJoined(next.id), null);
  } finally { Cl.testHooks.afterJoinAnswer = undefined; release(); }
});
