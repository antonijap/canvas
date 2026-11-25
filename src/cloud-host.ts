// Host on this Mac, on the editor server's side: up to eight Clouds hosted here at once (one per team), each its own
// process (cloud/adapters/mac/main.ts) on its own 127.0.0.1 port, with its own data folder, people, invites and tunnel keys,
// known by its host id. This Canvas joins each as its owner with a device token that never leaves this process. The
// editor server itself stays on 127.0.0.1:5189 and is never reachable through a Cloud's port or its tunnels.
//
// Where each hosted Cloud lives (a "slot"):
//   main        the first one, where a single hosted Cloud always lived: <state>/cloud-host, Keychain `host:keys`
//   <8 hex>     every other: <state>/cloud-hosts/<slot>, Keychain `host:keys:<slot>`
// <state>/cloud-hosts.json maps each slot to its host id (not a secret: the id is in every invite and comments.json).
// A Cloud's id comes from its enrolment tunnel's public key, so a slot keeps its id across restarts and wipes.
//
// Two tunnels per Cloud, both serving that Cloud's port only (the helper takes ports 5190-5197, never 5189):
//   member     lets in the tunnel keys of enrolled devices only; restarted with the new list when people change.
//   enrolment  runs only while a join code is waiting; anyone holding its address reaches the Cloud, where nothing
//              but POST /v1/join with a valid code answers without a device token.
//
// Routes (127.0.0.1:5189, POST needs x-canvas: 1 and JSON); `hostId` picks the Cloud (left out: the only one running):
//   GET  /api/cloud/host                     { available, hosting, clouds: [ status of each hosted Cloud ] }
//   GET  /api/cloud/host?hostId=             { available, hosting, hostId, fingerprint, tunnel, people, ... }
//   POST /api/cloud/host/start  { name, label, hostId? }  hostId: start that Cloud again; none: a new Cloud
//   POST /api/cloud/host/stop   { hostId }   every device token is revoked, the tunnels stop
//   POST /api/cloud/host/wipe   { hostId }   Delete hosted data
//   POST /api/cloud/host/invite { hostId, label, role }  -> { link }   (a secret: the app copies it, never shows it)
//   POST /api/cloud/host/remove { hostId, personId }

