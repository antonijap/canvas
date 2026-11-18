// Settings > Cloud > Host on this Mac, on the editor server's side: it starts the hosted Cloud as its own process
// (cloud/node/main.ts, 127.0.0.1:5190), the tunnels other Macs reach it through (src/cloud-tunnel.ts), and joins this
// Canvas to it with a device token that never leaves this process. The editor server itself stays on 127.0.0.1:5189
// and is never reachable through the Cloud's port or its tunnels.
//
// Two tunnels, both serving port 5190 only:
//   member     lets in the tunnel keys of enrolled devices only; restarted with the new list when people change.
//   enrolment  runs only while a join code is waiting; anyone holding its address reaches the Cloud, where nothing
//              but POST /v1/join with a valid code answers without a device token.
// Their keys are made once and kept in the Keychain (`host:keys`), so their addresses survive restarts.
//
// Routes (127.0.0.1:5189, POST needs x-canvas: 1 and JSON):
//   GET  /api/cloud/host                     { available, hosting, hostId, fingerprint, tunnel, people }
//   POST /api/cloud/host/start  { name, label }
//   POST /api/cloud/host/stop                every device token is revoked, the tunnels stop
//   POST /api/cloud/host/wipe                Delete hosted data
//   POST /api/cloud/host/invite { label, role }  -> { link }   (the link is a secret: the app copies it, never shows it)
//   POST /api/cloud/host/remove { personId }

import { fork, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { readSecret, writeSecret } from "./cloud-secrets.ts";
import { fingerprint, genkey, helperPath, hostIdFor, ownsPort, serve, type Helper } from "./cloud-tunnel.ts";
import { stateDir } from "./usage-counts.ts";

const MAIN = path.join(import.meta.dirname, "..", "cloud", "node", "main.ts");
export const hostDir = () => path.join(stateDir(), "cloud-host");

interface TunnelKey { key: unknown; addr: string; public: string }
interface HostKeys { member: TunnelKey; enrol: TunnelKey }
interface Person { id: string; label: string; role: string; devices: { id: string; name: string; joinedAt: string }[]; invite?: { expiresAt: string } }

let child: ChildProcess | null = null;
let starting: Promise<void> | null = null;
let port = 0;
let hostId = "";
let ownerToken = "";
let name = "";
let keys: HostKeys | null = null;
let member: { helper: Helper; allow: string } | null = null;
let enrol: Helper | null = null;
let people: Person[] = [];
let tunnelError = "";
const pending = new Map<number, (m: any) => void>();
let seq = 0;

function ask(op: string, args: Record<string, unknown> = {}, ms = 10_000): Promise<any> {
  const c = child;
  if (!c?.connected) return Promise.reject(new Error("Not hosting"));
  const id = ++seq;
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => { pending.delete(id); reject(new Error("The Cloud did not answer")); }, ms);
    t.unref?.();
    pending.set(id, (m) => { clearTimeout(t); m.ok ? resolve(m.result) : reject(Object.assign(new Error(m.error?.message ?? "The Cloud refused"), { code: m.error?.code })); });
    c.send({ id, op, ...args });
  });
}

/** What the hosting Canvas uses to reach its own Cloud: loopback, its own device token. Null when not hosting. */
export function localHost(): { hostId: string; origin: string; token: string } | null {
  return child && hostId && ownerToken && port ? { hostId, origin: `http://127.0.0.1:${port}`, token: ownerToken } : null;
}

export function hosting(): boolean { return !!child; }

async function loadKeys(bin: string): Promise<HostKeys> {
  const raw = await readSecret("host:keys");
  if (raw) { try { const k = JSON.parse(raw); if (k.member?.addr && k.enrol?.addr && k.member.public && k.enrol.public) return k; } catch { /* made again below */ } }
  const m = await genkey(bin, "server"), e = await genkey(bin, "server");
  const k: HostKeys = { member: { key: m.key, addr: m.addr!, public: m.public }, enrol: { key: e.key, addr: e.addr!, public: e.public } };
  if (!(await writeSecret("host:keys", JSON.stringify(k)))) throw new Error("Could not save the tunnel keys to the Keychain");
  return k;
}

/**
 * The tunnels follow the people: the member tunnel's allow list, and the enrolment tunnel while a code waits. One run
 * at a time: a call during a run asks for one more run after it (and waits for that), so two helpers can never be
 * started for the same tunnel, and the last run always sees the latest people.
 */
let following: Promise<void> | null = null;
let again = false;
function follow(): Promise<void> {
  if (following) { again = true; return following; }
  following = (async () => {
    try {
      do { again = false; await followOnce(); } while (again && child);
    } finally { following = null; }
  })();
  return following;
}

async function followOnce(): Promise<void> {
  if (!child) return;
  const r = await ask("people");
  people = r.people;
  const bin = helperPath();
  if (!bin || !keys || !child) return;
  try {
    const allow = JSON.stringify(r.keys);
    if (!member || !member.helper.alive || member.allow !== allow) {
      // The old one stops before the new one starts: never two, and never an old allow list left running.
      const old = member;
      member = null;
      old?.helper.stop();
      const s = await serve(bin, keys.member.key, r.keys, port);
      if (!child) { s.helper.stop(); return; }
      member = { helper: s.helper, allow };
      s.helper.onExit = () => { if (member?.helper === s.helper) { member = null; setTimeout(() => void follow().catch(() => {}), 2000).unref?.(); } };
      await ask("config", { memberAddr: s.addr, memberKey: keys.member.public });
    }
    if (r.pending > 0 && !enrol?.alive) {
      const s = await serve(bin, keys.enrol.key, null, port);
      if (!child) { s.helper.stop(); return; }
      enrol?.stop();
      enrol = s.helper;
    } else if (r.pending === 0 && enrol) { enrol.stop(); enrol = null; }
    tunnelError = "";
  } catch (e) {
    tunnelError = (e as Error).message;
  }
}

