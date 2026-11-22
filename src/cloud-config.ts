// Which Clouds this Canvas talks to (Settings > Cloud, apps/macos/CloudSettings.swift): any number, each by its own
// address. The shell sends the list with its state like the other settings (src/settings.ts). Only the addresses and,
// for a development address, its email live here; tokens are never part of a setting (src/cloud.ts keeps them in
// memory, the Keychain keeps them on disk). No request leaves this process for an address that is not in the list.
//
// Three kinds of Cloud, never mixed up:
//   access    https://team.example.com    a Worker behind Cloudflare Access (cf-access-token)
//   hosted    canvas-cloud://<host id>     a Cloud hosted on a Mac, known by its id; reached through the tunnel (or
//                                         loopback on the hosting Mac) with a device token. Never an http address.
//   dev       http://localhost, 127.0.0.1  a Worker run with DEV=1 for development (x-canvas-dev-email)

export const isLocalHost = (h: string): boolean => h === "localhost" || h === "127.0.0.1";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** The host id of a hosted Cloud's address (canvas-cloud://<uuid>), or null for any other address. */
export function hostedId(url: string): string | null {
  const m = /^canvas-cloud:\/\/([0-9a-f-]{36})\/?$/i.exec(url.trim());
  return m && UUID.test(m[1].toLowerCase()) ? m[1].toLowerCase() : null;
}
export const hostedUrl = (id: string): string => `canvas-cloud://${id}`;

/** The origin of a Cloud address: https, canvas-cloud://<id>, or http on this machine (development). Else null. */
export function cleanServerUrl(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const id = hostedId(raw);
  if (id) return hostedUrl(id);
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    return null;
  }
  if (u.username || u.password) return null;
  if (u.protocol === "https:" && u.hostname.includes(".")) return u.origin;
  if (u.protocol === "http:" && isLocalHost(u.hostname)) return u.origin;
  return null;
}

/** Local development only: http://localhost or http://127.0.0.1, where a Worker run with DEV=1 takes an email header. */
export function isLocalDev(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === "http:" && isLocalHost(u.hostname);
  } catch {
    return false;
  }
}

/** An invite to a hosted Cloud, as the link carries it. Every part is checked; anything else is null. */
export interface Invite { name: string; hostId: string; addr: string; code: string }
export function parseInvite(raw: unknown): Invite | null {
  if (typeof raw !== "string" || raw.length > 8192) return null;
  let u: URL;
  try { u = new URL(raw.trim()); } catch { return null; }
  if (u.protocol !== "canvas:" || u.host !== "cloud" || u.pathname !== "/join") return null;
  const q = u.searchParams;
  if (q.get("v") !== "1") return null;
  const hostId = (q.get("host") ?? "").toLowerCase();
  const addr = q.get("tc") ?? "";
  const code = q.get("code") ?? "";
  const name = (q.get("name") ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, 60);
  if (!UUID.test(hostId) || !/^tc[A-Za-z0-9_-]{20,4000}$/.test(addr) || !/^ccj_[0-9a-f]{16}\.[A-Za-z0-9_-]{43}$/.test(code)) return null;
  return { name: name || "Cloud", hostId, addr, code };
}

/** The most Clouds one Canvas keeps (Settings > Cloud), and the longest name one takes. The shell has the same limits. */
export const CLOUD_LIMITS = { clouds: 200, name: 60 };

/** One Cloud this Canvas talks to: its canonical address, and for a development address only, the email its DEV mode takes. */
export interface CloudEntry { url: string; devEmail: string }

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Who decides which Clouds this process may talk to:
 *   the shell's list   once the app sent one (even an empty one), it is the whole truth. It comes with a revision
 *                      (`cloudsRev`): a list older than the last one taken is ignored.
 *   the environment    CANVAS_CLOUD_URL (with CANVAS_CLOUD_DEV_EMAIL), only while no shell sent a list: tests, dev.
 *   added here         a Cloud joined or started here (POST /api/cloud/join, /host/start). The shell adds the entry it
 *                      gets back; the addition counts until a list newer than the one in force when it was made.
 *   held back          a Cloud removed here (POST /api/cloud/remove): nothing goes to it until a list newer than the
 *                      one in force at the removal names it again.
 */
let shellList: CloudEntry[] | null = null;
const shellListWaiters = new Set<() => void>();
let shellRev = -Infinity;
const added = new Map<string, { entry: CloudEntry; rev: number }>();
const held = new Map<string, number>();
/** Bumped for a Cloud whenever it is removed or signed out of: work begun before must not finish against it. */
const generations = new Map<string, number>();
const listeners: ((removed: string[], back: string[]) => void)[] = [];

/** A Cloud's work is outdated once its generation moved on (src/cloud.ts checks it after every await). */
export const generation = (url: string): number => generations.get(url) ?? 0;
export function bump(url: string): void { generations.set(url, generation(url) + 1); }

/** src/cloud.ts tears down what belonged to a Cloud that is gone, and wakes the files of one that came back. */
export function onCloudsChanged(fn: (removed: string[], back: string[]) => void): void { listeners.push(fn); }

