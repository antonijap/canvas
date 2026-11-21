// Synchronous face of the renderer. Scripts in `execute` are synchronous and may read layout at any point.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { MessageChannel, type MessagePort, receiveMessageOnPort, Worker } from "node:worker_threads";
import type { CanvasDoc } from "../docfile.ts";
import { defaultTheme, type Theme } from "../resolve.ts";
import type { DocNode } from "../schema.ts";
import { documentHtml, type HtmlOptions } from "./html.ts";
import { SVG_SCRIPT } from "./svg.ts";

export type Rect = { x: number; y: number; width: number; height: number; pageX: number; pageY: number; problems?: string };

let worker: Worker | null = null;
let port: MessagePort;
let flag: Int32Array;
const profileDir = path.join(os.tmpdir(), `canvas-chrome-${process.pid}`);

let warming = false;

function startWorker() {
  if (!worker) {
    flag = new Int32Array(new SharedArrayBuffer(4));
    const channel = new MessageChannel();
    port = channel.port1;
    worker = new Worker(new URL("./chrome-worker.ts", import.meta.url), { workerData: { flag, port: channel.port2, profileDir }, transferList: [channel.port2] });
    worker.unref();
    port.unref();
    worker.on("exit", () => {
      worker = null;
      warming = false;
    });
    process.once("exit", () => {
      // Chrome may still be writing into its profile as the process exits; a leftover folder is tidied by the next start.
      try {
        fs.rmSync(profileDir, { recursive: true, force: true });
      } catch {}
    });
  }
}

/**
 * Start Chrome without waiting for it, so the first TakeScreenshot or layout read of a session skips the ~0.5 s launch.
 * Chrome still quits after two idle minutes.
 */
export function warmRenderer() {
  if (process.env.CANVAS_NO_WARM) return;
  if (warming) {
    if (Atomics.load(flag, 0) !== 1) return;
    receiveMessageOnPort(port);
  }
  startWorker();
  warming = true;
  Atomics.store(flag, 0, 0);
  port.postMessage({ op: "warm" });
}

function call(req: object, timeoutMs = 120_000): any {
  startWorker();
  if (warming) {
    // The warm-up's answer comes first on the port; take it off before asking anything else.
    Atomics.wait(flag, 0, 0, 60_000);
    receiveMessageOnPort(port);
    warming = false;
  }
  Atomics.store(flag, 0, 0);
  port.postMessage(req);
  if (Atomics.wait(flag, 0, 0, timeoutMs) === "timed-out") throw new Error("The renderer did not answer in time.");
  const msg = receiveMessageOnPort(port)?.message;
  if (!msg) throw new Error("The renderer sent no answer.");
  if (msg.error) throw new Error(`Rendering failed: ${msg.error}`);
  return msg.ok;
}

/** A media card's frame in a private headless page, without joining the app bridge. */
export function renderCard(url: string, kind: "shaderFrame" | "videoFrame", args: Record<string, unknown>, page?: string): any {
  return call({ op: "card", url, kind, args, page }, 60_000);
}

export type RenderInput = { doc: CanvasDoc; file: string; theme?: Theme; warnings?: string[] };

const options = (i: RenderInput, extra: Partial<HtmlOptions> = {}): HtmlOptions => ({
  doc: i.doc,
  baseDir: path.dirname(i.file),
  theme: i.theme ?? defaultTheme(i.doc),
  warnings: i.warnings ?? [],
  ...extra,
});

/** Lay out expanded top-level nodes and return every node's box, keyed by id. */
export function layout(roots: DocNode[], i: RenderInput): Record<string, Rect> {
  return call({ op: "layout", html: documentHtml(roots, options(i)) }).rects;
}

const MAX_SIDE = 1600;

/** Screenshot of expanded nodes. maxSide limits the longest edge so a big board stays readable and cheap. */
export function screenshots(roots: { root: DocNode; targetId: string }[], i: RenderInput, o: { format?: "png" | "jpeg" | "webp"; scale?: number; quality?: number; maxSide?: number } = {}): Buffer[] {
  const rects = layout(roots.map((r) => r.root), i);
  const clips = roots.map(({ targetId }) => {
    const r = rects[targetId];
    if (!r) throw new Error(`nothing drawn for "${targetId}" (it may be hidden)`);
    const maxSide = o.maxSide ?? MAX_SIDE;
    const scale = o.scale ?? Math.min(2, maxSide / Math.max(r.width, r.height, 1));
    return { x: r.pageX, y: r.pageY, width: r.width, height: r.height, scale };
  });
  return call({ op: "shot", clips, format: o.format ?? "png", quality: o.quality }).images.map((b: string) => Buffer.from(b, "base64"));
}

/** `scale`: a number, or one picked from the node's laid-out box (a store preset). */
export type ExportTarget = { id: string; format: "png" | "svg" | "jpeg" | "webp"; scale?: number | ((r: Rect) => number); root?: string };
/** `png` holds the image bytes for every raster format (jpeg and webp too). `root`: the box of the target's root, when asked. */
export type ExportShot = { rect: Rect; png?: Buffer; svg?: string; warnings?: string[]; root?: Rect };

