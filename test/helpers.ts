// Shared by the widget tests: temp dirs, a fixture .canvas.json, fake upstream servers, a stub `security`.

import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

export function tmpDir(name: string): string {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `canvas-${name}-`)));
}

/** A port nothing listens on: the OS picks a free one, which is closed again before it is returned. */
export async function freePort(): Promise<number> {
  const s = http.createServer();
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  const { port } = s.address() as { port: number };
  await new Promise<void>((r) => s.close(() => r()));
  return port;
}

export const FIXTURE_DOC = {
  version: "2.21",
  children: [
    { type: "frame", id: "Scr01", name: "Screen", x: 0, y: 0, width: 390, height: 844, children: [] },
    { type: "frame", id: "Scr02", name: "Wide", x: 500, y: 100, width: 600, height: 300, children: [] },
  ],
};

export function writeDoc(dir: string, name = "demo"): string {
  const p = path.join(dir, `${name}.canvas.json`);
  fs.writeFileSync(p, JSON.stringify(FIXTURE_DOC, null, 2));
  return fs.realpathSync(p);
}

export type Fake = { port: number; url: string; close(): Promise<void>; hits: { method: string; url: string; headers: http.IncomingHttpHeaders; body: string }[] };

/** A local upstream. The handler sees the request body already read. */
export async function fakeServer(handler: (req: http.IncomingMessage, res: http.ServerResponse, body: string) => void): Promise<Fake> {
  const hits: Fake["hits"] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      hits.push({ method: req.method ?? "", url: req.url ?? "", headers: req.headers, body });
      handler(req, res, body);
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  return {
    port,
    url: `http://127.0.0.1:${port}`,
    hits,
    close: () =>
      new Promise<void>((r) => {
        server.closeAllConnections();
        server.close(() => r());
      }),
  };
}

export const sendJson = (res: http.ServerResponse, v: unknown, status = 200, headers: Record<string, string> = {}) => {
  res.writeHead(status, { "content-type": "application/json", ...headers });
  res.end(JSON.stringify(v));
};

/** A stand-in for /usr/bin/security that answers from files in `dir`; exit 44 for an unknown item. */
export function stubSecurity(dir: string, secrets: Record<string, string>): string {
  const store = path.join(dir, "keychain");
  fs.mkdirSync(store, { recursive: true });
  for (const [k, v] of Object.entries(secrets)) fs.writeFileSync(path.join(store, k), v);
  const bin = path.join(dir, "security-stub.sh");
  fs.writeFileSync(
    bin,
    `#!/bin/sh
svc=""; acct=""; w=0
while [ $# -gt 0 ]; do
  case "$1" in -s) svc="$2"; shift;; -a) acct="$2"; shift;; -w) w=1;; esac
  shift
done
f="${store}/$svc:$acct"
if [ -f "$f" ]; then
  if [ $w = 1 ]; then cat "$f"; echo; else echo "keychain: found"; fi
  exit 0
fi
echo "security: item could not be found" >&2
exit 44
`,
    { mode: 0o755 },
  );
  return bin;
}

/** Collect server-sent events from a URL until closed. */
export function sseClient(url: string, headers: Record<string, string> = {}) {
  const events: { event: string; data: any }[] = [];
  const waiters: (() => void)[] = [];
  const req = http.get(url, { headers }, (res) => {
    let buf = "";
    res.setEncoding("utf8");
    res.on("data", (d: string) => {
      buf += d;
      let at: number;
      while ((at = buf.indexOf("\n\n")) >= 0) {
        const block = buf.slice(0, at);
        buf = buf.slice(at + 2);
        const ev = /^event: (.*)$/m.exec(block)?.[1];
        const data = /^data: (.*)$/m.exec(block)?.[1];
        if (ev && data) events.push({ event: ev, data: JSON.parse(data) });
        for (const w of waiters.splice(0)) w();
      }
    });
  });
  req.on("error", () => {});
  const until = async (pred: () => boolean, ms = 4000) => {
    const end = Date.now() + ms;
    while (!pred()) {
      if (Date.now() > end) throw new Error(`timed out waiting; events so far: ${JSON.stringify(events).slice(0, 600)}`);
      await new Promise<void>((r) => {
        waiters.push(r);
        setTimeout(r, 50);
      });
    }
  };
  return { events, until, close: () => req.destroy() };
}
