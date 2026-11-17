// Drives every shell op of the MCP bridge against a running Canvas and prints the results.
// Run: node scripts/bridge-smoke.ts   (CANVAS_PORT, default 5189). Needs Canvas.app open.
// It switches the theme and back, and shows then clears a toast; it opens no files.

const port = Number(process.env.CANVAS_PORT) || 5189;
const base = `http://127.0.0.1:${port}`;

async function cmd(op: string, args: Record<string, unknown> = {}, timeoutMs = 10_000): Promise<any> {
  const res = await fetch(`${base}/api/bridge/cmd`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-canvas": "1" },
    body: JSON.stringify({ op, args, timeoutMs }),
  });
  const json: any = await res.json().catch(() => ({}));
  return { status: res.status, ...json };
}

function show(op: string, r: any): void {
  const copy = JSON.parse(JSON.stringify(r));
  const walk = (o: any): void => {
    for (const k of Object.keys(o ?? {})) {
      if (typeof o[k] === "string" && o[k].length > 120) o[k] = `<${o[k].length} chars>`;
      else if (Array.isArray(o[k]) && o[k].length > 8) o[k] = [...o[k].slice(0, 8), `... ${o[k].length} total`];
      else if (o[k] && typeof o[k] === "object") walk(o[k]);
    }
  };
  walk(copy);
  console.log(`${r.ok === false || r.status >= 400 ? "FAIL" : "ok  "} ${op}`, JSON.stringify(copy));
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const ping = await cmd("ping");
show("ping", ping);
if (ping.status >= 400 || ping.ok === false) {
  console.error("no shell answered; is Canvas.app running?");
  process.exit(1);
}

const tabs = await cmd("tabs");
show("tabs", tabs);
const theme = await cmd("theme.get");
show("theme.get", theme);
const original = theme.result?.mode ?? "system";
show("theme.set dark", await cmd("theme.set", { mode: "dark" }));
await sleep(300);
show("theme.set light", await cmd("theme.set", { mode: "light" }));
await sleep(300);
show(`theme.set ${original}`, await cmd("theme.set", { mode: original }));
show("fonts", await cmd("fonts"));
show("snapshot png", await cmd("snapshot", { maxSide: 800, format: "png" }, 20_000));
show("snapshot jpeg", await cmd("snapshot", { maxSide: 800, format: "jpeg", quality: 0.7 }, 20_000));
show("toast", await cmd("toast", { message: "bridge smoke test", level: "info", durationMs: 2000 }));
await sleep(500);
show("toast persistent", await cmd("toast", { id: "smoke", message: "persistent toast (clearing)", level: "info", durationMs: 0 }));
await sleep(1000);
show("toast clear", await cmd("toast", { id: "smoke", clear: true }));
show("activate", await cmd("activate"));
show("close (unknown tab, expects not_found)", await cmd("close", { file: "/nonexistent/none.canvas.json" }));
