// The hosted Cloud as its own process: `node cloud/node/main.ts`, forked by Canvas's editor server
// (src/cloud-host.ts), one per Cloud this Mac hosts, while hosting it is on. It imports cloud code only (no editor route,
// handler or proxy can reach this process), listens on 127.0.0.1 (its own port), and takes orders only over the IPC channel of
// the process that forked it. When that channel closes (Canvas quit or crashed), it stops and exits: no orphan.
//
//   env CANVAS_CLOUD_HOST_DIR   the data folder (required)
//   env CANVAS_CLOUD_HOST_PORT  the port (src/cloud-host.ts gives each hosted Cloud its own, 5190-5289; tests: 0, a free one)
//
// Orders: { id, op, ...args } -> { id, ok: true, result } | { id, ok: false, error }. Events: { event: "people" }.
// Results that carry a secret (a join code, the host's own device token) go over IPC only, never to a log.

import { CloudHost, HostError } from "./host.ts";
import type { Role } from "../protocol.ts";

const dir = process.env.CANVAS_CLOUD_HOST_DIR;
if (!dir || !process.send) {
  process.stderr.write("cloud host: run by Canvas only (needs CANVAS_CLOUD_HOST_DIR and an IPC channel)\n");
  process.exit(2);
}
process.umask(0o077);
const port = process.env.CANVAS_CLOUD_HOST_PORT !== undefined ? Number(process.env.CANVAS_CLOUD_HOST_PORT) : undefined;
const pingMs = process.env.CANVAS_CLOUD_HOST_PING_MS ? Number(process.env.CANVAS_CLOUD_HOST_PING_MS) : undefined;
let host: CloudHost | null = new CloudHost({ dir, port, pingMs });
host.onPeopleChanged = () => process.send?.({ event: "people" });

const send = (m: unknown) => { try { process.send!(m); } catch { /* the parent is gone; disconnect handles it */ } };

async function handle(m: Record<string, unknown>): Promise<unknown> {
  if (!host) throw new HostError(410, "stopped", "Not hosting");
  const label = typeof m.label === "string" ? m.label : "";
  switch (m.op) {
    case "start": {
      if (typeof m.hostId === "string") host.useHostId(m.hostId);
      const p = await host.start();
      return { port: p, hostId: host.hostId(), ownerToken: host.ownerDevice(label) };
    }
    case "invite": return host.invite(label, typeof m.role === "string" && m.role ? (m.role as Role) : undefined);
    case "people": return { people: host.people(), keys: host.deviceKeys(), pending: host.pendingInvites() };
    case "config": {
      host.memberAddr = typeof m.memberAddr === "string" ? m.memberAddr : null;
      host.memberKey = typeof m.memberKey === "string" ? m.memberKey : null;
      return { ok: true };
    }
    case "remove": return { removed: host.remove(String(m.personId ?? "")) };
    case "stop": {
      // Stop hosting: every token revoked, then the process ends.
      host.revokeAll();
      await host.stop();
      host = null;
      setTimeout(() => process.exit(0), 50);
      return { stopped: true };
    }
    case "wipe": {
      await host.wipe();
      host = null;
      setTimeout(() => process.exit(0), 50);
      return { wiped: true };
    }
    default: throw new HostError(400, "invalid", "Unknown order");
  }
}

process.on("message", (raw) => {
  const m = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  handle(m).then(
    (result) => send({ id: m.id, ok: true, result }),
    (e) => send({ id: m.id, ok: false, error: { code: e instanceof HostError ? e.code : "server", message: e instanceof HostError ? e.message : "The Cloud could not do that" } }),
  );
});

async function quit(code = 0) {
  try { await host?.stop(); } catch { /* already stopped */ }
  process.exit(code);
}
process.on("disconnect", () => void quit(0));
process.on("SIGTERM", () => void quit(0));
process.on("SIGINT", () => void quit(0));
// No stack traces with request data in a log: one plain line, then out.
process.on("uncaughtException", () => { process.stderr.write("cloud host: stopped after an error\n"); void quit(1); });
send({ event: "ready" });