import { fork, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import { createSecret, deleteSecret, readSecretStrict } from "./cloud-secrets.ts";
import { fingerprint, genkey, helperPath, hostIdFor, isTunnelAddr, ownsPort, serve, type Helper } from "./cloud-tunnel.ts";
import { stateDir } from "./usage-counts.ts";

const MAIN = path.join(import.meta.dirname, "..", "cloud", "adapters", "mac", "main.ts");
/** The first hosted Cloud's folder (where the only one always was). */
export const hostDir = () => path.join(stateDir(), "cloud-host");
const SLOT = /^(main|[0-9a-f]{8})$/;
const dirOf = (slot: string) => (slot === "main" ? hostDir() : path.join(stateDir(), "cloud-hosts", slot));
const keysAccount = (slot: string) => (slot === "main" ? "host:keys" : `host:keys:${slot}`);
const indexFile = () => path.join(stateDir(), "cloud-hosts.json");
const keychainReadError = "Couldn't read this Cloud's keys from the Keychain. Unlock the Keychain and try again.";
const hostIdentityError = "This Cloud's saved identities do not match.";
/** The ports a hosted Cloud may take: the tunnel helper serves these and no other (cloud/tunnel/main.go). */
export const HOST_PORTS = { first: 5190, last: 5197 };
/** The most Clouds one Mac hosts (running or kept): one port each. */
export const MAX_HOSTED = 8;

interface TunnelKey { key: unknown; addr: string; public: string }
interface HostKeys { member: TunnelKey; enrol: TunnelKey }
interface Person { id: string; label: string; role: string; devices: { id: string; name: string; joinedAt: string }[]; invite?: { expiresAt: string } }

function parseKeys(raw: string): HostKeys {
  try {
    const keys = JSON.parse(raw);
    const valid = (k: TunnelKey | undefined) =>
      k?.key && isTunnelAddr(k.addr) && typeof k.public === "string" && /^nodekey:[0-9a-f]{64}$/.test(k.public);
    if (valid(keys?.member) && valid(keys?.enrol)) return keys;
  } catch { /* Report the invalid value without exposing it. */ }
  throw new Error("This Cloud's keys are invalid.");
}

/** The slot -> host id index, read fresh each time (it is tiny). */
function readIndex(): Record<string, string> {
  try {
    const o = JSON.parse(fs.readFileSync(indexFile(), "utf8"));
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(o ?? {})) if (SLOT.test(k) && typeof v === "string" && /^[0-9a-f-]{36}$/.test(v)) out[k] = v;
    return out;
  } catch { return {}; }
}
function writeIndex(ix: Record<string, string>): void {
  fs.mkdirSync(stateDir(), { recursive: true });
  const tmp = `${indexFile()}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(ix), { mode: 0o600 });
  fs.renameSync(tmp, indexFile());
}

/** One hosted Cloud: its process, its tunnels, its people. */
class HostedCloud {
  child: ChildProcess | null = null;
  starting: Promise<void> | null = null;
  port = 0;
  hostId = "";
  ownerToken = "";
  name = "";
  keys: HostKeys | null = null;
  member: { helper: Helper; allow: string } | null = null;
  enrol: Helper | null = null;
  people: Person[] = [];
  tunnelError = "";
  private pending = new Map<number, (m: any) => void>();
  private seq = 0;
  private following: Promise<void> | null = null;
  private followingRun: { child: ChildProcess | null; again: boolean } | null = null;

  readonly slot: string;
  constructor(slot: string) { this.slot = slot; }

  ask(op: string, args: Record<string, unknown> = {}, ms = 10_000): Promise<any> {
    const c = this.child;
    if (!c?.connected) return Promise.reject(new Error("Not hosting"));
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => { this.pending.delete(id); reject(new Error("The Cloud did not answer")); }, ms);
      t.unref?.();
      this.pending.set(id, (m) => { clearTimeout(t); m.ok ? resolve(m.result) : reject(Object.assign(new Error(m.error?.message ?? "The Cloud refused"), { code: m.error?.code })); });
      c.send({ id, op, ...args });
    });
  }

  private knownHostId(): string | undefined {
    const ids = [this.hostId, readIndex()[this.slot], keptHostId(this.slot)].filter((id): id is string => !!id);
    if (ids.some((id) => id !== ids[0])) throw new Error(hostIdentityError);
    return ids[0];
  }

  async loadKeys(bin: string): Promise<HostKeys> {
    const account = keysAccount(this.slot);
    const stored = await readSecretStrict(account);
    if (stored.status === "failed") throw new Error(keychainReadError);
    const known = this.knownHostId();
    if (stored.status === "found") {
      const keys = parseKeys(stored.value);
      const id = hostIdFor(keys.enrol.public);
      if (known && known !== id) throw new Error("The keys do not match this Cloud.");
      return keys;
    }
    if (known) throw new Error("This Cloud's keys are missing from the Keychain.");
    const m = await genkey(bin, "server"), e = await genkey(bin, "server");
    const raw = JSON.stringify({ member: m, enrol: e });
    const k = parseKeys(raw);
    if (!(await createSecret(account, raw))) throw new Error("Could not create this Cloud's tunnel keys in the Keychain. The item may already exist or the Keychain may be locked.");
    return k;
  }

  /**
   * The tunnels follow the people: the member tunnel's allow list, and the enrolment tunnel while a code waits. One run
   * at a time: a call during a run asks for one more run after it (and waits for that), so two helpers can never be
   * started for the same tunnel, and the last run always sees the latest people.
   */
  follow(): Promise<void> {
    // A run left from a process that has stopped since does not hold up the new one.
    if (this.following && this.followingRun?.child === this.child) { this.followingRun.again = true; return this.following; }
    const state = { child: this.child, again: false };
    this.followingRun = state;
    const run: Promise<void> = (async () => {
      try {
        do { state.again = false; await this.followOnce(); } while (state.again && this.child && this.child === state.child);
      } finally { if (this.following === run!) this.following = null; }
    })();
    this.following = run;
    return run;
  }

  /** The process went: whatever waited for its answer is told so at once (not after the 10 s timeout). */
  dropPending(): void {
    const waiting = [...this.pending.values()];
    this.pending.clear();
    for (const f of waiting) f({ ok: false, error: { message: "Not hosting" } });
  }

  private async followOnce(): Promise<void> {
    // The process and port this run is for. A run that outlives them (Stop, then Start again on another port) must
    // not install a tunnel to the old port, which another Cloud may have taken since: after every await it checks.
    const c = this.child, port = this.port;
    if (!c) return;
    const stale = () => this.child !== c || this.port !== port;
    const r = await this.ask("people");
    if (stale()) return;
    this.people = r.people;
    const bin = helperPath();
    if (!bin || !this.keys) return;
    try {
      const allow = JSON.stringify(r.keys);
      if (!this.member || !this.member.helper.alive || this.member.allow !== allow) {
        // The old one stops before the new one starts: never two, and never an old allow list left running.
        const old = this.member;
        this.member = null;
        old?.helper.stop();
        const s = await serve(bin, this.keys.member.key, r.keys, port);
        if (stale()) { s.helper.stop(); return; }
        this.member = { helper: s.helper, allow };
        s.helper.onExit = () => { if (this.member?.helper === s.helper) { this.member = null; setTimeout(() => void this.follow().catch(() => {}), 2000).unref?.(); } };
        await this.ask("config", { memberAddr: s.addr, memberKey: this.keys.member.public });
        if (stale()) return;
      }
      if (r.pending > 0 && !this.enrol?.alive) {
        const s = await serve(bin, this.keys.enrol.key, null, port);
        if (stale()) { s.helper.stop(); return; }
        this.enrol?.stop();
        this.enrol = s.helper;
      } else if (r.pending === 0 && this.enrol) { this.enrol.stop(); this.enrol = null; }
      this.tunnelError = "";
    } catch (e) {
      if (!stale()) this.tunnelError = (e as Error).message;
    }
  }

  async start(opts: { name: string; label: string }): Promise<void> {
    this.name = opts.name.slice(0, 60);
    if (this.child) { await this.follow(); return; }
    if (this.starting) return this.starting;
    this.tunnelError = "";
    this.starting = (async () => {
      const port = await freePort();
      // Check the keys before the worker opens its database and can assign a host id.
      const bin = helperPath();
      if (bin) {
        try { this.keys = await this.loadKeys(bin); }
        catch (e) { this.tunnelError = (e as Error).message; throw e; }
      }
      const known = this.knownHostId();
      const expected = bin && this.keys ? hostIdFor(this.keys.enrol.public) : known;
      if (known && expected !== known) throw new Error(hostIdentityError);
      const env = { ...process.env, CANVAS_CLOUD_HOST_DIR: dirOf(this.slot), CANVAS_CLOUD_HOST_PORT: String(port), CANVAS_CLOUD_HOST_ID: expected ?? "" };
      const c = fork(MAIN, [], { env, stdio: ["ignore", "ignore", "ignore", "ipc"], execArgv: [] });
      this.child = c;
      c.on("message", (m: any) => {
        if (m?.id && this.pending.has(m.id)) { const f = this.pending.get(m.id)!; this.pending.delete(m.id); f(m); return; }
        if (m?.event === "people") void this.follow().catch(() => {});
      });
      c.on("exit", () => {
        if (this.child !== c) return;
        this.child = null; this.ownerToken = ""; this.port = 0;
        this.member?.helper.stop(); this.member = null; this.enrol?.stop(); this.enrol = null;
        this.dropPending();
      });
      await new Promise<void>((resolve, reject) => {
        const t = setTimeout(() => reject(new Error("The Cloud did not start")), 15_000);
        c.once("message", () => { clearTimeout(t); resolve(); });
        c.once("exit", () => { clearTimeout(t); reject(new Error("The Cloud stopped while starting")); });
      });
      const r = await this.ask("start", { label: opts.label });
      if (!(await ownsPort(c.pid!, r.port))) { c.kill("SIGKILL"); throw new Error("Another program is using the Cloud's port"); }
      const current = this.knownHostId();
      const ix = readIndex();
      if ([expected, current, ix[this.slot]].some((id) => id && id !== r.hostId)) throw new Error(hostIdentityError);
      if (!ix[this.slot]) { ix[this.slot] = r.hostId; writeIndex(ix); }
      this.port = r.port; this.hostId = r.hostId; this.ownerToken = r.ownerToken;
      await this.follow();
    })();
    try { await this.starting; } catch (e) { this.stopChild(); throw e; } finally { this.starting = null; }
  }

  stopChild(): void {
    this.member?.helper.stop(); this.member = null;
    this.enrol?.stop(); this.enrol = null;
    const c = this.child;
    this.child = null; this.ownerToken = ""; this.port = 0; this.people = [];
    this.dropPending();
    if (c) { try { c.disconnect(); } catch { /* gone */ } setTimeout(() => { try { c.kill("SIGKILL"); } catch { /* gone */ } }, 3000).unref?.(); }
  }

  async status(): Promise<Record<string, unknown>> {
    if (this.child) await this.follow().catch(() => {});
    return {
      available: !!helperPath(),
      hosting: !!this.child,
      hostId: this.hostId || null,
      port: this.port || null,
      name: this.name,
      // The first slot, where the single hosted Cloud of older versions lives: the app adds it to its list if missing.
      legacy: this.slot === "main",
      fingerprint: this.keys ? await fingerprint(this.keys.enrol.addr) : null,
      tunnel: !helperPath() ? "unavailable" : this.tunnelError ? "error" : this.member?.helper.alive ? "up" : this.child ? "starting" : "off",
      tunnelError: this.tunnelError || null,
      people: this.people.map((p) => ({ id: p.id, label: p.label, role: p.role, devices: p.devices, invite: p.invite ?? null })),
    };
  }
}

/** A free port for a Cloud: CANVAS_CLOUD_HOST_PORT when set (tests: 0, a free one), else the first free in the range. */
async function freePort(): Promise<number> {
  if (process.env.CANVAS_CLOUD_HOST_PORT !== undefined) return Number(process.env.CANVAS_CLOUD_HOST_PORT);
  const taken = new Set([...clouds.values()].map((c) => c.port).filter(Boolean));
  for (let p = HOST_PORTS.first; p <= HOST_PORTS.last; p++) {
    if (taken.has(p)) continue;
    const free = await new Promise<boolean>((resolve) => {
      const s = net.createServer();
      s.once("error", () => resolve(false));
      s.listen(p, "127.0.0.1", () => s.close(() => resolve(true)));
    });
    if (free) return p;
  }
  throw new Error(`This Mac hosts ${MAX_HOSTED} Clouds at most`);
}

/** The hosted Clouds this process knows, by slot. */
const clouds = new Map<string, HostedCloud>();
const cloudOf = (slot: string) => { let c = clouds.get(slot); if (!c) { c = new HostedCloud(slot); clouds.set(slot, c); } return c; };

/** Read a kept identity without creating a database. */
function keptHostId(slot: string): string | null {
  let db: DatabaseSync | undefined;
  try {
    const file = path.join(dirOf(slot), "team.sqlite");
    if (!fs.existsSync(file)) return null;
    db = new DatabaseSync(file, { readOnly: true });
    const row = db.prepare("SELECT host_id FROM host WHERE id = 1").get();
    return typeof row?.host_id === "string" && /^[0-9a-f-]{36}$/.test(row.host_id) ? row.host_id : null;
  } catch { return null; } finally { db?.close(); }
}

function keptIdentities(): Record<string, string> {
  let dirs: string[] = [];
  try { dirs = fs.readdirSync(path.join(stateDir(), "cloud-hosts")).filter((slot) => slot !== "main" && SLOT.test(slot)); }
  catch { /* There may be no secondary slots. */ }
  const ids: Record<string, string> = {};
  for (const slot of ["main", ...dirs]) {
    const id = keptHostId(slot);
    if (id) ids[slot] = id;
  }
  return ids;
}

/** The first Cloud may have only keys, from before the index. */
async function legacyMainId(): Promise<string | null> {
  const stored = await readSecretStrict(keysAccount("main"));
  if (stored.status === "failed") throw new Error(keychainReadError);
  if (stored.status === "found") {
    try { return hostIdFor(JSON.parse(stored.value).enrol.public); } catch { /* No usable identity. */ }
  }
  return null;
}

/** Find an identity in memory, the index, a kept database or the first Cloud's legacy keys. */
async function slotOf(hostId: string): Promise<string | null> {
  const id = hostId.toLowerCase();
  for (const c of clouds.values()) if (c.hostId === id) return c.slot;
  const indexed = readIndex();
  for (const [slot, h] of Object.entries(indexed)) if (h === id) return slot;
  const kept = keptIdentities();
  for (const [slot, h] of Object.entries(kept)) if (h === id) return slot;
  if (indexed.main || kept.main || clouds.get("main")?.hostId) return null;
  return (await legacyMainId()) === id ? "main" : null;
}

/** Every slot this Mac keeps: the index, the ones started in this run, and the first one if its keys or folder exist. */
async function knownSlots(): Promise<Set<string>> {
  const out = new Set([...Object.keys(readIndex()), ...Object.keys(keptIdentities())]);
  for (const c of clouds.values()) if (c.hostId || c.child || c.starting) out.add(c.slot);
  if (fs.existsSync(hostDir())) out.add("main");
  if (!out.has("main")) {
    const stored = await readSecretStrict(keysAccount("main"));
    if (stored.status === "failed") throw new Error(keychainReadError);
    if (stored.status === "found") out.add("main");
  }
  return out;
}

/** A slot for a new Cloud: the first one while it was never used, else a new one. At most MAX_HOSTED in all. */
async function newSlot(): Promise<string> {
  const known = await knownSlots();
  if (known.size >= MAX_HOSTED) throw new Error(`This Mac hosts ${MAX_HOSTED} Clouds at most. Delete one first.`);
  if (!known.has("main")) return "main";
  let slot: string;
  do { slot = randomBytes(4).toString("hex"); } while (known.has(slot) || fs.existsSync(dirOf(slot)));
  return slot;
}

/** The running Cloud a call means: by host id, or with none given, the only one running. */
function running(hostId?: string | null): HostedCloud | null {
  const live = [...clouds.values()].filter((c) => c.child);
  if (hostId) return live.find((c) => c.hostId === hostId.toLowerCase()) ?? null;
  return live.length === 1 ? live[0] : null;
}

/** What the hosting Canvas uses to reach a Cloud it hosts: loopback, its own device token. Null when not hosting it. */
export function localHost(hostId?: string | null): { hostId: string; origin: string; token: string } | null {
  const c = running(hostId);
  return c && c.hostId && c.ownerToken && c.port ? { hostId: c.hostId, origin: `http://127.0.0.1:${c.port}`, token: c.ownerToken } : null;
}

