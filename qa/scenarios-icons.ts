import fs from "node:fs";
import path from "node:path";
import { decodePng } from "../fidelity/png.ts";
import { chromePath } from "../src/doc/render/chrome-path.ts";
import { sc, T } from "./harness.ts";
import { openTab, startServer } from "./lib.ts";

const libraries = ["phosphor", "Material Symbols Outlined", "Material Symbols Rounded", "Material Symbols Sharp"];
const icons = libraries.map((library, i) => ({
  type: "icon", id: `qa-icon-${i}`, library, icon: i === 0 ? "heart-fill" : "favorite",
  width: 64, height: 64, x: 16 + 80 * i, y: 16, fill: "#D00040",
}));
const board = { type: "frame", id: "qa-icons", name: "Icons", layout: "none", width: 336, height: 96, fill: "#FFFFFF", children: icons };

sc("icons", "bundled icons draw with network access blocked", {
  covers: ["render:icon", "icons:offline"],
  skip: { visual: "checks each icon's foreground pixels in an isolated canvas and export" },
}, async (t: T) => {
  const dir = path.dirname(t.file);
  const file = path.join(dir, "Icons.canvas");
  fs.mkdirSync(file);
  fs.writeFileSync(path.join(file, "document.json"), JSON.stringify({ version: "2.21", children: [board] }));

  const noFetch = 'globalThis.fetch = () => { throw new Error("Network disabled in icon QA"); };';
  const nodeOptions = `--import=data:text/javascript,${encodeURIComponent(noFetch)}`;
  const offlineChrome = path.join(dir, "offline-chrome");
  fs.writeFileSync(offlineChrome, '#!/bin/sh\nexec "$CANVAS_ICON_QA_CHROME" --no-proxy-server "--host-resolver-rules=MAP * ~NOTFOUND" "$@"\n', { mode: 0o700 });
  const srv = await startServer(dir, {
    NODE_OPTIONS: [process.env.NODE_OPTIONS, nodeOptions].filter(Boolean).join(" "),
    CANVAS_CHROME: offlineChrome,
    CANVAS_ICON_QA_CHROME: chromePath(),
  });
  const tab = await openTab(t.chromePort);
  try {
    tab.page.on("Fetch.requestPaused", ({ requestId, request }) => {
      const local = request.url.startsWith(srv.base + "/");
      void tab.page.send(local ? "Fetch.continueRequest" : "Fetch.failRequest",
        local ? { requestId } : { requestId, errorReason: "BlockedByClient" });
    });
    await tab.page.send("Fetch.enable", { patterns: [{ urlPattern: "http*" }] });
    await tab.page.send("Page.bringToFront");
    const o = new T(tab.page, file, srv);
    await o.open();
    await o.focus(board.id);
    for (const icon of icons) {
      const r = await o.rect(icon.id);
      const png = await o.shot({ x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.w), height: Math.round(r.h) });
      t.ok(iconPixels(decodePng(png)) > 100, `${icon.library} has no foreground on the canvas`);
    }

    const out = path.join(dir, "icons.png");
    await o.a.post("/api/export", { file, ids: [board.id], format: "png", path: out });
    const png = decodePng(fs.readFileSync(out));
    for (const icon of icons) {
      const count = iconPixels(png, icon);
      t.ok(count > 100, `${icon.library} has ${count} foreground pixels in the ${png.width} × ${png.height} PNG export`);
    }
  } finally {
    await tab.close();
    await srv.stop();
    await t.page.send("Page.bringToFront");
  }
});

function iconPixels(png: ReturnType<typeof decodePng>, r = { x: 0, y: 0, width: png.width, height: png.height }): number {
  let count = 0;
  for (let y = r.y; y < r.y + r.height; y++) {
    for (let x = r.x; x < r.x + r.width; x++) {
      const i = 4 * (y * png.width + x);
      if (png.data[i] > 160 && png.data[i + 1] < 50 && png.data[i + 2] < 120 && png.data[i + 3] > 220) count++;
    }
  }
  return count;
}
