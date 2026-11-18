import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { reset, runInDurableObject } from "cloudflare:test";
import { Team } from "../src/team";
import { Room } from "../src/room";
import { PROTOCOL_VERSION } from "../../../protocol";
import { bindings, connect, envelope, member, post, register, rules } from "./helpers";

const sockets: WebSocket[] = [];
beforeEach(reset);
afterEach(() => { vi.restoreAllMocks(); for (const socket of sockets.splice(0)) socket.close(); });
async function unpushedRules(role: "viewer" | "deny") {
  await runInDurableObject(bindings.TEAM.getByName("team"), async (_instance, state) => {
    const team = new Team(state, { ...bindings, ROOM: { getByName: () => ({ revoke: async () => { throw new Error("Unreachable room"); } }) } as unknown as typeof bindings.ROOM });
    expect(await team.replaceRules([{ match: member, role }])).toBeNull();
  });
}
async function openMember() {
  await rules([{ match: member, role: "editor" }]);
  const doc = await register();
  const connection = await connect(doc, member);
  sockets.push(connection.socket);
  connection.socket.send(JSON.stringify({ type: "hello", protocol: PROTOCOL_VERSION, doc, since: 0 }));
  await connection.next();
  return { doc, ...connection };
}
it.each(["broadcast", "message"])("closes lowered roles before %s even when push revoke fails", async trigger => {
  const { doc, socket } = await openMember();
  const received: unknown[] = [];
  socket.addEventListener("message", event => received.push(JSON.parse(event.data as string)));
  const closed = new Promise<CloseEvent>(resolve => socket.addEventListener("close", resolve, { once: true }));
  await unpushedRules("viewer");
  vi.spyOn(Date, "now").mockReturnValue(Date.now() + 5001);
  if (trigger === "broadcast") await post(doc, [envelope(doc)]);
  else socket.send("{");
  expect((await closed).code).toBe(1008);
  expect(received).not.toContainEqual(expect.objectContaining({ type: "applied" }));
});
it("counts malformed socket messages and closes after 60 with quota", async () => {
  const { socket, next } = await openMember();
  const closed = new Promise<CloseEvent>(resolve => socket.addEventListener("close", resolve, { once: true }));
  for (let i = 1; i < 60; i++) { socket.send("{"); expect(await next()).toMatchObject({ type: "error", code: "invalid" }); }
  socket.send("{");
  expect(await next()).toMatchObject({ type: "error", code: "quota" });
  expect((await closed).code).toBe(1008);
});
it("limits revoke batches to 50 and logs failures without rejecting the rules change", async () => {
  await runInDurableObject(bindings.TEAM.getByName("team"), async (_instance, state) => {
    let active = 0, peak = 0, completed = 0;
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const room = { revoke: async () => { active++; peak = Math.max(peak, active); await Promise.resolve(); active--; completed++; throw new Error("offline"); } };
    const team = new Team(state, { ...bindings, ROOM: { getByName: () => room } as unknown as typeof bindings.ROOM });
    for (let i = 0; i < 101; i++) team.register(crypto.randomUUID(), member);
    try {
      expect(await team.replaceRules([])).toBeNull();
      await vi.waitFor(() => expect(completed).toBe(101));
      expect(peak).toBeLessThanOrEqual(50);
      expect(error).toHaveBeenCalled();
    } finally { error.mockRestore(); }
  });
});
it("rejects socket admission when a newer revocation overtakes its role lookup", async () => {
  const doc = await register();
  await runInDurableObject(bindings.ROOM.getByName(doc), async (_instance, state) => {
    let room: Room;
    const revoke = () => room.revoke([{ match: member, role: "deny" }], [], 2);
    const team = {
      role: async () => { revoke(); return "editor"; },
      authorization: async () => { revoke(); return { generation: 1, roles: [{ email: member, role: "editor" }] }; },
    };
    room = new Room(state, { ...bindings, TEAM: { getByName: () => team } as unknown as typeof bindings.TEAM });
    const response = await room.fetch(new Request("http://localhost", { headers: {
      Upgrade: "websocket", "x-canvas-internal-doc": doc, "x-canvas-internal-email": member,
    } }));
    if (response.webSocket) { response.webSocket.accept(); response.webSocket.close(); }
    expect(response.status).toBe(403);
  });
});