/** Whether this Mac hosts (or ever hosted, in a slot it keeps) the Cloud with this id. */
export async function hostsHere(hostId: string): Promise<boolean> { return (await slotOf(hostId)) !== null; }

export function hosting(): boolean { return [...clouds.values()].some((c) => !!c.child); }

/** The helpers one hosted Cloud runs now, and the allow list its member tunnel was started with (tests). */
export function hostHelpers(hostId?: string): { member: number | null; enrol: number | null; allow: string[] | null } {
  const c = running(hostId);
  return {
    member: c?.member?.helper.alive ? c.member.helper.child.pid ?? null : null,
    enrol: c?.enrol?.alive ? c.enrol.child.pid ?? null : null,
    allow: c?.member ? JSON.parse(c.member.allow) : null,
  };
}

/**
 * Discovery, start, stop and delete run one at a time: two new Clouds at once must not get the same slot or port, and a Delete
 * must not run while a start of the same Cloud is half done (the start would bring back what Delete removed).
 */
let chain: Promise<unknown> = Promise.resolve();
function serial<T>(fn: () => Promise<T>): Promise<T> {
  const run = chain.catch(() => {}).then(fn);
  chain = run;
  return run;
}

/**
 * Starts hosting: with a host id, that Cloud again (its people and data as they were); without one, a new Cloud in a
 * slot of its own (at most MAX_HOSTED). Returns the Cloud's host id.
 */
