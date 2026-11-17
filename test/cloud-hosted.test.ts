// A hosted Cloud from the joining side: the address rules, invite links, where requests go and as whom, and the
// tunnel helper's life (test/fixtures/fake-tunnel.ts stands in for the real one).

import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";

const ROOT = path.resolve(import.meta.dirname, "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "canvas-cloud-hosted-"));
const tunnels = path.join(tmp, "tunnels");
fs.mkdirSync(tunnels);
process.env.CANVAS_FAKE_TUNNEL_DIR = tunnels;
process.env.CANVAS_FAKE_TUNNEL_NODE = process.execPath;
process.env.CANVAS_FAKE_TUNNEL_ANY_PORT = "1";
process.env.CANVAS_TUNNEL_BIN = path.join(ROOT, "test", "fixtures", "fake-tunnel.sh");
process.env.CANVAS_CLOUD_SECRETS_FILE = path.join(tmp, "secrets.json");
process.env.CANVAS_STATE_DIR = path.join(tmp, "state");
const Cfg = await import("../src/cloud-config.ts");
const Tn = await import("../src/cloud-tunnel.ts");
const Cl = await import("../src/cloud.ts");
const Sec = await import("../src/cloud-secrets.ts");
after(() => { Cl.stopAll(); Tn.stopHelpers(); fs.rmSync(tmp, { recursive: true, force: true }); });

const HOST = "3f2b8c1e-5d4a-4e6f-9a7b-1c2d3e4f5a6b";
const TC = `tc${"A".repeat(60)}`;
const CODE = `ccj_0123456789abcdef.${"b".repeat(43)}`;
const link = (q: Record<string, string>) => `canvas://cloud/join?${new URLSearchParams(q)}`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

test("Cloud addresses: https, a hosted Cloud by its id, http on this Mac only; never http to another host", () => {
  assert.equal(Cfg.cleanServerUrl(`canvas-cloud://${HOST}`), `canvas-cloud://${HOST}`);
  assert.equal(Cfg.cleanServerUrl(`CANVAS-CLOUD://${HOST.toUpperCase()}/`), `canvas-cloud://${HOST}`);
  assert.equal(Cfg.cleanServerUrl("canvas-cloud://studio-mac.local"), null);
  assert.equal(Cfg.hostedId(`canvas-cloud://${HOST}`), HOST);
  assert.equal(Cfg.hostedId("https://studio.example.com"), null);
  for (const lan of ["http://192.168.1.20:5190", "http://10.0.0.5:5190", "http://studio-mac.local:5190", "http://100.101.102.103:5190", "http://studio-mac.tail1234.ts.net:5190", "http://[fd7a:115c:a1e0::1]:5190", "http://0.0.0.0:5190", "http://[::]:5190"]) {
    assert.equal(Cfg.cleanServerUrl(lan), null, lan);
  }
  assert.equal(Cfg.hostOf(`canvas-cloud://${HOST}`), HOST);
});

test("invite links: every part checked; a link with anything missing or odd is nothing", () => {
  const good = { v: "1", name: "Studio Cloud", host: HOST, tc: TC, code: CODE };
  assert.deepEqual(Cfg.parseInvite(link(good)), { name: "Studio Cloud", hostId: HOST, addr: TC, code: CODE });
  assert.equal(Cfg.parseInvite(link({ ...good, name: "Studio\u0007\nCloud" }))!.name, "Studio Cloud");
  assert.equal(Cfg.parseInvite(link({ ...good, name: "" }))!.name, "Cloud");
  for (const [what, bad] of [
    ["version", { ...good, v: "2" }], ["host", { ...good, host: "studio-mac" }], ["tunnel", { ...good, tc: "http://192.168.1.20" }],
    ["code", { ...good, code: "ccd_0123456789abcdef." + "b".repeat(43) }], ["no code", { v: "1", name: "x", host: HOST, tc: TC }],
  ] as const) assert.equal(Cfg.parseInvite(link(bad as Record<string, string>)), null, what);
  assert.equal(Cfg.parseInvite(link(good).replace("canvas://cloud/join", "canvas://open")), null);
  assert.equal(Cfg.parseInvite(link(good).replace("canvas:", "https:")), null);
  assert.equal(Cfg.parseInvite(link(good) + "&x=" + "y".repeat(9000)), null, "too long");
});

test("a hosted Cloud never gets a dev email or an Access token; with no invite saved it is signed out", async () => {
  Cfg.setCloudConfig({ cloudUrl: `canvas-cloud://${HOST}`, cloudDevEmail: "anna@studio.test" });
  const t = await Cl.target(`canvas-cloud://${HOST}`);
  assert.deepEqual(t, { fail: "signedOut" });
  Cl.setToken("https://team.example.com", "eyJhbGciOi.payload.signature");
  const access = await Cl.target("https://team.example.com");
  assert.ok(!("fail" in access) && !access.hosted && access.headers["cf-access-token"]);
  Cl.setToken("https://team.example.com", null);
});

test("a joined Cloud is reached through this Mac's own helper on 127.0.0.1, with its device token; no host there reads down", async () => {
  const bin = Tn.helperPath()!;
  const key = await Tn.genkey(bin, "client");
  await Sec.writeJoined(HOST, { token: `ccd_0123456789abcdef.${"c".repeat(43)}`, addr: TC, key: key.key });
  const t = await Cl.target(`canvas-cloud://${HOST}`);
  assert.ok(!("fail" in t), JSON.stringify(t));
  if ("fail" in t) return;
  assert.match(t.base, /^http:\/\/127\.0\.0\.1:\d+$/);
  assert.deepEqual(Object.keys(t.headers), ["authorization"]);
  assert.match(t.headers.authorization, /^Bearer ccd_/);
  // Nothing serves that address: the Cloud is down, not "offline", and nothing was sent anywhere else.
  const st = await Cl.checkServer(`canvas-cloud://${HOST}`, true);
  assert.equal(st.status, "down");
  Cl.closeTunnel(HOST);
  await Sec.deleteJoined(HOST);
});

test("tunnel helper: serve, forward, the port belongs to the helper, and it quits when told or when its parent goes", async () => {
  const bin = Tn.helperPath()!;
  const echo = net.createServer((c) => c.pipe(c));
  await new Promise<void>((r) => echo.listen(0, "127.0.0.1", r));
  const port = (echo.address() as net.AddressInfo).port;
  const server = await Tn.genkey(bin, "server");
  const client = await Tn.genkey(bin, "client");
  const s = await Tn.serve(bin, server.key, [client.public], port);
  assert.ok(Tn.isTunnelAddr(s.addr) && s.addr === server.addr);
  const f = await Tn.forward(bin, client.key, s.addr, port);
  assert.ok(await Tn.ownsPort(f.helper.child.pid!, Number(new URL(f.origin).port)));
  assert.equal(await Tn.ownsPort(process.pid, Number(new URL(f.origin).port)), false);
  const reply = await new Promise<string>((resolve) => {
    const c = net.connect(Number(new URL(f.origin).port), "127.0.0.1", () => c.write("ping"));
    c.on("data", (d) => { resolve(String(d)); c.destroy(); });
    c.on("error", () => resolve(""));
  });
  assert.equal(reply, "ping", "bytes go through");
  // A key not in the allow list is refused.
  const stranger = await Tn.genkey(bin, "client");
  const g = await Tn.forward(bin, stranger.key, s.addr, port);
  const refused = await new Promise<boolean>((resolve) => {
    const c = net.connect(Number(new URL(g.origin).port), "127.0.0.1", () => c.write("ping"));
    c.on("data", () => resolve(false)); c.on("close", () => resolve(true)); c.on("error", () => resolve(true));
  });
  assert.ok(refused, "a device that did not enrol is not let in");
  const pids = [s.helper.child.pid!, f.helper.child.pid!, g.helper.child.pid!];
  for (const h of [s.helper, f.helper, g.helper]) h.stop();
  await sleep(500);
  assert.ok(pids.every((p) => !alive(p)), "stopped helpers are gone");
  for (let i = 0; i < 40 && Tn.runningHelpers().length; i++) await sleep(50);
  assert.deepEqual(Tn.runningHelpers(), [], "Canvas runs no helper it does not use");
  // A parent killed outright: its helper's stdin closes and the helper quits on its own.
  const parent = spawn(process.execPath, ["-e", `
    const { spawn } = require("node:child_process");
    const h = spawn(${JSON.stringify(bin)}, [], { stdio: ["pipe", "pipe", "ignore"], env: process.env });
    h.stdin.write(JSON.stringify({ op: "forward", key: { fake: "x" }, addr: ${JSON.stringify(s.addr)}, port: 1 }) + "\\n");
    h.stdout.once("data", () => console.log(h.pid));
  `], { stdio: ["ignore", "pipe", "ignore"], env: process.env });
  const helperPid = Number(await new Promise<string>((r) => parent.stdout!.once("data", (d) => r(String(d).trim()))));
  assert.ok(alive(helperPid));
  parent.kill("SIGKILL");
  for (let i = 0; i < 40 && alive(helperPid); i++) await sleep(50);
  assert.ok(!alive(helperPid), "no orphan helper after its parent is killed");
  echo.close();
});

test("the helper gets nothing secret on its command line, and a small environment", async () => {
  const bin = Tn.helperPath()!;
  const key = await Tn.genkey(bin, "client");
  const f = await Tn.forward(bin, key.key, TC);
  const cmd = execFileSync("ps", ["-o", "command=", "-p", String(f.helper.child.pid)], { encoding: "utf8" });
  assert.ok(!cmd.includes(TC) && !cmd.includes(String((key.key as any).fake)), "no address or key in argv");
  f.helper.stop();
});

test("secrets: written through stdin, never argv; a fake security binary sees the command on stdin", async () => {
  const dir = fs.mkdtempSync(path.join(tmp, "sec-"));
  const log = path.join(dir, "log");
  const fake = path.join(dir, "security");
  fs.writeFileSync(fake, `#!/bin/sh\necho "ARGS $*" >> ${log}\ncat >> ${log}\n`, { mode: 0o755 });
  const saved = process.env.CANVAS_CLOUD_SECRETS_FILE;
  delete process.env.CANVAS_CLOUD_SECRETS_FILE;
  process.env.CANVAS_SECURITY_BIN = fake;
  try {
    assert.ok(await Sec.writeSecret(`hosted:${HOST}`, "very-secret-value"));
    const text = fs.readFileSync(log, "utf8");
    assert.match(text, /^ARGS -i$/m);
    assert.ok(!text.split("\n")[0].includes("very-secret"), "nothing on the command line");
    assert.ok(text.includes(Buffer.from("very-secret-value").toString("base64")), "the value went in on stdin, base64");
    assert.equal(await Sec.writeSecret("bad account name!", "x"), false);
  } finally {
    process.env.CANVAS_CLOUD_SECRETS_FILE = saved;
    delete process.env.CANVAS_SECURITY_BIN;
  }
});
