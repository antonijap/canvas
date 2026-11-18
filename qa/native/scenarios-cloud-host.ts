// Clouds this Mac hosts, and joining one with an invite (apps/macos/CloudSettings.swift, src/cloud-host.ts), in the real
// app with the stand-in tunnel helper every QA instance gets (qa/native/app.ts, test/fixtures/fake-tunnel.ts). The real
// tunnel is checked by hand (docs/cloud/hosting.md). Run with `pnpm qa:native cloud`.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { sleep, startServer, type Scratch } from "../lib.ts";
import { center, NT, sc } from "./harness.ts";

const SHEET = "Add Cloud" as const;

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
async function home(t: NT) {
  await t.key("0", ["cmd", "shift"]);
  await t.waitState((s) => s.homeShown, "Home to show");
}
const post = async (base: string, p: string, body: unknown = {}) => {
  const r = await fetch(base + p, { method: "POST", headers: { "x-canvas": "1", "content-type": "application/json" }, body: JSON.stringify(body) });
  return { status: r.status, j: (await r.json()) as any };
};
const pgrep = (args: string[]) => { try { return execFileSync("pgrep", args, { encoding: "utf8" }).trim().split("\n").filter(Boolean).map(Number); } catch { return []; } };

/** Host on this Mac from the sheet, under a name. Returns the new Cloud's entry. */
async function hostFromSheet(t: NT, name: string): Promise<{ id: string; url: string }> {
  const before = (await t.cmd("qa.cloud", {})).clouds.map((c: any) => c.id);
  await home(t);
  await t.click(center(await t.mark({ id: "home-add-cloud" }, 4000)));
  await t.waitState((s) => s.addCloud, "the Add Cloud sheet");
  const option = await t.mark({ id: "add-cloud-host", window: SHEET }, 4000);
  t.ok(!(await t.marks({ label: "already hosts", window: SHEET })).length, "Host on this Mac is never off because this Mac hosts another Cloud");
  await t.click(center(option), { window: SHEET });
  await t.click(center(await t.mark({ id: "add-cloud-name", window: SHEET }, 4000)), { window: SHEET });
  await t.type(name, { window: SHEET });
  await t.waitText("Only people you invite can join", undefined, 4000, SHEET);
  await t.click(center(await t.mark({ id: "add-cloud-host-go", window: SHEET })), { window: SHEET });
  await t.waitState((s) => !s.addCloud && s.homeSection === "cloud", `${name}'s page`, 20_000);
  const added = (await t.cmd("qa.cloud", {})).clouds.find((c: any) => !before.includes(c.id));
  t.ok(added && added.kind === "hosted" && added.name === name, `${name} is in the list as hosted here`);
  t.eq((await t.marks({ id: "cloud-alpha-badge" })).length, 0, "Mac hosted Clouds have no Alpha badge");
  t.eq((await t.marks({ id: "cloud-alpha-notice" })).length, 0, "Mac hosted Clouds have no Alpha notice");
  return added;
}

