import type { ErrorCode } from "../../../protocol";

export class HttpError extends Error {
  constructor(readonly status: number, readonly code: ErrorCode, message: string) { super(message); }
}
export function failure(status: number, code: ErrorCode, message: string) {
  return Response.json({ code, message }, { status });
}
export const uuid = (value: unknown): value is string => typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value);
export function sinceValue(value: unknown): number {
  const n = typeof value === "number" ? value : typeof value === "string" && /^\d+$/.test(value) ? Number(value) : NaN;
  if (!Number.isSafeInteger(n) || n < 0) throw new HttpError(400, "invalid", "since must be a nonnegative integer");
  return n;
}

/** Bound buffered JSON so one request cannot consume the isolate's memory. */
export async function readJson(request: Request): Promise<unknown> {
  const limit = 8 * 1024 * 1024;
  const reader = request.body?.getReader();
  if (!reader) throw new HttpError(400, "invalid", "JSON body required");
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) { await reader.cancel(); throw new HttpError(413, "quota", "Request body is too large"); }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  try { return JSON.parse(new TextDecoder().decode(bytes)); }
  catch { throw new HttpError(400, "invalid", "Invalid JSON"); }
}