/** The helpers hosting runs now, and the allow list the member tunnel was started with (tests). */
export function hostHelpers(): { member: number | null; enrol: number | null; allow: string[] | null } {
  return {
    member: member?.helper.alive ? member.helper.child.pid ?? null : null,
    enrol: enrol?.alive ? enrol.child.pid ?? null : null,
    allow: member ? JSON.parse(member.allow) : null,
  };
}

/** Starts hosting (again): the Cloud process, its owner device for this Canvas, the tunnels. */
export async function startHosting(opts: { name: string; label: string }): Promise<void> {
  name = opts.name.slice(0, 60);
  if (child) { await follow(); return; }
  if (starting) return starting;
  starting = (async () => {
    const env: Record<string, string> = { ...(process.env as Record<string, string>), CANVAS_CLOUD_HOST_DIR: hostDir() };
    const c = fork(MAIN, [], { env, stdio: ["ignore", "ignore", "ignore", "ipc"], execArgv: [] });
    child = c;
    c.on("message", (m: any) => {
      if (m?.id && pending.has(m.id)) { const f = pending.get(m.id)!; pending.delete(m.id); f(m); return; }
      if (m?.event === "people") void follow().catch(() => {});
    });
    c.on("exit", () => {
      if (child !== c) return;
      child = null; hostId = ""; ownerToken = ""; port = 0;
      member?.helper.stop(); member = null; enrol?.stop(); enrol = null;
    });
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("The Cloud did not start")), 15_000);
      c.once("message", () => { clearTimeout(t); resolve(); });
      c.once("exit", () => { clearTimeout(t); reject(new Error("The Cloud stopped while starting")); });
    });
    // The tunnel keys first: the Cloud's id is derived from the enrolment tunnel's public key.
    const bin = helperPath();
    if (bin) { try { keys = await loadKeys(bin); } catch (e) { tunnelError = (e as Error).message; } }
    const r = await ask("start", { label: opts.label, ...(keys ? { hostId: hostIdFor(keys.enrol.public) } : {}) });
    if (!(await ownsPort(c.pid!, r.port))) { c.kill("SIGKILL"); throw new Error("Another program is using the Cloud's port"); }
    port = r.port; hostId = r.hostId; ownerToken = r.ownerToken;
    await follow();
  })();
  try { await starting; } catch (e) { stopChild(); throw e; } finally { starting = null; }
}

function stopChild(): void {
  member?.helper.stop(); member = null;
  enrol?.stop(); enrol = null;
  const c = child;
  child = null; hostId = ""; ownerToken = ""; port = 0; people = [];
  if (c) { try { c.disconnect(); } catch { /* gone */ } setTimeout(() => { try { c.kill("SIGKILL"); } catch { /* gone */ } }, 3000).unref?.(); }
}

/** Stop hosting: every device token is revoked (members need a new invite), the tunnels and the process stop. */
export async function stopHosting(): Promise<void> {
  if (child) await ask("stop").catch(() => {});
  stopChild();
}

/** Delete hosted data: stops, then removes the Cloud's folder. The tunnel keys stay (they are not data). */
export async function wipeHosting(): Promise<void> {
  if (child) await ask("wipe").catch(() => {});
  stopChild();
  fs.rmSync(hostDir(), { recursive: true, force: true });
}

/** An invite link: the Cloud's name and id, the enrolment tunnel's address and a single-use join code. A secret. */
export async function invite(label: string, role?: string): Promise<string> {
  if (!child) throw new Error("Turn on Host on this Mac first");
  if (!helperPath() || !keys) throw new Error(tunnelError || "This Canvas has no tunnel helper, so no one can join");
  const r = await ask("invite", { label, role });
  await follow();
  if (!enrol?.alive) throw new Error(tunnelError || "The tunnel did not start");
  const q = new URLSearchParams({ v: "1", name: name || "Cloud", host: hostId, tc: keys.enrol.addr, code: r.code });
  return `canvas://cloud/join?${q}`;
}

export async function removePerson(personId: string): Promise<void> {
  await ask("remove", { personId });
  await follow();
}

export async function hostStatus(): Promise<unknown> {
  if (child) await follow().catch(() => {});
  return {
    available: !!helperPath(),
    hosting: !!child,
    hostId: hostId || null,
    port: port || null,
    name,
    fingerprint: keys ? await fingerprint(keys.enrol.addr) : null,
    tunnel: !helperPath() ? "unavailable" : member?.helper.alive ? "up" : child ? (tunnelError ? "error" : "starting") : "off",
    tunnelError: tunnelError || null,
    people: people.map((p) => ({ id: p.id, label: p.label, role: p.role, devices: p.devices, invite: p.invite ?? null })),
  };
}

