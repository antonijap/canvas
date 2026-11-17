export interface AuthSettings {
  ACCESS_TEAM_DOMAIN: string;
  ACCESS_AUD: string;
  DEV?: string;
}
export interface Identity { email: string; name: string }
interface AccessKey extends JsonWebKey { kid: string }
const decoder = new TextDecoder();
const bytes = (text: string) => Uint8Array.from(atob(text.replace(/-/g, "+").replace(/_/g, "/")), c => c.charCodeAt(0));
function identity(value: unknown): Identity | null {
  if (typeof value !== "string" || value.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) return null;
  const email = value.toLowerCase();
  return { email, name: email.slice(0, email.indexOf("@")) };
}

/** The configured Access domain is the only source of trusted keys. */
export function createAuthenticator(fetcher: (url: string) => Promise<Response> = fetch) {
  const cache = new Map<string, { keys: AccessKey[]; until: number }>();
  const pending = new Map<string, Promise<AccessKey[]>>();
  const misses = new Map<string, number>();
  const failures = new Map<string, number>();
  async function load(domain: string): Promise<AccessKey[]> {
    const existing = pending.get(domain);
    if (existing) return existing;
    if ((failures.get(domain) ?? 0) > Date.now()) throw new Error("Access keys retry deferred");
    const task = (async () => {
      const response = await fetcher(`https://${domain}/cdn-cgi/access/certs`);
      if (!response.ok) throw new Error("Access keys unavailable");
      const data = await response.json<{ keys: AccessKey[] }>();
      if (!Array.isArray(data.keys)) throw new Error("Invalid Access keys");
      cache.set(domain, { keys: data.keys, until: Date.now() + 3_600_000 });
      return data.keys;
    })();
    pending.set(domain, task);
    try { return await task; }
    catch (error) { failures.set(domain, Date.now() + 60_000); throw error; }
    finally { pending.delete(domain); }
  }
  return async (request: Request, settings: AuthSettings): Promise<Identity | null> => {
    const hostname = new URL(request.url).hostname;
    if (settings.DEV === "1" && (hostname === "localhost" || hostname === "127.0.0.1")) {
      const devEmail = request.headers.get("x-canvas-dev-email");
      if (devEmail !== null) return identity(devEmail);
    }
    try {
      const jwt = request.headers.get("Cf-Access-Jwt-Assertion");
      if (!jwt || jwt.length > 32_768) return null;
      const parts = jwt.split(".");
      if (parts.length !== 3) return null;
      const [head, body, signature] = parts;
      const header = JSON.parse(decoder.decode(bytes(head)));
      if (header.alg !== "RS256" || typeof header.kid !== "string") return null;
      if (!/^[a-z0-9.-]+\.cloudflareaccess\.com$/i.test(settings.ACCESS_TEAM_DOMAIN) || !settings.ACCESS_AUD) return null;
      const cached = cache.get(settings.ACCESS_TEAM_DOMAIN);
      let keys = cached && cached.until > Date.now() ? cached.keys : await load(settings.ACCESS_TEAM_DOMAIN);
      let key = keys.find(k => k.kid === header.kid);
      if (!key) {
        if ((misses.get(settings.ACCESS_TEAM_DOMAIN) ?? 0) > Date.now()) return null;
        // Record before fetching, including failed refreshes and concurrent unknown kids.
        misses.set(settings.ACCESS_TEAM_DOMAIN, Date.now() + 60_000);
        keys = await load(settings.ACCESS_TEAM_DOMAIN);
        key = keys.find(k => k.kid === header.kid);
      }
      if (!key || key.kty !== "RSA" || (key.alg && key.alg !== "RS256") || (key.use && key.use !== "sig")) return null;
      const publicKey = await crypto.subtle.importKey("jwk", key, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
      const valid = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", publicKey, bytes(signature), new TextEncoder().encode(`${head}.${body}`));
      if (!valid) return null;
      const claims = JSON.parse(decoder.decode(bytes(body)));
      const now = Date.now() / 1000;
      const audience = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
      if (claims.iss !== `https://${settings.ACCESS_TEAM_DOMAIN}` || !audience.includes(settings.ACCESS_AUD)) return null;
      if (typeof claims.exp !== "number" || !Number.isFinite(claims.exp) || now > claims.exp + 60) return null;
      if (claims.nbf !== undefined && (typeof claims.nbf !== "number" || !Number.isFinite(claims.nbf) || claims.nbf > now + 60)) return null;
      return identity(claims.email);
    } catch { return null; }
  };
}
export const authenticate = createAuthenticator();
