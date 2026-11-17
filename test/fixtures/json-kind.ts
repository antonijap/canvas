// Test-only widget kind: a number from any JSON endpoint (GET a URL, pick a value with a path). It was the
// "App value" card; Canvas dropped it for the PostHog card, but it still drives the generic source, secret,
// trust and HTTP tests, which need a kind with a URL, headers and auth of its own. Tests registerKind() it.

import { bad, bool, extras, int, isObject, obj, oneOf, str } from "../../src/widgets/check.ts";
import { deltaOf, formatValue, FORMAT_RE } from "../../src/widgets/format.ts";
import { checkStaticHeaders } from "../../src/widgets/http.ts";
import { evalPath, parsePath } from "../../src/widgets/jsonpath.ts";
import { parseRef } from "../../src/widgets/keychain.ts";
import { WidgetError, type Config, type SourceData, type WidgetKind } from "../../src/widgets/types.ts";

const KNOWN = ["url", "path", "sparkPath", "label", "format", "unit", "auth", "headers", "refreshSec", "trail"];
const AUTH_HEADER_NO = /^(cookie|host|content-length|connection|transfer-encoding|proxy-.*)$/i;

// In memory only: the last 60 samples per widget, for widgets that keep a trail instead of a sparkPath.
const trails = new Map<string, number[]>();

const asNumber = (v: unknown): number | undefined => {
  if (typeof v === "number") return Number.isFinite(v) ? v : undefined;
  if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) return Number(v);
  return undefined;
};

function pathField(v: unknown, field: string, wildcard: boolean): string | undefined {
  const s = str(v, field, "", 200);
  if (!s) return undefined;
  try {
    parsePath(s, { wildcard });
  } catch (e) {
    throw bad(field, `is not a valid path (${(e as Error).message})`);
  }
  return s;
}

function cleanAuth(v: unknown): Config {
  const a = obj(v, "auth");
  const type = oneOf(a.type, "auth.type", "none", ["none", "bearer", "header"] as const);
  const out: Config = { type };
  if (type === "none") return out;
  if (a.secret !== undefined && a.secret !== null) {
    const ref = parseRef(a.secret);
    if (!ref) throw bad("auth.secret", "needs a service and an account of letters, digits and . _ @ : -");
    out.secret = ref;
  }
  if (type === "header") {
    const h = str(a.header, "auth.header", "", 60);
    if (h && (!/^[A-Za-z0-9-]+$/.test(h) || AUTH_HEADER_NO.test(h))) throw bad("auth.header", "is not an allowed header name");
    if (h) out.header = h;
  }
  return out;
}