export function startHosting(opts: { name: string; label: string; hostId?: string | null }): Promise<string> {
  return serial(() => startOnce(opts));
}

async function startOnce(opts: { name: string; label: string; hostId?: string | null }): Promise<string> {
  let slot: string | null;
  if (opts.hostId) {
    slot = await slotOf(opts.hostId);
    if (!slot) throw new Error("This Mac does not host that Cloud");
  } else {
    slot = await newSlot();
  }
  const c = cloudOf(slot);
  if (opts.hostId && !c.hostId) c.hostId = opts.hostId.toLowerCase();
  await c.start({ name: opts.name, label: opts.label });
  return c.hostId;
}

/** Stop hosting a Cloud: every device token is revoked (members need a new invite), its tunnels and process stop. */
export function stopHosting(hostId?: string | null): Promise<void> {
  return serial(async () => {
    const list = [...clouds.values()].filter((c) => !hostId || c.hostId === hostId.toLowerCase());
    for (const c of list) {
      if (c.child) await c.ask("stop").catch(() => {});
      c.stopChild();
      c.tunnelError = "";
    }
  });
}

/**
 * Delete a hosted Cloud: stops it (every token revoked), removes its folder, and forgets its slot and tunnel keys, so
 * nothing of it is left on this Mac and a new Cloud never takes its id. Throws when the folder could not be removed.
 */
