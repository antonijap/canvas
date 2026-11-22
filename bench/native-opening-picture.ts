import fs from "node:fs";
import path from "node:path";
import type { QaApp } from "../qa/native/app.ts";
import { center, NT } from "../qa/native/harness.ts";
import { fixture, scratchCopy } from "./fixtures/gen.ts";
import { measureOpen } from "./native-open.ts";

type Camera = { page: string; x: number; y: number; z: number };
type Opening = { window: number; action: number; saved?: number; live?: number; switched?: number; view?: Camera };
type OpeningKind = "launch-last-file" | "open-recent";

export const openingState = (app: QaApp) => app.cmd<Opening>({ op: "qa.opening" });
export const cameraState = (t: NT) => t.js<Camera>("const h = window.canvasHost; return { page: h.page, ...h.cam };");

export async function recentCard(t: NT, file: string) {
  await t.click(center(await t.mark({ id: "home-tab" })));
  return center(await t.mark({ id: "home-card", label: path.basename(file, ".canvas"), exact: true }));
}

export async function measureOpeningPicture(app: QaApp, kind: OpeningKind, boards = 36) {
  const file = scratchCopy(fixture(boards), app.docs, "Opening sample.canvas").dir;
  const t: NT = new NT(app, file);
  try {
    const initial = await measureOpen(app, file);
    t.ok(initial.picture != null, "opening sample has a live picture");
    const camera = await cameraState(t);
    let launchedAt = 0;
    if (kind === "launch-last-file") {
      await app.relaunch({ restartServer: true, onLaunch: () => { launchedAt = Date.now(); } });
    } else {
      await t.cmd("qa.savepicture");
      await t.cmd("close", { file });
      await t.waitState(s => !s.openFiles.includes(file), "the sample tab to close");
      const card = await recentCard(t, file);
      await t.click(card);
    }
    const opening = await t.waitFor(async () => {
      const result = await openingState(app);
      return result.live != null && result;
    }, "the exact native opening frame", 15_000);
    t.eq(await cameraState(t), camera, "the live view restores the camera and page");
    if (opening.view) t.eq(opening.view, camera, "the saved view has the live camera and page");
    const pictureStart = kind === "launch-last-file" ? opening.window : opening.action;
    const liveStart = kind === "launch-last-file" ? launchedAt : opening.action;
    return {
      picture: (opening.saved ?? opening.live!) - pictureStart,
      live: opening.live! - liveStart,
      ...(kind === "launch-last-file" ? { liveFromWindow: opening.live! - opening.window } : {}),
      saved: opening.saved != null,
    };
  } finally {
    await t.cmd("close", { file }).catch(() => {});
    fs.rmSync(file, { recursive: true, force: true });
  }
}
