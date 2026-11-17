// A stand-in for a canvas page or the app's shell: connects to the bridge, reports state, answers commands.

import http from "node:http";

type Cmd = { id: string; op: string; args: any };
export type Handler = (c: Cmd) => unknown | Promise<unknown>;

export class FakeClient {
  base: string;
  id: string;
  role: "page" | "shell";
  host: "native" | "browser";
  file?: string;
  seq = 0;
  boot = "";
  messages: any[] = [];
  cmds: Cmd[] = [];
  handler: Handler = () => ({});
  /** When false the client receives commands but never answers them. */
  autoAck = true;
  private req?: http.ClientRequest;
  closed = false;

  constructor(base: string, o: { role?: "page" | "shell"; host?: "native" | "browser"; file?: string; id?: string } = {}) {
    this.base = base;
    this.role = o.role ?? "page";
    this.host = o.host ?? "browser";
    this.file = o.file;
    this.id = o.id ?? `${this.role === "shell" ? "shell" : "p"}_${Math.random().toString(36).slice(2, 10)}`;
  }

  async connect(): Promise<this> {
    const q = new URLSearchParams({ client: this.id, role: this.role, host: this.host });
    if (this.file) q.set("file", this.file);
    await new Promise<void>((resolve, reject) => {
      this.req = http.get(`${this.base}/api/bridge/events?${q}`, (res) => {
        if (res.statusCode !== 200) return reject(new Error(`events ${res.statusCode}`));
        let buf = "";
        res.setEncoding("utf8");
        res.on("data", (d: string) => {
          buf += d;
          let at: number;
          while ((at = buf.indexOf("\n")) >= 0) {
            const line = buf.slice(0, at);
            buf = buf.slice(at + 1);
            if (!line.startsWith("data: ")) continue;
            const m = JSON.parse(line.slice(6));
            this.messages.push(m);
            if (m.type === "hello") {
              this.boot = m.boot;
              resolve();
            } else if (m.type === "cmd") void this.run(m);
          }
        });
        res.on("close", () => (this.closed = true));
      });
      this.req.on("error", reject);
    });
    return this;
  }

  private async run(c: Cmd) {
    this.cmds.push(c);
    if (!this.autoAck) return;
    try {
      const result = await this.handler(c);
      await this.ack(c.id, true, result);
    } catch (e: any) {
      await this.ack(c.id, false, undefined, { code: e.code ?? "failed", message: e.message });
    }
  }

  ack(id: string, ok: boolean, result?: unknown, error?: unknown) {
    return this.post("/api/ack", { client: this.id, id, ok, ...(ok ? { result } : { error }) });
  }

  async post(path: string, body: unknown, headers: Record<string, string> = {}) {
    const r = await fetch(this.base + path, { method: "POST", headers: { "x-canvas": "1", "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
    return { status: r.status, body: (await r.json().catch(() => ({}))) as any };
  }

  /** Report page state. Defaults describe a visible, unfocused page with nothing selected. */
  state(extra: Record<string, unknown> = {}) {
    const body =
      this.role === "page"
        ? { client: this.id, role: "page", host: this.host, file: this.file, docRevision: null, selection: null, hover: null, cam: { x: 0, y: 0, z: 1 }, view: { w: 1000, h: 800, insets: { l: 0, t: 0, r: 0, b: 0 } }, visible: true, focused: false, lastInputAt: 0, ...extra, seq: ++this.seq }
        : { client: this.id, role: "shell", host: "native", windowFocused: false, windowVisible: true, theme: { mode: "system", effective: "light" }, openFiles: [], currentFile: null, ...extra, seq: ++this.seq };
    return this.post("/api/state", body);
  }

  select(ids: string[], pick: number, rendered?: unknown, source = "user") {
    return this.state({ selection: ids.length ? { ids, pick, source, rendered: rendered ?? { width: 10, height: 10, world: { x: 0, y: 0, w: 10, h: 10 }, screen: { x: 0, y: 0, w: 10, h: 10 } } } : null });
  }

  close() {
    this.req?.destroy();
  }

  async until(pred: () => boolean, ms = 3000) {
    const end = Date.now() + ms;
    while (!pred()) {
      if (Date.now() > end) throw new Error("timed out waiting");
      await new Promise((r) => setTimeout(r, 20));
    }
  }
}

export async function getJson(base: string, path: string, headers: Record<string, string> = {}) {
  const r = await fetch(base + path, { headers });
  return { status: r.status, body: (await r.json().catch(() => ({}))) as any };
}
export async function postJson(base: string, path: string, body: unknown, headers: Record<string, string> = { "x-canvas": "1" }) {
  const r = await fetch(base + path, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
  return { status: r.status, body: (await r.json().catch(() => ({}))) as any };
}
