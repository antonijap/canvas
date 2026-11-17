// Settings > Cloud > Host a Cloud (apps/macos/CloudSettings.swift, src/cloud-host.ts) in the real app, with the stand-in
// tunnel helper every QA instance gets (qa/native/app.ts, test/fixtures/fake-tunnel.ts). The real tunnel is checked by
// hand (docs/cloud/hosting.md).
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { sleep, startServer, type Scratch } from "../lib.ts";
import { center, NT, sc } from "./harness.ts";

async function settingsCloud(t: NT) {
  await t.key(",", ["cmd"]);
  await t.waitState((s) => s.windows.some((w: any) => w.settings), "the Settings window");
  let b: any;
  for (let i = 0; i < 30 && !b; i++) {
    const bs = (await t.views("settings")).filter((v) => v.class === "NSToolbarButton").sort((x, y) => x.x - y.x);
    b = bs.find((v) => v.label === "Cloud") ?? (bs.length === 8 ? bs[3] : undefined);
    if (!b) await sleep(100);
  }
  t.ok(b, "no Cloud tab in the Settings toolbar");
  await t.click(center(b), { window: "settings" });
}

sc("settings", "Settings > Cloud: Host a Cloud; an invite is copied, never shown; a second Mac joins and shows as joined; the status reads Cloud down while the Cloud does not answer, then Connected", { covers: ["settings:cloud-host"] }, async (t: NT) => {
  const post = async (base: string, p: string, body: unknown = {}) => {
    const r = await fetch(base + p, { method: "POST", headers: { "x-canvas": "1", "content-type": "application/json" }, body: JSON.stringify(body) });
    return { status: r.status, j: (await r.json()) as any };
  };
  const pgrep = (args: string[]) => { try { return execFileSync("pgrep", args, { encoding: "utf8" }).trim().split("\n").filter(Boolean).map(Number); } catch { return []; } };
  const cloudPids = () => pgrep(["-P", String(t.app.server!.pid), "-f", "cloud/node/main.ts"]);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "canvas-qa-joiner-"));
  let joiner: Scratch | null = null;
  let paused: number[] = [];
  try {
    // The host is shown by its comment name: a placeholder, never this Mac's user name in a screenshot.
    await t.cmd("qa.cloud", { url: "", devEmail: "", name: "Studio Cloud", hosting: false, commentName: "Anna" });
    await settingsCloud(t);
    await t.waitText("Host a Cloud", undefined, 4000, "settings");
    await t.waitText("Everyone in a Cloud can read the comments", undefined, 4000, "settings");
    await t.click(center(await t.mark({ id: "cloud-host", window: "settings" }, 4000)), { window: "settings" });
    await t.waitText("You, the host", undefined, 15_000, "settings");
    await t.waitText("Anna", undefined, 4000, "settings");
    t.ok(await t.mark({ id: "cloud-fingerprint", window: "settings" }, 4000), "the fingerprint shows");
    await t.waitText("Connected", undefined, 15_000, "settings");
    // Add person: the link goes to the clipboard and a toast says so; the link itself is nowhere on screen.
    await t.click(center(await t.mark({ id: "cloud-invitee", window: "settings" }, 4000)), { window: "settings" });
    await t.type("ben@studio.test", { window: "settings" });
    await t.click(center(await t.mark({ id: "cloud-invite", window: "settings" }, 4000)), { window: "settings" });
    await t.waitState((s) => /^Invite for ben@studio\.test copied/.test(s.toast ?? ""), "the invite toast", 8000);
    await t.waitText("Invite waiting", undefined, 10_000, "settings");
    const shown = [...(await t.marks({ window: "settings" })), ...(await t.marks())].filter((m) => /canvas:\/\/cloud|ccj_|code=/.test(m.label ?? ""));
    t.eq(shown.length, 0, "no invite link or code on screen");
    for (const theme of ["light", "dark"]) {
      await t.cmd("qa.theme", { theme });
      await sleep(400);
      await t.shot(`${process.cwd()}/qa/out/native/settings-cloud-hosting-${theme}.png`, "settings");
    }
    // A second Mac (another Canvas server here, through the same stand-in tunnel) joins with its own invite.
    joiner = await startServer(tmp, {
      CANVAS_TUNNEL_BIN: path.join(process.cwd(), "test", "fixtures", "fake-tunnel.sh"),
      CANVAS_FAKE_TUNNEL_DIR: path.join(t.app.dir, "tunnels"),
      CANVAS_FAKE_TUNNEL_NODE: process.execPath,
      CANVAS_FAKE_TUNNEL_ANY_PORT: "1",
      CANVAS_CLOUD_SECRETS_FILE: path.join(tmp, "secrets.json"),
    });
    const inv = await post(t.app.base, "/api/cloud/host/invite", { label: "cy@studio.test" });
    t.eq(inv.status, 200, "an invite for Cy");
    const joined = await post(joiner.base, "/api/cloud/join", { link: inv.j.link, device: "Cy's MacBook" });
    t.eq(joined.status, 200, `Cy joined (${joined.j.error ?? "ok"})`);
    await t.waitText("Joined from Cy", undefined, 12_000, "settings");
    // The Cloud stops answering (its process paused, as a Mac asleep): the status says so.
    paused = cloudPids();
    t.eq(paused.length, 1, "the Cloud runs as its own process under the server");
    for (const pid of paused) process.kill(pid, "SIGSTOP");
    await t.waitText("Cloud down", undefined, 40_000, "settings");
    await t.shot(`${process.cwd()}/qa/out/native/settings-cloud-down.png`, "settings");
    for (const pid of paused) process.kill(pid, "SIGCONT");
    paused = [];
    await t.waitText("Connected", undefined, 30_000, "settings");
  } finally {
    for (const pid of paused) { try { process.kill(pid, "SIGCONT"); } catch { /* gone */ } }
    await post(t.app.base, "/api/cloud/host/stop").catch(() => {});
    await joiner?.stop().catch(() => {});
    await t.cmd("qa.cloud", { url: "", devEmail: "", name: "", hosting: false }).catch(() => {});
    await t.cmd("qa.theme", { theme: "light" }).catch(() => {});
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  await sleep(1500);
  const left = cloudPids().length + pgrep(["-f", path.join(t.app.dir, "tunnels")]).length;
  t.eq(left, 0, "no Cloud process or tunnel helper left after Stop");
});
