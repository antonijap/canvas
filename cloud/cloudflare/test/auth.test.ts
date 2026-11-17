import { beforeAll, describe, expect, it, vi } from "vitest";
import { createAuthenticator } from "../src/auth";

const settings = { ACCESS_TEAM_DOMAIN: "studio.cloudflareaccess.com", ACCESS_AUD: "test-audience" };
const email = "member@example.com";
let keys: CryptoKeyPair;
let jwk: JsonWebKey & { kid: string };
const encode = (value: unknown) => btoa(JSON.stringify(value)).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
async function token(claims: Record<string, unknown> = {}, header: Record<string, unknown> = {}, signingKey?: CryptoKey) {
  const now = Math.floor(Date.now() / 1000);
  const unsigned = `${encode({ alg: "RS256", kid: "current", ...header })}.${encode({
    iss: `https://${settings.ACCESS_TEAM_DOMAIN}`, aud: [settings.ACCESS_AUD],
    exp: now + 300, nbf: now - 30, email, ...claims,
  })}`;
  const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", signingKey ?? keys.privateKey, new TextEncoder().encode(unsigned));
  return `${unsigned}.${btoa(String.fromCharCode(...new Uint8Array(signature))).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_")}`;
}
const request = (jwt: string) => new Request("https://server.example/v1/me", { headers: { "Cf-Access-Jwt-Assertion": jwt } });
beforeAll(async () => {
  keys = await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"]) as CryptoKeyPair;
  jwk = { ...await crypto.subtle.exportKey("jwk", keys.publicKey) as JsonWebKey, kid: "current" };
});

describe("Access identity", () => {
  it("validates RS256 against the configured keys and caches them", async () => {
    const fetcher = vi.fn(async (url: string) => {
      expect(url).toBe(`https://${settings.ACCESS_TEAM_DOMAIN}/cdn-cgi/access/certs`);
      return Response.json({ keys: [jwk] });
    });
    const authenticate = createAuthenticator(fetcher);
    expect(await authenticate(request(await token()), settings)).toEqual({ email, name: "member" });
    expect(await authenticate(request(await token()), settings)).toEqual({ email, name: "member" });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it.each([
    ["wrong audience", { aud: ["other"] }, {}],
    ["wrong issuer", { iss: "https://other.example" }, {}],
    ["expired", { exp: Math.floor(Date.now() / 1000) - 61 }, {}],
    ["not yet valid", { nbf: Math.floor(Date.now() / 1000) + 180 }, {}],
    ["missing expiry", { exp: null }, {}],
    ["missing email", { email: null }, {}],
    ["alg none", {}, { alg: "none" }],
    ["alg HS256", {}, { alg: "HS256" }],
  ])("rejects %s", async (_label, claims, header) => {
    const authenticate = createAuthenticator(async () => Response.json({ keys: [jwk] }));
    expect(await authenticate(request(await token(claims, header)), settings)).toBeNull();
  });
  it("rejects a bad signature", async () => {
    const other = await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"]) as CryptoKeyPair;
    const authenticate = createAuthenticator(async () => Response.json({ keys: [jwk] }));
    expect(await authenticate(request(await token({}, {}, other.privateKey)), settings)).toBeNull();
  });
  it("refetches once on an unknown kid and accepts rotation", async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(Response.json({ keys: [] })).mockResolvedValueOnce(Response.json({ keys: [jwk] }));
    expect(await createAuthenticator(fetcher)(request(await token()), settings)).toEqual({ email, name: "member" });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it("stops after one unknown-kid refetch", async () => {
    const fetcher = vi.fn(async () => Response.json({ keys: [] }));
    expect(await createAuthenticator(fetcher)(request(await token()), settings)).toBeNull();
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it("accepts the clock skew window", async () => {
    const authenticate = createAuthenticator(async () => Response.json({ keys: [jwk] }));
    const now = Math.floor(Date.now() / 1000);
    expect(await authenticate(request(await token({ exp: now - 30, nbf: now + 30 })), settings)).not.toBeNull();
  });
  it.each([
    ["localhost", "1", true], ["127.0.0.1", "1", true],
    ["localhost", undefined, false], ["localhost", "0", false],
    ["server.example", "1", false], ["localhost.example", "1", false],
  ])("gates dev identity on %s with DEV=%s", async (hostname, DEV, allowed) => {
    const fetcher = vi.fn();
    const authenticate = createAuthenticator(fetcher);
    const req = new Request(`http://${hostname}/v1/me`, { headers: { "x-canvas-dev-email": email } });
    expect(await authenticate(req, { ...settings, DEV })).toEqual(allowed ? { email, name: "member" } : null);
    expect(fetcher).not.toHaveBeenCalled();
  });
});
