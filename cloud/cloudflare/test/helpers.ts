import { env } from "cloudflare:workers";
import { expect } from "vitest";
import worker from "../src/index";
import type { Env } from "../src/env";
import type { Op, OpEnvelope, PeopleRule, ServerMessage } from "../../protocol";

export const bindings = env as Env;
export const owner = "owner@example.com";
export const member = "member@example.com";
export function call(path: string, email = owner, method = "GET", body?: unknown, headers: Record<string, string> = {}) {
  return worker.fetch(new Request(`http://localhost${path}`, {
    method, headers: { "x-canvas-dev-email": email, ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }), bindings);
}
export async function rules(list: PeopleRule[]) {
  const response = await call("/v1/people", owner, "PUT", list);
  expect(response.status).toBe(200);
}
export async function register() {
  const doc = crypto.randomUUID();
  expect((await call("/v1/docs", owner, "POST", { doc })).status).toBe(200);
  return doc;
}
export function envelope(doc: string, op?: Op): OpEnvelope {
  return {
    opId: crypto.randomUUID(), doc, at: new Date().toISOString(),
    op: op ?? { kind: "thread.create", thread: crypto.randomUUID(), comment: crypto.randomUUID(), body: "Hello", anchor: { x: 1, y: 2 } },
  };
}
export async function post(doc: string, ops: unknown[], email = owner) {
  return (await call(`/v1/docs/${doc}/ops`, email, "POST", { ops })).json<{ acks: { opId: string; seq: number }[]; rejected: { opId: string; code: string; message: string }[] }>();
}
export function inbox(socket: WebSocket) {
  const messages: ServerMessage[] = [];
  const waiters: ((message: ServerMessage) => void)[] = [];
  socket.addEventListener("message", e => {
    const value = JSON.parse(e.data as string) as ServerMessage;
    const waiting = waiters.shift();
    if (waiting) waiting(value); else messages.push(value);
  });
  return () => messages.length ? Promise.resolve(messages.shift()!) : new Promise<ServerMessage>(resolve => waiters.push(resolve));
}
export async function connect(doc: string, email = owner, headers: Record<string, string> = {}) {
  const response = await call(`/v1/docs/${doc}/socket`, email, "GET", undefined, { Upgrade: "websocket", ...headers });
  expect(response.status).toBe(101);
  const socket = response.webSocket!;
  socket.accept();
  return { socket, next: inbox(socket) };
}
