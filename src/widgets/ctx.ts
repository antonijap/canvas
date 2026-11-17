// What a widget source gets to fetch with: JSON over safeFetch, plus the secret and trust rules.

import { safeFetchJson } from "./http.ts";
import { clearSecret, getSecret, redact } from "./keychain.ts";
import { isApproved } from "./trust.ts";
import { WidgetError, type FetchCtx, type JsonResponse, type RequestOptions, type Widget } from "./types.ts";

export async function request(o: RequestOptions): Promise<JsonResponse> {
  let secret: { name: string; value: string } | undefined;
  if (o.secret) {
    const value = await getSecret(o.secret); // needs-secret when missing
    const origin = new URL(o.url).origin;
    if (!isApproved(o.secret, origin)) throw new WidgetError(0, "needs-approval", `Allow this widget to send its secret to ${origin}?`);
    const as = o.secretAs ?? "bearer";
    secret = as === "bearer" ? { name: "authorization", value: `Bearer ${value}` } : { name: as.header, value };
  }
  const hasBody = o.body !== undefined;
  const res = await safeFetchJson({
    url: o.url,
    method: o.method ?? "GET",
    headers: { ...(o.headers ?? {}), ...(hasBody ? { "content-type": "application/json" } : {}) },
    body: hasBody ? JSON.stringify(o.body) : undefined,
    secret,
    maxBytes: o.maxBytes ?? 1_000_000,
  });
  if (res.status === 401 || res.status === 403) {
    if (o.secret) clearSecret(o.secret);
    throw new WidgetError(0, "auth", `The server refused the credentials (HTTP ${res.status})`);
  }
  if (res.status === 429) {
    const ra = Number(res.headers["retry-after"]);
    throw new WidgetError(0, "rate-limited", "The server is rate limiting this widget", Number.isFinite(ra) && ra > 0 ? Math.min(ra, 3600) : 60);
  }
  if (res.status < 200 || res.status >= 300) throw new WidgetError(0, "http", `The server answered HTTP ${res.status}`);
  return { status: res.status, headers: res.headers, json: res.json };
}

export function makeCtx(file: string, widget: Widget, force: boolean): FetchCtx {
  return { file, widget, force, now: Date.now(), request };
}

export { redact };
