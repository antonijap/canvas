// Hosting's tunnels (src/cloud-host.ts) under a storm of invites, joins and removals: exactly one member tunnel with
// exactly the enrolled keys, an enrolment tunnel only while a code waits, and nothing left after Stop hosting. The
// stand-in helper (test/fixtures/fake-tunnel.ts) writes what each serve was started with, so the test can read it.

import assert from "node:assert/strict";
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
