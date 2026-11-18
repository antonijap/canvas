import type { Adapter, CoreRequest, CoreResponse } from "./adapter.ts";

// Only the routes already common to both transports. Socket upgrades and enrolment stay adapter owned.
export async function route(adapter: Adapter, req: CoreRequest): Promise<CoreResponse> {
  const failure = (status: number, code: string, message: string) => ({ status, body: { code, message } });
  const match = /^\/v1\/docs\/([^/]+)\/(threads|ops)$/.exec(req.path);
  if (!match) return failure(404, "not_found", "No such route");
  const [, doc, action] = match;
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(doc)) return failure(400, "invalid", "doc must be a uuid");
  if (!await adapter.team().hasDoc(doc)) return failure(404, "not_found", "Document is not registered");
  // Never instantiate a room for an unregistered document or an unsupported method.
  if (action === "threads" && req.method === "GET") return adapter.room(doc).read(req);
  if (action === "ops" && req.method === "POST") return adapter.room(doc).submit(req);
  return failure(404, "not_found", "No such route");
}
