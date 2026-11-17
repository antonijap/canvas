// A picture of the selection for a talk-to-the-selection run (src/agent-run.ts), made the way render_node makes it,
// in its own process: the headless renderer blocks its thread while Chrome works, which the server must never do.
// Usage: node src/agent-render.ts <port> <document> <node id> <out.png>. Exit 0 with the PNG written, else non-zero.

import fs from "node:fs";
import { renderNode } from "../mcp/render.ts";
import { shutdownRenderer } from "./engine.ts";

const [port, file, id, out] = process.argv.slice(2);
const settle = async () => {
  const r = await fetch(`http://127.0.0.1:${port}/api/flush`, { method: "POST", headers: { "x-canvas": "1", "content-type": "application/json" }, body: JSON.stringify({ file }), signal: AbortSignal.timeout(20_000) });
  return ((await r.json()) as { fileRevision?: string | null }).fileRevision;
};
try {
  const r = await renderNode({ file, id, maxSide: 1200, format: "png", settle });
  fs.writeFileSync(out, r.image, { mode: 0o600 });
  try { shutdownRenderer(); } catch {}
  process.exit(0);
} catch (e) {
  process.stderr.write(`${(e as Error).message}\n`);
  try { shutdownRenderer(); } catch {}
  process.exit(1);
}