/**
 * Lay the roots out once, then draw each target: a PNG screenshot of its box at its scale, or an SVG of it (svg.ts:
 * vector boxes, text as text, image fills as <image> with the page's file URLs).
 */
export function exportTargets(roots: DocNode[], i: RenderInput, targets: ExportTarget[]): ExportShot[] {
  const html = documentHtml(roots, options(i, { layerNames: true })).replace("</head>", `<script>${SVG_SCRIPT}</script></head>`);
  const rects: Record<string, Rect> = call({ op: "layout", html }).rects;
  return targets.map((t) => {
    const r = rects[t.id];
    if (!r || r.width <= 0 || r.height <= 0) throw new Error(`nothing drawn for "${t.id}" (it may be hidden or empty)`);
    const root = t.root ? rects[t.root] : undefined;
    if (t.format === "svg") {
      const v = call({ op: "eval", expression: `window.__svg(${JSON.stringify(t.id)})` }).value as { svg: string; warnings: string[] };
      return { rect: r, svg: v.svg, warnings: v.warnings, root };
    }
    // JPEG has no alpha: Chrome draws it over white, the way a JPG export usually looks.
    const [b] = call({ op: "shot", clips: [{ x: r.pageX, y: r.pageY, width: r.width, height: r.height, scale: typeof t.scale === "function" ? t.scale(r) : (t.scale ?? 1) }], format: t.format, ...(t.format === "jpeg" ? { quality: 92, background: "white" } : t.format === "webp" ? { quality: 92 } : {}) }).images;
    return { rect: r, png: Buffer.from(b, "base64"), root };
  });
}

/**
 * PDFs of SVG drawings (src/export-run.ts makes them from exportTargets' SVGs): one page each, the drawing's size,
 * vector, text as text. Loads a page of its own, so call it after the shots that need the laid-out document.
 */
export function pdfFromSvgs(items: { svg: string; width: number; height: number }[]): Buffer[] {
  return items.map((it) => {
    const w = Math.max(1, it.width), h = Math.max(1, it.height);
    const html = `<!doctype html><html><head><meta charset="utf-8"><style>@page{size:${w}px ${h}px;margin:0}html,body{margin:0;padding:0}svg{display:block}</style><script>window.__layout=()=>({})</script></head><body>${it.svg}</body></html>`;
    call({ op: "layout", html });
    return Buffer.from(call({ op: "pdf" }).pdf, "base64");
  });
}

/** One PDF with a page per node, each page the size of its node. */
export function pdf(roots: DocNode[], i: RenderInput): Buffer {
  const rects = layout(roots, i);
  const o = options(i);
  const pages = roots
    .map((r, k) => {
      const box = rects[String(r.id)];
      return `@page p${k}{size:${Math.ceil(box?.width ?? 100)}px ${Math.ceil(box?.height ?? 100)}px;margin:0}.stage:nth-of-type(${k + 1}){page:p${k};margin:0;break-after:page}`;
    })
    .join("");
  const html = documentHtml(roots, o).replace("</style>", `${pages}</style>`);
  call({ op: "layout", html });
  return Buffer.from(call({ op: "pdf" }).pdf, "base64");
}

export function shutdownRenderer() {
  if (worker) call({ op: "quit" });
}

/** Standalone HTML for hand-off. Tailwind output keeps each style as an arbitrary-value utility. */
export function exportHtml(roots: DocNode[], i: RenderInput, o: { outFile: string; tailwind?: boolean; scaffold?: boolean; layerNames?: boolean; layerIds?: boolean }): string {
  const outDir = path.dirname(o.outFile);
  let html = documentHtml(roots, options(i, { layerNames: o.layerNames ?? true, assetUrl: (abs) => path.relative(outDir, abs).split(path.sep).join("/") || abs }));
  html = html.replace(/<script>[\s\S]*?<\/script>/, "");
  if (o.layerIds === false || o.layerIds === undefined) html = html.replace(/ data-id="[^"]*"/g, "");
  html = html.replace(/ data-t="[^"]*"/g, "").replace(/ data-clip="1"/g, "").replace(/ data-fit="[^"]*"/g, "");
  if (o.tailwind) {
    html = html.replace(/style="([^"]*)"/g, (_m, style: string) => {
      const cls = style.replace(/&quot;/g, "'").split(";").filter(Boolean).map((d) => {
        const k = d.indexOf(":");
        return `[${d.slice(0, k)}:${d.slice(k + 1).replace(/\s+/g, "_")}]`;
      });
      return `class="${cls.join(" ")}"`;
    });
    html = html.replace("</head>", `<script src="https://cdn.tailwindcss.com"></script></head>`);
  }
  if (o.scaffold === false) html = html.replace(/^[\s\S]*<body>/, "").replace(/<\/body><\/html>$/, "");
  return html;
}