export function wipeHosting(hostId?: string | null): Promise<void> {
  return serial(async () => {
    const slot = hostId ? await slotOf(hostId) : running(null)?.slot ?? null;
    if (!slot) throw new Error("This Mac does not host that Cloud");
    const c = cloudOf(slot);
    if (c.child) await c.ask("wipe").catch(() => {});
    c.stopChild();
    fs.rmSync(dirOf(slot), { recursive: true, force: true });
    if (fs.existsSync(dirOf(slot))) throw new Error("Could not delete the Cloud's data on this Mac");
    const ix = readIndex();
    if (slot in ix) { delete ix[slot]; writeIndex(ix); }
    await deleteSecret(keysAccount(slot));
    clouds.delete(slot);
  });
}

/** An invite link: the Cloud's name and id, the enrolment tunnel's address and a single-use join code. A secret. */
export async function invite(label: string, role?: string, hostId?: string | null): Promise<string> {
  const c = running(hostId);
  if (!c) throw new Error("Turn on Host on this Mac first");
  if (!helperPath() || !c.keys) throw new Error(c.tunnelError || "This Canvas has no tunnel helper, so no one can join");
  const r = await c.ask("invite", { label, role });
  await c.follow();
  if (!c.enrol?.alive) throw new Error(c.tunnelError || "The tunnel did not start");
  const q = new URLSearchParams({ v: "1", name: c.name || "Cloud", host: c.hostId, tc: c.keys.enrol.addr, code: r.code });
  return `canvas://cloud/join?${q}`;
}