sc("settings", "Host on this Mac, twice: two Clouds at once, each its own page, fingerprint and people; an invite is copied, never shown; a second Mac joins one; Stop hosting one leaves the other; Delete removes it", { covers: ["settings:cloud-host", "settings:cloud-remove"] }, async (t: NT) => {
  const cloudPids = () => pgrep(["-P", String(t.app.server!.pid), "-f", "cloud/adapters/mac/main.ts"]);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "canvas-qa-joiner-"));
  let joiner: Scratch | null = null;
  try {
    // The host is shown by its comment name: a placeholder, never this Mac's user name in a screenshot.
    await t.cmd("qa.cloud", { clouds: [], commentName: "Anna" });
    const studio = await hostFromSheet(t, "Studio");
    const review = await hostFromSheet(t, "Client review");
    t.ok(studio.url !== review.url, "two Clouds, two ids");
    await t.waitFor(async () => cloudPids().length === 2, "two Cloud processes", 15_000);
    // Both rows in Home, laptops (on a Mac), and Settings marks both Hosting.
    await home(t);
    await t.mark({ id: "home-row", label: "Studio" }, 4000);
    await t.mark({ id: "home-row", label: "Client review" }, 4000);
    await settingsCloud(t);
    t.eq((await t.marks({ id: "cloud-alpha-badge", window: "settings" })).length, 0, "Mac hosted Clouds have no Alpha badge in Settings");
    await t.waitFor(async () => (await t.marks({ id: "cloud-row-word", label: "Hosting", window: "settings" })).length === 2, "both rows say Hosting", 15_000);
    await t.shot(`${process.cwd()}/qa/out/native/settings-cloud-two-hosted.png`, "settings");
    // Studio's page: its fingerprint and people; Add person copies an invite that is never on screen.
    await t.click(center(await t.mark({ id: "cloud-row", label: "Studio", window: "settings" })), { window: "settings" });
    await t.waitText("You, the host", undefined, 15_000, "settings");
    await t.waitText("Hosting on this Mac", undefined, 15_000, "settings");
    const fpStudio = (await t.mark({ id: "cloud-fingerprint", window: "settings" }, 4000)).label;
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
    await t.cmd("qa.theme", { theme: "light" });
    // Client review's page: its own fingerprint, nobody invited.
    await t.click(center(await t.mark({ id: "cloud-back", window: "settings" })), { window: "settings" });
    await t.click(center(await t.mark({ id: "cloud-row", label: "Client review", window: "settings" }, 4000)), { window: "settings" });
    await t.waitText("You, the host", undefined, 15_000, "settings");
    const fpReview = (await t.mark({ id: "cloud-fingerprint", window: "settings" }, 4000)).label;
    t.ok(fpReview && fpStudio && fpReview !== fpStudio, `each Cloud its own fingerprint (${fpStudio}, ${fpReview})`);
    t.eq((await t.marks({ label: "Invite waiting", window: "settings" })).length, 0, "Studio's invite is not Client review's");
    // A second Mac (another Canvas server here, through the same stand-in tunnel) joins Studio.
    joiner = await startServer(tmp, {
      CANVAS_TUNNEL_BIN: path.join(process.cwd(), "test", "fixtures", "fake-tunnel.sh"),
      CANVAS_FAKE_TUNNEL_DIR: path.join(t.app.dir, "tunnels"),
      CANVAS_FAKE_TUNNEL_NODE: process.execPath,
      CANVAS_FAKE_TUNNEL_ANY_PORT: "1",
      CANVAS_CLOUD_SECRETS_FILE: path.join(tmp, "secrets.json"),
    });
    const studioId = studio.url.replace("canvas-cloud://", "");
    const inv = await post(t.app.base, "/api/cloud/host/invite", { label: "cy@studio.test", hostId: studioId });
    t.eq(inv.status, 200, "an invite to Studio for Cy");
    t.eq(new URL(inv.j.link).searchParams.get("host"), studioId, "it names Studio");
    const joined = await post(joiner.base, "/api/cloud/join", { link: inv.j.link, device: "Cy's MacBook" });
    t.eq(joined.status, 200, `Cy joined (${joined.j.error ?? "ok"})`);
    t.eq(joined.j.url, studio.url, "Cy is in Studio");
    // Stop hosting Client review: Studio runs on.
    await t.click(center(await t.mark({ id: "cloud-stop-hosting", window: "settings" }, 4000)), { window: "settings" });
    await t.waitState((s) => s.modal, "Stop asks first", 6000);
    await t.key("Return", [], { window: "modal" });
    await t.waitText("Not hosting", undefined, 15_000, "settings");
    await t.waitFor(async () => cloudPids().length === 1, "one Cloud process left", 15_000);
    const st = (await (await fetch(`${t.app.base}/api/cloud/status?url=${encodeURIComponent(studio.url)}&fresh=1`)).json()) as any;
    t.eq(st.status, "connected", "Studio is still up");
    // Delete Client review: asked first, gone from the list, its data gone; Studio stays.
    await t.click(center(await t.mark({ id: "cloud-remove-cloud", window: "settings" }, 4000)), { window: "settings" });
    await t.waitState((s) => s.modal, "Delete asks first", 6000);
    await t.shot(`${process.cwd()}/qa/out/native/cloud-delete-ask.png`, "modal");
    await t.key("Return", [], { window: "modal" });
    await t.waitFor(async () => (await t.cmd("qa.cloud", {})).clouds.length === 1, "Client review to leave the list", 10_000);
    const hosts = (await (await fetch(`${t.app.base}/api/cloud/host`)).json()) as any;
    t.ok(!hosts.clouds.some((c: any) => c.hostId === review.url.replace("canvas-cloud://", "")), "this Mac no longer keeps Client review");
  } finally {
    await post(t.app.base, "/api/cloud/host/stop").catch(() => {});
    await joiner?.stop().catch(() => {});
    await t.key("w", ["cmd"], { window: "settings" }).catch(() => {});
    await t.cmd("qa.cloud", { clouds: [] }).catch(() => {});
    await t.cmd("qa.theme", { theme: "light" }).catch(() => {});
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  await sleep(1500);
  const left = cloudPids().length + pgrep(["-f", path.join(t.app.dir, "tunnels")]).length;
  t.eq(left, 0, "no Cloud process or tunnel helper left after Stop");
});

