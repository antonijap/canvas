// Settings > Cloud (apps/macos/CloudSettings.swift): the fields, and a sign-in against a local development server that
// stands in for the team's server (it answers /v1/info and /v1/me; the real one is run by qa/cloud-e2e.ts).
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { sleep } from "../lib.ts";
import { center, NT, sc } from "./harness.ts";

async function tab(t: NT, label: string, index: number) {
  let b: any;
  for (let i = 0; i < 30 && !b; i++) {
    const bs = (await t.views("settings")).filter((v) => v.class === "NSToolbarButton").sort((x, y) => x.x - y.x);
    b = bs.find((v) => v.label === label) ?? (bs.length === 8 ? bs[index] : undefined);
    if (!b) await sleep(100);
  }
  t.ok(b, `no ${label} tab in the Settings toolbar`);
  await t.click(center(b), { window: "settings" });
}
async function settingsCloud(t: NT) {
  await t.key(",", ["cmd"]);
  await t.waitState((s) => s.windows.some((w: any) => w.settings), "the Settings window");
  await tab(t, "Cloud", 3);
}

sc("settings", "Settings > Cloud: the server address, Sign in against a local development server opens Home on the server with a connected toast, shows Signed in as, and Sign out", { covers: ["settings:cloud"] }, async (t: NT) => {
  const asked: { url: string; email: string | undefined; token: string | undefined }[] = [];
  const team = http.createServer((req, res) => {
    asked.push({ url: req.url ?? "", email: req.headers["x-canvas-dev-email"] as string | undefined, token: req.headers["cf-access-token"] as string | undefined });
    res.writeHead(200, { "content-type": "application/json" });
    res.end(req.url === "/v1/info" ? JSON.stringify({ protocol: 1, server: "0.1.0", capabilities: ["comments"] }) : JSON.stringify({ email: "anna@studio.test", name: "anna", role: "owner" }));
  });
  await new Promise<void>((r) => team.listen(0, "127.0.0.1", r));
  const port = (team.address() as { port: number }).port;
  try {
    await settingsCloud(t);
    await t.waitText("Server address", undefined, 4000, "settings");
    await t.waitText("Not signed in", undefined, 4000, "settings");
    const status = await t.mark({ id: "cloud-status", window: "settings" }, 4000);
    t.ok(status, "the status line is there");
    await t.waitText("No server", undefined, 4000, "settings");
    const url = await t.mark({ id: "cloud-url", window: "settings" }, 4000);
    await t.click(center(url), { window: "settings" });
    await t.type(`http://127.0.0.1:${port}`, { window: "settings" });
    // A local address shows the development email, and Sign in needs it.
    await t.waitText("Development email", undefined, 4000, "settings");
    const email = await t.mark({ id: "cloud-dev-email", window: "settings" }, 4000);
    await t.click(center(email), { window: "settings" });
    await t.type("anna@studio.test", { window: "settings" });
    const signIn = await t.mark({ id: "cloud-sign-in", window: "settings" }, 4000);
    await t.click(center(signIn), { window: "settings" });
    // Connected: Settings steps aside, Home opens on the team server, and a toast says so.
    const host = `127.0.0.1:${port}`;
    await t.waitState((s) => s.homeShown && s.homeSection === "server" && !s.windows.some((w: any) => w.settings), "Home on the team server, Settings closed", 8000);
    await t.waitState((s) => s.toast === `You\u2019re connected to ${host}` && s.toastKind === "success", "the connected toast");
    await t.waitText("Connected as anna@studio.test, owner", undefined, 8000);
    await t.shot(`${process.cwd()}/qa/out/native/cloud-connected-home.png`);
    await settingsCloud(t);
    await t.waitText("Signed in as anna@studio.test, owner", undefined, 8000, "settings");
    await t.waitText("Connected", undefined, 4000, "settings");
    t.ok(asked.some((a) => a.url === "/v1/me" && a.email === "anna@studio.test" && a.token === undefined), "the server was asked who this is, with the development email and no token");
    // Light and dark (the theme is General's switch).
    for (const theme of ["Light", "Dark"]) {
      await tab(t, "General", 0);
      await t.click(await t.waitText(theme, undefined, 4000, "settings"), { window: "settings" });
      await t.waitState((s) => s.theme === theme.toLowerCase(), `the ${theme} theme`);
      await tab(t, "Cloud", 3);
      await t.waitText("Signed in as anna@studio.test, owner", undefined, 8000, "settings");
      await t.shot(`${process.cwd()}/qa/out/native/settings-cloud-${theme.toLowerCase()}.png`, "settings");
    }
    const read = (key: string) => { try { return execFileSync("defaults", ["read", t.app.bundleId, key], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim(); } catch { return ""; } };
    for (let i = 0; i < 30 && !read("canvas.settings.cloudUrl"); i++) await sleep(150);
    t.eq(read("canvas.settings.cloudUrl"), `http://127.0.0.1:${port}`, "the address is stored");
    t.ok(!/token|CF_Authorization/i.test(execFileSync("defaults", ["read", t.app.bundleId], { encoding: "utf8" })), "no token in the preferences");
    // Sign out forgets the development email: signed out again.
    await t.click(center(await t.mark({ id: "cloud-sign-out", window: "settings" }, 4000)), { window: "settings" });
    await t.waitText("Not signed in", undefined, 8000, "settings");
    await t.waitText("Signed out", undefined, 8000, "settings");
    // Signed in again, then the server goes away
    await t.click(center(await t.mark({ id: "cloud-dev-email", window: "settings" }, 4000)), { window: "settings" });
    await t.type("anna@studio.test", { window: "settings" });
    await t.click(center(await t.mark({ id: "cloud-sign-in", window: "settings" }, 4000)), { window: "settings" });
    await t.waitState((s) => s.homeShown && !s.windows.some((w: any) => w.settings), "Home again after the second sign-in", 8000);
    await settingsCloud(t);
    await t.waitText("Connected", undefined, 8000, "settings");
    // The pane says Offline.
    await new Promise<void>((r) => team.close(() => r()));
    team.closeAllConnections();
    await t.waitText("Offline", undefined, 12000, "settings");
  } finally {
    team.closeAllConnections();
    if (team.listening) await new Promise<void>((r) => team.close(() => r()));
  }
});

sc("settings", "Settings > Cloud: a name for the team server shows in Home's sidebar, its view and a shared file's card, a rename follows, an empty name is the host; the shared file itself never names the server", { covers: ["settings:cloud-name", "home:server-name", "comments:shared-bar"] }, async (t: NT) => {
  const team = http.createServer((req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(req.url === "/v1/info" ? JSON.stringify({ protocol: 1, server: "0.1.0", capabilities: ["comments"] }) : JSON.stringify({ email: "anna@studio.test", name: "anna", role: "owner" }));
  });
  await new Promise<void>((r) => team.listen(0, "127.0.0.1", r));
  const port = (team.address() as { port: number }).port;
  const url = `http://127.0.0.1:${port}`, host = `127.0.0.1:${port}`;
  // The open file is shared to that server: its comments name it, as a share leaves them.
  const doc = crypto.randomUUID();
  const thread = { id: crypto.randomUUID(), doc, anchor: { nodeId: "x", x: 0, y: 0, board: "b" }, createdAt: new Date().toISOString(), createdBy: { name: "Anna", email: "anna@studio.test" }, comments: [{ id: crypto.randomUUID(), body: "c", author: { name: "Anna", email: "anna@studio.test" }, createdAt: new Date().toISOString() }] };
  fs.writeFileSync(path.join(t.file, "comments.json"), JSON.stringify({ format: 1, doc, seq: 0, server: { url }, threads: [thread], outbox: [] }));
  const read = (key: string) => { try { return execFileSync("defaults", ["read", t.app.bundleId, key], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim(); } catch { return ""; } };
  const rename = async (name: string) => {
    await settingsCloud(t);
    const field = await t.mark({ id: "cloud-name", window: "settings" }, 4000);
    await t.click(center(field), { window: "settings" });
    // The caret lands after the text (the field is wider than any name here); Delete clears it key by key.
    await t.key("Delete", [], { window: "settings", repeat: 70 });
    if (name) await t.type(name, { window: "settings" });
    await t.cmd("qa.reset");
    await t.key("0", ["cmd", "shift"]);
    await t.waitState((s) => s.homeShown, "Home to show");
  };
  try {
    await t.cmd("qa.cloud", { url, devEmail: "anna@studio.test" });
    // The shared file, open: the comments bar shows the people and a dot, never the server's name or host.
    await t.js(`return window.canvasHost.comments.reload();`);
    await t.waitJs(`document.querySelector(".cm-shared")?.classList.contains("on")`, "the shared bar", 12_000);
    const bar = await t.js<{ text: string; label: string; title: string }>(`const b = document.querySelector(".cm-shared"); return { text: b.innerText, label: b.getAttribute("aria-label") || "", title: b.querySelector(".cm-server")?.title || "" };`);
    t.ok(!(bar.text + bar.label + bar.title).includes("127.0.0.1"), `the file shows no server name: ${JSON.stringify(bar)}`);
    await t.shot(`${process.cwd()}/qa/out/native/cloud-shared-file-bar.png`);
    // No name yet: Home calls the server by its host.
    await t.key("0", ["cmd", "shift"]);
    await t.waitState((s) => s.homeShown, "Home to show");
    await t.mark({ id: "home-row", label: host }, 6000);
    // A name, typed in Settings > Cloud.
    await rename("Studio team");
    await t.mark({ id: "home-row", label: "Studio team" }, 6000);
    t.eq((await t.marks({ id: "home-row", label: host })).length, 0, "the host is gone from the sidebar");
    for (let i = 0; i < 30 && read("canvas.settings.cloudName") !== "Studio team"; i++) await sleep(150);
    t.eq(read("canvas.settings.cloudName"), "Studio team", "the name is stored with the server's address");
    await t.waitText("Studio team", undefined, 6000); // the shared file's card names it too
    t.ok((await t.marks({ label: "Studio team" })).filter((m) => m.id !== "home-row" && m.id !== "home-row-glyph").length >= 1, "the shared file's card names the server by its name");
    await t.click(center(await t.mark({ id: "home-row", label: "Studio team" })));
    await t.waitState((s) => s.homeSection === "server", "the server view");
    await t.waitFor(async () => (await t.marks({ label: "Studio team" })).length >= 2, "the server view's title", 4000);
    await t.shot(`${process.cwd()}/qa/out/native/cloud-server-name-home.png`);
    // Renamed later.
    await rename("Design crew");
    await t.mark({ id: "home-row", label: "Design crew" }, 6000);
    t.eq((await t.marks({ id: "home-row", label: "Studio team" })).length, 0, "the old name is gone");
    // Emptied: the host again.
    await rename("");
    await t.mark({ id: "home-row", label: host }, 6000);
  } finally {
    await t.cmd("qa.cloud", { url: "", devEmail: "", name: "" }).catch(() => {});
    team.closeAllConnections();
    if (team.listening) await new Promise<void>((r) => team.close(() => r()));
  }
});