export async function removePerson(personId: string, hostId?: string | null): Promise<void> {
  const c = running(hostId);
  if (!c) throw new Error("Not hosting");
  await c.ask("remove", { personId });
  await c.follow();
}

/** One hosted Cloud's status, by host id, or the only one running. */
export async function hostStatus(hostId?: string | null): Promise<Record<string, unknown>> {
  const c = await serial(async () => {
    if (!hostId) return running(null);
    const slot = await slotOf(hostId).catch(() => null);
    const c = slot ? cloudOf(slot) : null;
    if (c && !c.hostId) c.hostId = hostId.toLowerCase();
    return c;
  });
  // Discovery mutates the slot map; polling tunnels does not, and must not hold up Stop or Delete.
  if (c) return c.status();
  return { available: !!helperPath(), hosting: false, hostId: null, port: null, name: "", fingerprint: null, tunnel: helperPath() ? "off" : "unavailable", tunnelError: null, people: [] };
}

/**
 * Every Cloud this Mac hosts or keeps a slot for, running or not: { available, hosting, max, clouds: [...] }. The
 * first slot is listed from its keys too, so a Cloud hosted (or stopped) by an older version is never lost.
 */
export async function hostStatusAll(): Promise<{ available: boolean; hosting: boolean; max: number; clouds: Record<string, unknown>[] }> {
  const known = await serial(async () => {
    const ix = readIndex();
    const knownIds = { ...keptIdentities(), ...ix };
    for (const [slot, id] of Object.entries(knownIds)) { const c = cloudOf(slot); if (!c.hostId) c.hostId = id; }
    if (!knownIds.main) {
      const id = await legacyMainId().catch(() => null);
      if (id) { const c = cloudOf("main"); if (!c.hostId) c.hostId = id; ix.main = id; writeIndex(ix); }
    }
    return [...clouds.values()].filter((c) => c.hostId);
  });
  const list = await Promise.all(known.map((c) => c.status()));
  return { available: !!helperPath(), hosting: hosting(), max: MAX_HOSTED, clouds: list };
}