/** A list as the shell sent it, made safe: canonical addresses, no repeats, at most 200, emails only for development. */
export function cleanCloudList(raw: unknown): CloudEntry[] {
  const out: CloudEntry[] = [];
  const seen = new Set<string>();
  for (const item of Array.isArray(raw) ? raw : []) {
    if (out.length >= CLOUD_LIMITS.clouds) break;
    const o = item && typeof item === "object" ? (item as Record<string, unknown>) : {};
    const url = cleanServerUrl(o.url);
    if (!url || seen.has(url)) continue;
    seen.add(url);
    const email = typeof o.devEmail === "string" ? o.devEmail.trim().toLowerCase() : "";
    out.push({ url, devEmail: isLocalDev(url) && email.length <= 120 && EMAIL.test(email) ? email : "" });
  }
  return out;
}

function envEntry(): CloudEntry | null {
  const url = cleanServerUrl(process.env.CANVAS_CLOUD_URL);
  if (!url) return null;
  const email = (process.env.CANVAS_CLOUD_DEV_EMAIL ?? "").trim().toLowerCase();
  return { url, devEmail: isLocalDev(url) && EMAIL.test(email) ? email : "" };
}

/** Every Cloud this process may talk to now. */
export function cloudConfigs(): CloudEntry[] {
  const env = shellList === null ? envEntry() : null;
  const out = (shellList ?? (env ? [env] : [])).filter((e) => !held.has(e.url));
  for (const { entry } of added.values()) if (!held.has(entry.url) && !out.some((e) => e.url === entry.url)) out.push(entry);
  return out;
}

/** Whether `url` is, exactly (canonical form, port included), one of the Clouds this process may talk to. */
export function isConfigured(url: unknown): url is string {
  return typeof url === "string" && cleanServerUrl(url) === url && cloudConfigs().some((e) => e.url === url);
}

/** A restored native tab can reach a fresh server before the shell posts its Cloud list. */
export function waitForShellCloudList(): Promise<void> {
  if (shellList !== null) return Promise.resolve();
  return new Promise(resolve => {
    const finish = () => {
      clearTimeout(timer);
      shellListWaiters.delete(finish);
      resolve();
    };
    // A request from a browser or a disconnected shell must still finish.
    const timer = setTimeout(finish, 3000).unref();
    shellListWaiters.add(finish);
  });
}

/** The development email for exactly this address, else "". Never another origin's, never a fallback. */
export function devEmailFor(url: string): string {
  if (!isLocalDev(url)) return "";
  return cloudConfigs().find((e) => e.url === url)?.devEmail ?? "";
}

/**
 * What changed between two lists: Clouds gone, Clouds new. A Cloud whose development email changed is both: whoever
 * this Canvas was there is someone else now, so its work, answers and sockets go and it connects again as the new one.
 */
function changed(beforeList: CloudEntry[]): void {
  const nowList = cloudConfigs();
  const now = new Map(nowList.map((e) => [e.url, e.devEmail]));
  const before = new Map(beforeList.map((e) => [e.url, e.devEmail]));
  const removed = [...before.keys()].filter((u) => !now.has(u) || now.get(u) !== before.get(u));
  const back = [...now.keys()].filter((u) => !before.has(u) || now.get(u) !== before.get(u));
  for (const u of removed) bump(u);
  if (removed.length || back.length) for (const fn of listeners) fn(removed, back);
}

/** Whatever the shell sent, made safe. Settings without a `clouds` list leave the Clouds as they are. */
export function setCloudConfig(raw: unknown): void {
  const o = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  if (!Array.isArray(o.clouds)) return;
  const rev = Number(o.cloudsRev);
  const versioned = o.cloudsRev !== undefined && Number.isFinite(rev);
  if (versioned && rev < shellRev) return; // older than the list in force
  const before = cloudConfigs();
  shellList = cleanCloudList(o.clouds);
  if (versioned) {
    // A list newer than the one an addition or a removal was made under has seen it: the list decides from now on.
    for (const [u, a] of added) if (rev > a.rev) added.delete(u);
    // A removal stands until the shell sent a list without that Cloud (it saw the removal). A list it sent before
    // that, even one newer than the removal (another Cloud renamed meanwhile), does not bring it back.
    for (const u of [...held.keys()]) if (!shellList.some((e) => e.url === u)) held.delete(u);
    shellRev = rev;
  } else {
    added.clear();
    held.clear();
  }
  changed(before);
  for (const finish of shellListWaiters) finish();
}

/** A Cloud joined or started here: it counts until the shell's next list (see above). */
export function addCloud(url: string): void {
  const clean = cleanServerUrl(url);
  if (!clean) return;
  const before = cloudConfigs();
  held.delete(clean);
  added.set(clean, { entry: { url: clean, devEmail: "" }, rev: shellRev });
  changed(before);
}

/** A Cloud removed here: nothing goes to it until a newer list names it again. */
export function removeCloud(url: string): void {
  const clean = cleanServerUrl(url);
  if (!clean) return;
  const before = cloudConfigs();
  added.delete(clean);
  held.set(clean, shellRev);
  bump(clean);
  changed(before);
}

/** Tests: back to a process that never heard from a shell. */
export function resetCloudConfig(): void {
  const before = cloudConfigs();
  shellList = null;
  shellRev = -Infinity;
  added.clear();
  held.clear();
  changed(before);
}

export const hostOf = (url: string): string => {
  const id = hostedId(url);
  if (id) return id;
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
};
