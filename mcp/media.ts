// Media frames use the same private Chromium worker as render_node, never an app page.
import { renderCard } from "../src/doc/render/index.ts";
import { api, BASE } from "./client.ts";

export async function mediaFrame(file: string, kind: "shaderFrame" | "videoFrame", args: Record<string, unknown>) {
  const widget = await api<any>("GET", `/api/widgets/${encodeURIComponent(String(args.id))}?file=${encodeURIComponent(file)}`);
  return renderCard(`${BASE()}/?file=${encodeURIComponent(file)}`, kind, args, widget.widget?.page ?? widget.page);
}
