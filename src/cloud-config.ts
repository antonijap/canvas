// Which Cloud this Canvas talks to (Settings > Cloud, apps/macos/CloudSettings.swift). The shell sends it with its
// state like the other settings (src/settings.ts). Only the address and the local-development email live here; tokens
// are never part of a setting (src/cloud.ts keeps them in memory, the Keychain keeps them on disk).
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

let current = { url: "", devEmail: "" };
let joined = "";

/** Whatever the shell sent, made safe. */
export function setCloudConfig(raw: unknown): void {
  const o = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const email = typeof o.cloudDevEmail === "string" ? o.cloudDevEmail.trim().toLowerCase() : "";
  const url = cleanServerUrl(o.cloudUrl) ?? "";
  current = { url, devEmail: /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) && isLocalDev(url) ? email : "" };
  if (url) joined = "";
}

/** A Cloud just joined here: it is the configured one until the shell's next state says otherwise. */
export function setJoined(url: string): void { joined = url; }

/** The configured Cloud, with the environment (CANVAS_CLOUD_URL, CANVAS_CLOUD_DEV_EMAIL) filling what the app did not set. */
export function cloudConfig(): { url: string; devEmail: string } {
  const url = current.url || joined || cleanServerUrl(process.env.CANVAS_CLOUD_URL) || "";
  return {
    url,
    devEmail: isLocalDev(url) ? current.devEmail || (process.env.CANVAS_CLOUD_DEV_EMAIL ?? "").trim().toLowerCase() : "",
  };
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
