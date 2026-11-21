import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { bad, bool, int, isObject, oneOf, str } from "./check.ts";
import { blockedReason } from "./http.ts";
import { evalPath, parsePath } from "./jsonpath.ts";
import { isLocalWidgetApproved } from "./trust.ts";
import { WidgetError, type Config, type Field, type Source, type WidgetKind } from "./types.ts";

export const WIDGET_ID = /^[A-Za-z0-9_-]{1,40}$/;
const reserved = new Set(["app", "__proto__", "constructor", "prototype"]);
const types = ["text", "textarea", "number", "select", "bool", "url"] as const;
const root = () => process.env.CANVAS_WIDGETS_DIR ||
  path.join(os.homedir(), "Library", "Application Support", "Canvas", "widgets");

type Setting = Field & { default?: unknown };

function settingValue(s: Setting, value: unknown): unknown {
  if (value === undefined || value === null) return s.default;
  switch (s.type) {
    case "bool": return bool(value, s.label, false);
    case "number":
      if (typeof value !== "number" || !Number.isFinite(value)) throw bad(s.label, "must be a finite number");
      return value;
    case "select": return oneOf(value, s.label, "", s.options?.map((o) => o.value) ?? []);
    case "url": {
      const url = str(value, s.label, "", 2048);
      if (url) httpURL(url);
      return url;
    }
    default: return str(value, s.label, "", 8192);
  }
}

function requiredText(value: unknown, field: string, max: number): string {
  const text = str(value, field, "", max);
  if (!text.trim()) throw bad(field, "is required");
  return text;
}

function httpURL(value: string): URL {
  let url: URL;
  try { url = new URL(value); } catch { throw bad("URL", "must be a valid address"); }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || blockedReason(url.hostname))
    throw bad("URL", "must be an allowed HTTP or HTTPS address without credentials");
  return url;
}

export function parseLocalManifest(value: unknown, id: string) {
  if (!WIDGET_ID.test(id) || reserved.has(id) || !isObject(value) || value.id !== id) throw bad("id", "must match the widget folder");
  if (!isObject(value.defaultSize)) throw bad("defaultSize", "must give a width and height");
  const { w, h } = value.defaultSize;
  if (typeof w !== "number" || typeof h !== "number") throw bad("defaultSize", "must give a width and height");
  if (!Array.isArray(value.settings) || value.settings.length > 32) throw bad("settings", "must be an array of up to 32 fields");
  const seen = new Set<string>();
  const settings = value.settings.map((s: unknown): Setting => {
    if (!isObject(s)) throw bad("settings", "must contain field objects");
    const key = requiredText(s.key, "key", 40);
    if (!WIDGET_ID.test(key) || reserved.has(key) || seen.has(key)) throw bad("key", "must be a unique setting name");
    seen.add(key);
    const label = requiredText(s.label, "label", 80);
    if (typeof s.type !== "string" || !types.some((type) => type === s.type)) throw bad("type", "is not supported");
    const type = s.type as typeof types[number];
    const field: Setting = { key, label, type, help: str(s.help, "help", "", 240) || undefined };
    if (type === "select") {
      if (!Array.isArray(s.options) || !s.options.length || s.options.length > 32) throw bad(label, "must have 1 to 32 options");
      field.options = s.options.map((o: unknown) => {
        if (!isObject(o)) throw bad(label, "must contain option objects");
        return { value: requiredText(o.value, "value", 80), label: requiredText(o.label, "label", 80) };
      });
    }
    field.default = settingValue(field, s.default);
    return field;
  });
  return {
    id, settings,
    title: requiredText(value.title, "title", 120),
    description: requiredText(value.description, "description", 240),
    defaultSize: { w: int(w, "width", 240, 40, 4000), h: int(h, "height", 160, 40, 4000) },
    previewHTML: str(value.previewHTML, "previewHTML", "", 8192) || undefined,
    pollIntervalSec: int(value.pollIntervalSec, "pollIntervalSec", 60, 15, 3600),
  };
}

