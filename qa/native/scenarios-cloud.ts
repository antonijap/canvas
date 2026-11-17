// Settings > Cloud (apps/macos/CloudSettings.swift): the fields, and a sign-in against a local development server that
// stands in for the team's server (it answers /v1/info and /v1/me; the real one is run by qa/cloud-e2e.ts).
import { execFileSync } from "node:child_process";
import http from "node:http";
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

sc("settings", "Settings > Cloud: the server address, Sign in against a local development server shows Signed in as, and Sign out", { covers: ["settings:cloud"] }, async (t: NT) => {
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