export const json: WidgetKind = {
  id: "json",
  title: "JSON value",
  symbol: "gauge.with.dots.needle.67percent",
  defaultSize: { w: 220, h: 140 },
  minSize: { w: 140, h: 90 },
  defaults: () => ({ url: "", path: "$", label: "", format: "auto", unit: "", auth: { type: "none" }, refreshSec: 30, trail: false }),
  validate(c: Config): Config {
    const url = str(c.url, "url", "", 2000);
    if (url) {
      let u: URL;
      try {
        u = new URL(url);
      } catch {
        throw bad("url", "is not a valid URL");
      }
      if (u.protocol !== "http:" && u.protocol !== "https:") throw bad("url", "must start with http:// or https://");
      if (u.username || u.password) throw bad("url", "must not contain a user name or password");
    }
    const format = str(c.format, "format", "auto", 20);
    if (!FORMAT_RE.test(format)) throw bad("format", "must be auto, integer, compact, percent, duration or currency:XXX");
    const out: Config = { url, path: pathField(c.path, "path", false) ?? "$" };
    const spark = pathField(c.sparkPath, "sparkPath", true);
    if (spark) out.sparkPath = spark;
    Object.assign(out, { label: str(c.label, "label", "", 120), format, unit: str(c.unit, "unit", "", 16), auth: cleanAuth(c.auth) });
    const headers = obj(c.headers, "headers");
    if (Object.keys(headers).length) {
      if (Object.keys(headers).length > 10) throw bad("headers", "can hold at most 10 headers");
      const h: Record<string, string> = {};
      for (const [k, v] of Object.entries(headers)) h[k] = typeof v === "string" ? v : String(v);
      checkStaticHeaders(h);
      out.headers = h;
    }
    Object.assign(out, { refreshSec: int(c.refreshSec, "refreshSec", 30, 5, 3600), trail: bool(c.trail, "trail", false), ...extras(c, KNOWN) });
    return out;
  },
  fields: [
    { key: "url", label: "URL", type: "url", help: "GET only. Local apps and your network are fine." },
    { key: "path", label: "Value path", type: "text", help: "For example $.stats.users or $.items[-1].count" },
    { key: "sparkPath", label: "Chart path", type: "text", help: "An array of numbers, for example $.days[*].count" },
    { key: "label", label: "Label", type: "text" },
    { key: "format", label: "Format", type: "text", help: "auto, integer, compact, percent, duration or currency:USD" },
    { key: "unit", label: "Unit", type: "text" },
    {
      key: "auth.type",
      label: "Authentication",
      type: "select",
      options: [{ value: "none", label: "None" }, { value: "bearer", label: "Bearer token" }, { value: "header", label: "Custom header" }],
    },
    { key: "auth.header", label: "Header name", type: "text" },
    { key: "auth.secret", label: "Secret", type: "secret", help: "Saved in the Keychain, never in the file." },
    { key: "refreshSec", label: "Refresh (seconds)", type: "number" },
    { key: "trail", label: "Chart the last samples", type: "bool", help: "Keeps the last 60 values in memory when there is no chart path." },
  ],
  source: {
    key: (c) => JSON.stringify([c.url, c.path, c.sparkPath, c.label, c.format, c.unit, c.auth, c.headers, c.trail]),
    minIntervalSec: 5,
    intervalSec: (c) => Number(c.refreshSec) || 30,
    secretUse(c) {
      const a = c.auth as { type?: string; secret?: { service: string; account: string } };
      if (!a || a.type === "none" || !a.secret || typeof c.url !== "string" || !c.url) return undefined;
      return { ref: a.secret, origin: new URL(c.url).origin };
    },
    async fetch(ctx): Promise<SourceData> {
      const c = ctx.widget.config;
      const url = String(c.url ?? "");
      if (!url) throw new WidgetError(0, "not-configured", "Set a URL for this widget");
      const auth = (isObject(c.auth) ? c.auth : { type: "none" }) as { type?: string; secret?: { service: string; account: string }; header?: string };
      if (auth.type !== "none" && !auth.secret) throw new WidgetError(0, "needs-secret", "Pick the Keychain item this widget sends");
      const res = await ctx.request({
        url,
        headers: (c.headers as Record<string, string> | undefined) ?? {},
        secret: auth.type === "none" ? undefined : auth.secret,
        secretAs: auth.type === "header" ? { header: auth.header || "x-api-key" } : "bearer",
      });
      const raw = evalPath(res.json, parsePath(String(c.path ?? "$")));
      if (raw === undefined) throw new WidgetError(0, "path-not-found", `Nothing found at ${String(c.path)}`);
      if (raw !== null && typeof raw === "object") throw new WidgetError(0, "not-a-value", `${String(c.path)} points at an ${Array.isArray(raw) ? "array" : "object"}, not a number or text`);
      const num = asNumber(raw);
      const value = num ?? String(raw);
      let spark: number[] | undefined;
      if (typeof c.sparkPath === "string" && c.sparkPath) {
        const arr = evalPath(res.json, parsePath(c.sparkPath, { wildcard: true }));
        if (Array.isArray(arr)) spark = arr.map(asNumber).filter((n): n is number => n !== undefined).slice(-60);
      } else if (c.trail === true && num !== undefined) {
        const key = `${ctx.file}\0${ctx.widget.id}\0${url}\0${c.path}`;
        const ring = trails.get(key) ?? [];
        ring.push(num);
        if (ring.length > 60) ring.shift();
        trails.set(key, ring);
        spark = ring.slice();
      }
      const out: SourceData = { value, display: formatValue(value, String(c.format ?? "auto"), String(c.unit ?? "")), label: String(c.label || ctx.widget.name) };
      if (spark && spark.length) {
        out.spark = spark;
        if (spark.length >= 2) out.delta = deltaOf(spark[spark.length - 1], spark[spark.length - 2], String(c.format ?? "auto"));
      }
      return out;
    },
  },
};