// Read only the three bundle files. Reject links and special files and bound the actual read size.
function bundleFile(folder: string, name: string, limit: number, optional = false): Buffer | undefined {
  let fd: number;
  try {
    fd = fs.openSync(path.join(folder, name), fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  } catch (err) {
    if (optional && (err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw err;
  }
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size > limit) throw bad(name, "is not a regular file within the size limit");
    const bytes = Buffer.alloc(limit + 1);
    let offset = 0;
    while (offset < bytes.length) {
      const n = fs.readSync(fd, bytes, offset, bytes.length - offset, null);
      if (!n) break;
      offset += n;
    }
    if (offset > limit) throw bad(name, "exceeds the size limit");
    return bytes.subarray(0, offset);
  } finally { fs.closeSync(fd); }
}

function localSource(id: string, hash: string, interval: number, bytes: Buffer): Source {
  const spec: unknown = JSON.parse(bytes.toString("utf8"));
  if (!isObject(spec)) throw bad("fetch.json", "must be an object");
  const url = httpURL(requiredText(spec.url, "url", 2048)).href;
  const selector = parsePath(str(spec.path, "path", "$", 200));
  const maxBytes = int(spec.maxBytes, "maxBytes", 1_000_000, 1, 8_000_000);
  const fields = spec.fields;
  if (fields !== undefined && (!Array.isArray(fields) || !fields.length || fields.length > 32 ||
      fields.some((f) => typeof f !== "string" || !WIDGET_ID.test(f) || reserved.has(f)))) {
    throw bad("fields", "must list 1 to 32 field names");
  }
  return {
    version: hash, key: () => hash, minIntervalSec: 15, intervalSec: () => interval,
    async fetch({ request }) {
      if (!isLocalWidgetApproved(id, hash)) throw new WidgetError(0, "needs-approval", "Review and allow this local widget on the canvas.");
      const { json } = await request({ url, maxBytes });
      const data = evalPath(json, selector);
      if (data === undefined) throw new WidgetError(0, "missing-path", "The JSON response did not contain the configured path.");
      if (!fields) return { content: { local: { hash, data } } };
      const pickFields = (record: unknown) => isObject(record)
        ? Object.fromEntries(fields.filter((f) => Object.hasOwn(record, f)).map((f) => [f, record[f]]))
        : null;
      return { content: { local: { hash, data: Array.isArray(data) ? data.map(pickFields) : pickFields(data) } } };
    },
  };
}

export function readLocalWidget(id: string) {
  if (!WIDGET_ID.test(id) || reserved.has(id)) return undefined;
  const folder = path.join(root(), id);
  try {
    if (!fs.lstatSync(folder).isDirectory()) return undefined;
    const manifestBytes = bundleFile(folder, "manifest.json", 32_768)!;
    const renderer = bundleFile(folder, "renderer.js", 131_072)!;
    const fetcher = bundleFile(folder, "fetch.json", 8192, true);
    const manifest = parseLocalManifest(JSON.parse(manifestBytes.toString("utf8")), id);
    const hash = createHash("sha256");
    for (const bytes of [manifestBytes, renderer, fetcher]) hash.update(bytes ? bytes.length + ":" : "-:").update(bytes ?? "");
    const digest = hash.digest("hex");
    const source = fetcher && localSource(id, digest, manifest.pollIntervalSec, fetcher);
    const defaults = Object.fromEntries(manifest.settings.filter((s) => s.default !== undefined).map((s) => [s.key, s.default]));
    const kind: WidgetKind = {
      id, title: manifest.title, description: manifest.description, symbol: "square.dashed",
      defaultSize: manifest.defaultSize, minSize: { w: 100, h: 60 },
      fields: manifest.settings.map(({ default: _, ...field }) => field), defaults: () => ({ ...defaults }),
      local: { hash: digest, previewHTML: manifest.previewHTML },
      source,
      validate(config: Config) {
        const out = { ...config };
        for (const s of manifest.settings) {
          const value = settingValue(s, Object.hasOwn(out, s.key) ? out[s.key] : undefined);
          if (value !== undefined) out[s.key] = value;
        }
        return out;
      },
    };
    return { kind, hash: digest, renderer: renderer.toString("utf8") };
  } catch {
    return undefined;
  }
}

export function localWidgetIds(): string[] {
  try { return fs.readdirSync(root(), { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort(); }
  catch { return []; }
}
