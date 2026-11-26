import { route as routeComments } from "../../../core/router.ts";
import { CLOUD_TIMERS, PER_VOTE_DESIGN, PRIVATE_VOTE_VIEWS, COMMENTS_CAPABILITIES_HEADER, LIMITS, PROTOCOL_VERSION, supportsPrivateVoteViews } from "../../../protocol";
import type { ServerInfo } from "../../../protocol";
import { authenticate } from "./auth";
import type { Env } from "./env";
import { failure, HttpError, readJson, sinceValue, uuid } from "./http";
export { Team } from "./team";
export { Room } from "./room";

async function route(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const method = request.method;
  if (method !== "GET") {
    const origin = request.headers.get("Origin");
    const type = request.headers.get("Content-Type")?.split(";", 1)[0].trim().toLowerCase();
    if ((origin !== null && origin !== url.origin) || type !== "application/json") return failure(403, "forbidden", "Same-origin JSON required");
  }
  const me = await authenticate(request, env);
  if (!me) return failure(401, "unauthenticated", "Valid Access identity required");
  const { pathname: path } = url;
  const team = env.TEAM.getByName("team");
  if (!await team.allowMessage(me.email)) return failure(429, "quota", "Too many requests in one minute");
  if (path === "/v1/info" && method === "GET") {
    return Response.json({ protocol: PROTOCOL_VERSION, server: env.SERVER_VERSION, capabilities: ["comments", PRIVATE_VOTE_VIEWS, CLOUD_TIMERS, PER_VOTE_DESIGN] } satisfies ServerInfo);
  }
  const role = await team.role(me.email);
  if (!role) return failure(403, "forbidden", "No access to this team");
  await team.rememberMember(me.email, me.name);
  if (path === "/v1/members" && method === "GET") return Response.json(await team.members(role === "owner" || role === "editor" ? undefined : "public"));
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
      const cursor = url.searchParams.get("cursor") ?? "";
      if (cursor && !uuid(cursor)) return failure(400, "invalid", "cursor must be a document uuid");
      const page = await team.documents(cursor, 51);
      const docs = [];
      for (const doc of page.slice(0, 50)) docs.push({ ...doc, ...await env.ROOM.getByName(doc.doc).exportSnapshot() });
      return Response.json({ rules, docs, cursor: page.length > 50 ? docs.at(-1)!.doc : null });
    }
  }
  if (path === "/v1/docs" && method === "POST") {
    if (role !== "owner" && role !== "editor") return failure(403, "forbidden", "Owner or editor role required");
    const body = await readJson(request);
    const doc = body && typeof body === "object" && "doc" in body ? body.doc : null;
    if (!uuid(doc)) return failure(400, "invalid", "doc must be a uuid");
    if (!await team.register(doc, me.email)) return failure(409, "quota", "Team has too many documents");
    return Response.json({ doc });
  }
  const design = /^\/v1\/docs\/([0-9a-f-]+)\/vote-design$/.exec(path);
  if (design && method === "PUT" && uuid(design[1]) && await team.hasDoc(design[1])) {
    if (role !== "owner" && role !== "editor") return failure(403, "forbidden", "Owner or editor role required");
    const value = await readJson(request);
    const result = await env.ROOM.getByName(design[1]).setVoteDesign(design[1], me.email, value);
    if (result === "forbidden") return failure(403, "forbidden", "Owner or editor role required");
    return result ? Response.json({ ok: true }) : failure(400, "invalid", "Invalid vote design");
  }
  const voting = supportsPrivateVoteViews(request.headers.get(COMMENTS_CAPABILITIES_HEADER)?.split(/\s*,\s*/));
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
  const result = await routeComments({
    kind: "cloudflare",
    team: () => ({ hasDoc: () => true }), // Registration and role were checked above, before socket dispatch.
    room: id => ({
      read: async req => ({ status: 200, body: await env.ROOM.getByName(id).read(sinceValue(req.query.get("since") ?? "0"), voting ? me : undefined) }),
      submit: async req => {
        const body = await req.body();
        const ops = body && typeof body === "object" && "ops" in body ? body.ops : null;
        if (!Array.isArray(ops)) throw new HttpError(400, "invalid", "ops must be a list");
        if (ops.length > LIMITS.opsPerMessage) {
          await team.takeOps(me.email, ops.length);
          throw new HttpError(429, "quota", "Too many ops in one message");
        }
        return { status: 200, body: await env.ROOM.getByName(id).submit(id, ops, me, role, voting) };
      },
    }),
  }, { method, path, query: url.searchParams, headers: request.headers, body: () => readJson(request) });
  return Response.json(result.body, { status: result.status });
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
