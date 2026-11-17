import { LIMITS, PROTOCOL_VERSION } from "../../protocol";
import type { ServerInfo } from "../../protocol";
import { authenticate } from "./auth";
import type { Env } from "./env";
import { failure, HttpError, readJson, sinceValue, uuid } from "./http";
export { Team } from "./team";
export { Room } from "./room";

async function route(request: Request, env: Env): Promise<Response> {
  const me = await authenticate(request, env);
  if (!me) return failure(401, "unauthenticated", "Valid Access identity required");
  const url = new URL(request.url);
  const { pathname: path } = url;
  const method = request.method;
  if (path === "/v1/info" && method === "GET") {
    return Response.json({ protocol: PROTOCOL_VERSION, server: env.SERVER_VERSION, capabilities: ["comments"] } satisfies ServerInfo);
  }
  const team = env.TEAM.getByName("team");
  const role = await team.role(me.email);
  if (!role) return failure(403, "forbidden", "No access to this team");
  if (path === "/v1/me" && method === "GET") return Response.json({ ...me, role });
  if (path === "/v1/people" || path === "/v1/export") {
    if (role !== "owner") return failure(403, "forbidden", "Owner role required");
    if (path === "/v1/people" && method === "GET") return Response.json(await team.rules());
    if (path === "/v1/people" && method === "PUT") {
      const result = await team.replaceRules(await readJson(request));
      if (result) return failure(result.code === "conflict" ? 409 : 400, result.code, result.message);
      return Response.json(await team.rules());
    }
    if (path === "/v1/export" && method === "GET") {
      const rules = await team.rules();
      const docs = await Promise.all((await team.documents()).map(async doc => ({ ...doc, ...await env.ROOM.getByName(doc.doc).snapshot() })));
      return Response.json({ rules, docs });
    }
  }
  if (path === "/v1/docs" && method === "POST") {
    if (role !== "owner" && role !== "editor") return failure(403, "forbidden", "Owner or editor role required");
    const body = await readJson(request);
    const doc = body && typeof body === "object" && "doc" in body ? body.doc : null;
    if (!uuid(doc)) return failure(400, "invalid", "doc must be a uuid");
    await team.register(doc, me.email);
    return Response.json({ doc });
  }
  const match = /^\/v1\/docs\/([^/]+)\/(threads|ops|socket)$/.exec(path);
  if (!match) return failure(404, "not_found", "No such route");
  const [, doc, action] = match;
  if (!uuid(doc)) return failure(400, "invalid", "doc must be a uuid");
  if (!await team.hasDoc(doc)) return failure(404, "not_found", "Document is not registered");
  // Lookup a Room only after registration and permission checks.
  if (action === "socket" && method === "GET") {
    const origin = request.headers.get("Origin");
    if (origin !== null && origin !== url.origin) return failure(403, "forbidden", "Foreign socket origin");
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") return failure(400, "invalid", "WebSocket upgrade required");
    const headers = new Headers(request.headers);
    for (const name of [...headers.keys()]) if (name.startsWith("x-canvas-internal-")) headers.delete(name);
    headers.set("x-canvas-internal-email", me.email);
    headers.set("x-canvas-internal-role", role);
    headers.set("x-canvas-internal-doc", doc);
    return env.ROOM.getByName(doc).fetch(new Request(request, { headers }));
  }
  if (action === "threads" && method === "GET") {
    sinceValue(url.searchParams.get("since") ?? "0");
    return Response.json(await env.ROOM.getByName(doc).snapshot());
  }
  if (action === "ops" && method === "POST") {
    const body = await readJson(request);
    const ops = body && typeof body === "object" && "ops" in body ? body.ops : null;
    if (!Array.isArray(ops)) return failure(400, "invalid", "ops must be a list");
    if (ops.length > LIMITS.opsPerMessage) return failure(429, "quota", "Too many ops in one message");
    return Response.json(await env.ROOM.getByName(doc).submit(doc, ops, me, role));
  }
  return failure(404, "not_found", "No such route");
}
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try { return await route(request, env); }
    catch (error) {
      if (error instanceof HttpError) return failure(error.status, error.code, error.message);
      return failure(500, "server", "Could not process request");
    }
  },
};