sc("settings", "Join with an invite: the sheet reads the link, shows the Cloud's name, fingerprint and what joining means before Join, adds the Cloud as a laptop row; the same invite twice says already in; a link from outside opens the sheet, never shows the link", { covers: ["settings:cloud-join", "home:clouds"] }, async (t: NT) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "canvas-qa-host-"));
  let host: Scratch | null = null;
  try {
    await t.cmd("qa.cloud", { clouds: [] });
    // Another Mac hosts "Team Cloud" (another Canvas server here, through the same stand-in tunnel).
    host = await startServer(tmp, {
      CANVAS_TUNNEL_BIN: path.join(process.cwd(), "test", "fixtures", "fake-tunnel.sh"),
      CANVAS_FAKE_TUNNEL_DIR: path.join(t.app.dir, "tunnels"),
      CANVAS_FAKE_TUNNEL_NODE: process.execPath,
      CANVAS_FAKE_TUNNEL_ANY_PORT: "1",
      CANVAS_CLOUD_HOST_PORT: "0",
      CANVAS_CLOUD_SECRETS_FILE: path.join(tmp, "secrets.json"),
    });
    const started = await post(host.base, "/api/cloud/host/start", { name: "Team Cloud", label: "Ben" });
    t.eq(started.status, 200, "the other Mac hosts");
    const inv = await post(host.base, "/api/cloud/host/invite", { label: "anna@studio.test" });
    const link = inv.j.link as string;
    await home(t);
    await t.click(center(await t.mark({ id: "home-add-cloud" }, 4000)));
    await t.waitState((s) => s.addCloud, "the Add Cloud sheet");
    await t.click(center(await t.mark({ id: "add-cloud-join", window: SHEET }, 4000)), { window: SHEET });
    await t.click(center(await t.mark({ id: "add-cloud-link", window: SHEET }, 4000)), { window: SHEET });
    await t.cmd("qa.pasteboard", { set: link });
    await t.key("v", ["cmd"], { window: SHEET });
    // Before Join: the name, the fingerprint, and every disclosure line.
    await t.mark({ id: "text", label: "Team Cloud", window: SHEET }, 4000);
    await t.mark({ id: "add-cloud-fingerprint", window: SHEET });
    await t.mark({ id: "add-cloud-disclosure", window: SHEET });
    await t.waitText("Everyone in a Cloud can read the comments", undefined, 4000, SHEET);
    await t.shot(`${process.cwd()}/qa/out/native/add-cloud-join.png`, SHEET);
    await t.click(center(await t.mark({ id: "add-cloud-join-go", window: SHEET })), { window: SHEET });
    await t.waitState((s) => !s.addCloud && s.homeSection === "cloud", "Team Cloud's page", 20_000);
    const list = (await t.cmd("qa.cloud", {})).clouds;
    t.ok(list.length === 1 && list[0].kind === "joined" && list[0].name === "Team Cloud", "joined, by its name");
    await t.mark({ id: "home-row", label: "Team Cloud" }, 4000);
    t.ok(await t.mark({ id: "home-row-glyph", label: "Team Cloud" }), "a row with its glyph (a laptop: the Cloud lives on a Mac)");
    // The same Cloud again, from a link opened outside Canvas: the sheet says so, Join is off, the link is not shown.
    const again = await post(host.base, "/api/cloud/host/invite", { label: "anna@studio.test" });
    await t.cmd("qa.openurl", { url: again.j.link });
    await t.waitState((s) => s.addCloud, "the sheet, from the link", 6000);
    await t.mark({ id: "text", label: "Already in this Cloud", window: SHEET }, 4000);
    const shown = (await t.marks({ window: SHEET })).filter((m) => /canvas:\/\/cloud|ccj_|code=/.test(m.label ?? ""));
    t.eq(shown.length, 0, "the link opened from outside is not on screen");
    await t.click(center(await t.mark({ id: "add-cloud-cancel", window: SHEET })), { window: SHEET });
    await t.waitState((s) => !s.addCloud, "Cancel closes the sheet");
  } finally {
    await post(host?.base ?? "", "/api/cloud/host/stop").catch(() => {});
    await host?.stop().catch(() => {});
    await t.cmd("qa.cloud", { clouds: [] }).catch(() => {});
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
