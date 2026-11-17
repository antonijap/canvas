// Which team server this Canvas talks to (Settings > Cloud, apps/macos/CloudSettings.swift). The shell sends it with
// its state like the other settings (src/settings.ts). Only the address and the local-development email live here;
// the sign-in token is never part of a setting (src/cloud.ts keeps it in memory, the shell keeps it in the Keychain).

export const isLocalHost = (h: string): boolean => h === "localhost" || h === "127.0.0.1";

/** The origin of a team server address: https, or http on this machine (for development). Anything else is null. */
export function cleanServerUrl(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
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

/** Local development only: http://localhost or http://127.0.0.1, where a server run with DEV=1 takes an email header. */
export function isLocalDev(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === "http:" && isLocalHost(u.hostname);
  } catch {
    return false;
  }
}

let current = { url: "", devEmail: "" };

/** Whatever the shell sent, made safe. */
export function setCloudConfig(raw: unknown): void {
  const o = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const email = typeof o.cloudDevEmail === "string" ? o.cloudDevEmail.trim().toLowerCase() : "";
  current = { url: cleanServerUrl(o.cloudUrl) ?? "", devEmail: /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : "" };
}

/** The configured server, with the environment (CANVAS_CLOUD_URL, CANVAS_CLOUD_DEV_EMAIL) filling what the app did not set. */
export function cloudConfig(): { url: string; devEmail: string } {
  return {
    url: current.url || cleanServerUrl(process.env.CANVAS_CLOUD_URL) || "",
    devEmail: current.devEmail || (process.env.CANVAS_CLOUD_DEV_EMAIL ?? "").trim().toLowerCase(),
  };
}

export const hostOf = (url: string): string => {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
};
