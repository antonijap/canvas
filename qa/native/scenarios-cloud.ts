// Many Clouds (apps/macos/CloudSettings.swift, Home.swift): the Add Cloud sheet, Home's rows and pages, Settings > Cloud's
// list and pages, sharing to a chosen Cloud and removing one. Local development servers stand in for team servers
// (they answer /v1/info, /v1/me and /v1/docs; the real one is run by qa/cloud-e2e.ts). Run with `pnpm qa:native cloud`.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { sleep } from "../lib.ts";
import { center, NT, sc } from "./harness.ts";

const SHEET = "Add Cloud" as const;

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
async function home(t: NT) {
  await t.key("0", ["cmd", "shift"]);
  await t.waitState((s) => s.homeShown, "Home to show");
}

/** A team server in DEV mode on this Mac: who asked, with which email. */
async function team(email = "anna@studio.test") {
  const asked: { url: string; email?: string; token?: string }[] = [];
  const srv = http.createServer((req, res) => {
    asked.push({ url: req.url ?? "", email: req.headers["x-canvas-dev-email"] as string | undefined, token: req.headers["cf-access-token"] as string | undefined });
    res.writeHead(200, { "content-type": "application/json" });
    if (req.url === "/v1/info") res.end(JSON.stringify({ protocol: 1, server: "0.1.0", capabilities: ["comments"] }));
    else if (req.url === "/v1/me") res.end(JSON.stringify({ email, name: "anna", role: "owner" }));
    else res.end(JSON.stringify({ ok: true }));
  });
  srv.on("upgrade", (_req, sock) => sock.destroy());
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${(srv.address() as { port: number }).port}`;
  return { url, host: url.replace("http://", ""), asked, close: async () => { srv.closeAllConnections(); if (srv.listening) await new Promise<void>((r) => srv.close(() => r())); } };
}

sc("settings", "Add Cloud: the sheet from Home's + offers Join, This Mac and Cloudflare Alpha; a local server asks for its email, connects, gets a row and a page; Settings > Cloud lists it and opens its page; Sign out; Offline speaks", { covers: ["settings:add-cloud", "settings:cloud", "home:clouds"] }, async (t: NT) => {
  const a = await team();
  try {
    await t.cmd("qa.cloud", { clouds: [] });
    await home(t);
    await t.click(center(await t.mark({ id: "home-add-cloud" }, 4000)));
    await t.waitState((s) => s.addCloud, "the Add Cloud sheet");
    for (const id of ["add-cloud-join", "add-cloud-host", "add-cloud-server"]) await t.mark({ id, window: SHEET }, 4000);
    await t.waitText("Add a Cloud", undefined, 4000, SHEET);
    const join = await t.mark({ id: "add-cloud-join", label: "Join with an invite", window: SHEET });
    const mac = await t.mark({ id: "add-cloud-host", label: "This Mac", window: SHEET });
    const adapter = await t.mark({ id: "add-cloud-server", label: "Cloudflare", window: SHEET });
    await t.waitText("Run your own Cloud on", undefined, 4000, SHEET);
    t.ok(join.y < mac.y && mac.y < adapter.y, "Join comes first, then This Mac, then Cloudflare");
    await t.waitText("Free, no account. Live while this Mac is awake", undefined, 4000, SHEET);
    await t.waitText("Always on, on your Cloudflare account", undefined, 4000, SHEET);
    t.eq((await t.marks({ id: "add-cloud-alpha", label: "Alpha", window: SHEET })).length, 1, "only Cloudflare gets Alpha in the sheet");
    await t.shot(`${process.cwd()}/qa/out/native/add-cloud-pick.png`, SHEET);
    // Connect a server: an address Canvas cannot use gets a hint and no Connect.
    await t.click(center(await t.mark({ id: "add-cloud-server", window: SHEET })), { window: SHEET });
    await t.click(center(await t.mark({ id: "cloud-url", window: SHEET }, 4000)), { window: SHEET });
    await t.type("studio", { window: SHEET });
    await t.waitText("Use an https address, like https://studio.workers.dev", undefined, 4000, SHEET);
    await t.click(center(await t.mark({ id: "add-cloud-server-go", window: SHEET })), { window: SHEET });
    await sleep(400);
    t.eq((await t.cmd("qa.cloud", {})).clouds.length, 0, "Connect with a bad address adds nothing");
    await t.key("a", ["cmd"], { window: SHEET });
    await t.type("https://studio.workers.dev", { window: SHEET });
    t.eq((await t.marks({ id: "add-cloud-dev-email", window: SHEET })).length, 0, "remote servers hide development email");
    await t.key("a", ["cmd"], { window: SHEET });
    await t.type(a.url, { window: SHEET });
    // A local server takes a development email in place of a sign-in.
    await t.click(center(await t.mark({ id: "add-cloud-dev-email", window: SHEET }, 4000)), { window: SHEET });
    await t.type("anna@studio.test", { window: SHEET });
    await t.click(center(await t.mark({ id: "add-cloud-server-name", window: SHEET })), { window: SHEET });
    await t.type("Studio", { window: SHEET });
    await t.shot(`${process.cwd()}/qa/out/native/add-cloud-server.png`, SHEET);
    await t.click(center(await t.mark({ id: "add-cloud-server-go", window: SHEET })), { window: SHEET });
    // Connected: the sheet goes, Home opens on the new Cloud's page, a toast says so.
    await t.waitState((s) => !s.addCloud && s.homeShown && s.homeSection === "cloud", "the new Cloud's page", 10_000);
    await t.waitState((s) => s.toast === "You’re connected to Studio" && s.toastKind === "success", "the connected toast", 8000);
    await t.mark({ id: "home-row", label: "Studio" }, 4000);
    t.ok(a.asked.some((x) => x.url === "/v1/me" && x.email === "anna@studio.test" && !x.token), "asked who this is with the development email, no token");
    await t.mark({ id: "cloud-alpha-badge", label: "Alpha" }, 4000);
    await t.mark({ id: "cloud-alpha-notice", label: "The Cloudflare adapter is in Alpha: it works, but it is not yet well tested. Keep your own copies of important files." }, 4000);
    await t.shot(`${process.cwd()}/qa/out/native/cloud-page-new.png`);
    // Settings > Cloud: the list, then the Cloud's page from its row, and back.
    await t.click(center(await t.mark({ id: "home-cloud-settings" }, 4000)));
    await t.waitState((s) => s.windows.some((w: any) => w.settings), "Settings from the gear");
    await t.waitText("Signed in as anna@studio.test, owner", undefined, 8000, "settings");
    await t.mark({ id: "cloud-address", label: a.host, window: "settings" }, 4000);
    await t.mark({ id: "cloud-alpha-badge", label: "Alpha", window: "settings" }, 4000);
    t.eq((await t.marks({ id: "cloud-fingerprint", window: "settings" })).length + (await t.marks({ id: "cloud-invitee", window: "settings" })).length, 0, "a server Cloud shows its address and account, no people");
    for (const theme of ["light", "dark"]) {
      await t.cmd("qa.theme", { theme });
      await sleep(400);
      await t.shot(`${process.cwd()}/qa/out/native/settings-cloud-page-${theme}.png`, "settings");
    }
    await t.cmd("qa.theme", { theme: "light" });
    await t.click(center(await t.mark({ id: "cloud-back", window: "settings" })), { window: "settings" });
    await t.mark({ id: "cloud-row", label: "Studio", window: "settings" }, 4000);
    await t.mark({ id: "cloud-alpha-badge", label: "Alpha", window: "settings" }, 4000);
    await t.mark({ id: "cloud-add", window: "settings" });
    t.eq((await t.marks({ id: "cloud-filter", window: "settings" })).length, 0, "no filter for one Cloud");
    t.eq((await t.marks({ id: "cloud-row-word", window: "settings" })).length, 0, "a Cloud that works says nothing in the list");
    await t.click(center(await t.mark({ id: "cloud-row", label: "Studio", window: "settings" })), { window: "settings" });
    await t.waitText("Signed in as anna@studio.test, owner", undefined, 8000, "settings");
    const read = (key: string) => { try { return execFileSync("defaults", ["read", t.app.bundleId, key], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim(); } catch { return ""; } };
    t.ok(!/token|CF_Authorization/i.test(execFileSync("defaults", ["read", t.app.bundleId], { encoding: "utf8" })), "no token in the preferences");
    t.eq(read("canvas.settings.cloudUrl"), "", "no single-Cloud setting is written any more");
    // Sign out forgets the development email.
    await t.click(center(await t.mark({ id: "cloud-sign-out", window: "settings" }, 4000)), { window: "settings" });
    await t.waitText("Not signed in", undefined, 8000, "settings");
    t.eq((await t.cmd("qa.cloud", {})).clouds[0].devEmail, "", "signing out of a local server forgets its email");
    // The server goes away: its row says so, in grey.
    await t.cmd("qa.cloud", { clouds: [{ url: a.url, name: "Studio", devEmail: "anna@studio.test" }] });
    await a.close();
    await t.key("w", ["cmd"], { window: "settings" }).catch(() => {});
    await home(t);
    await t.waitFor(async () => (await t.marks({ id: "home-cloud-word" })).some((m) => m.label === "Offline"), "the row to say Offline", 40_000);
  } finally {
    await t.cmd("qa.cloud", { clouds: [] }).catch(() => {});
    await t.cmd("qa.theme", { theme: "light" }).catch(() => {});
    await a.close();
  }
});

sc("settings", "Many Clouds: 36 Clouds sorted by name, Home's sidebar scrolls and its search finds Clouds, Settings > Cloud filters them and says how many more; a row speaks only when it needs you", { covers: ["settings:cloud-many", "home:clouds"] }, async (t: NT) => {
  // 35 servers (one per client; none signed in, so nothing is sent to any of them) and one local server that works.
  const a = await team();
  const clouds = Array.from({ length: 35 }, (_, i) => ({ url: `https://client${String(i + 1).padStart(2, "0")}.example.com`, name: `Client ${String(i + 1).padStart(2, "0")}` }));
  try {
    await t.cmd("qa.cloud", { clouds: [...clouds, { url: a.url, name: "Acme", devEmail: "anna@studio.test" }] });
    await home(t);
    await t.mark({ id: "home-row", label: "Acme" }, 6000);
    // Sorted by name: Acme first. The ones that need a sign-in say so; Acme says nothing.
    await t.waitFor(async () => (await t.marks({ id: "home-cloud-word", label: "Sign in" })).length > 3, "Sign in on the servers", 20_000);
    const acme = await t.mark({ id: "home-row", label: "Acme" });
    const first = await t.mark({ id: "home-row", label: "Client 01" });
    t.ok(acme.y < first.y, "sorted by name");
    t.ok(!(await t.marks({ id: "home-cloud-word" })).some((m) => Math.abs(m.y + m.h / 2 - (acme.y + acme.h / 2)) < 2), "a Cloud that works shows no word");
    const list = await t.mark({ id: "home-clouds" });
    const visible = (await t.marks({ id: "home-row" })).filter((r) => r.label?.startsWith("Client"));
    t.ok(visible.length < 35, `the Clouds list scrolls inside the sidebar (${visible.length} of 35 in view)`);
    t.ok(list.y + list.h <= (await t.state()).window.height, "and stays in the window");
    await t.shot(`${process.cwd()}/qa/out/native/home-many-clouds.png`);
    // Each search word matches anywhere in the name: 3 also finds 13 and 23.
    await t.click(center(await t.mark({ id: "home-search" })));
    await t.type("client 3");
    await sleep(400);
    const found = (await t.marks({ id: "home-row" })).map((r) => r.label).filter((l) => l?.startsWith("Client") || l === "Acme");
    t.eq(found.sort(), ["Client 03", "Client 13", "Client 23", "Client 30", "Client 31", "Client 32", "Client 33", "Client 34", "Client 35"], `search finds Clouds (${found})`);
    await t.key("a", ["cmd"]);
    await t.key("Delete");
    // Settings > Cloud: a filter past 8 Clouds, nine rows, and how many more.
    await settingsCloud(t);
    await t.mark({ id: "cloud-filter", window: "settings" }, 4000);
    await t.waitText("27 more, scroll or filter", undefined, 4000, "settings");
    await t.shot(`${process.cwd()}/qa/out/native/settings-cloud-many.png`, "settings");
    await t.click(center(await t.mark({ id: "cloud-filter", window: "settings" })), { window: "settings" });
    await t.type("acme", { window: "settings" });
    await sleep(400);
    t.eq((await t.marks({ id: "cloud-row", window: "settings" })).map((r) => r.label), ["Acme"], "the filter narrows the list");
    await t.click(center(await t.mark({ id: "cloud-row", label: "Acme", window: "settings" })), { window: "settings" });
    await t.mark({ id: "cloud-back", window: "settings" }, 4000);
    await t.click(center(await t.mark({ id: "cloud-back", window: "settings" })), { window: "settings" });
    await t.mark({ id: "cloud-filter", window: "settings" }, 4000);
  } finally {
    await t.key("w", ["cmd"], { window: "settings" }).catch(() => {});
    await t.cmd("qa.cloud", { clouds: [] }).catch(() => {});
    await a.close();
  }
});

sc("settings", "Two Clouds: sharing a file asks which one, the file goes to the one chosen; removing a Cloud asks first, takes its row and page, and its files stop syncing", { covers: ["settings:cloud-share-pick", "settings:cloud-remove", "home:clouds"] }, async (t: NT) => {
  const a = await team(), b = await team();
  try {
    await t.cmd("qa.cloud", { clouds: [{ url: a.url, name: "Acme", devEmail: "anna@studio.test" }, { url: b.url, name: "Birch", devEmail: "anna@studio.test" }] });
    await home(t);
    await t.mark({ id: "home-row", label: "Birch" }, 6000);
    await t.waitFor(async () => {
      const st = (await t.cmd("qa.cloud", {})).states as Record<string, { status: string }>;
      return st[a.url]?.status === "connected" && st[b.url]?.status === "connected";
    }, "both Clouds connected", 20_000);
    // Back to the file, then File > Share Comments to Cloud: a question with the Clouds in a menu.
    await t.key("1", ["cmd"]).catch(() => {});
    await t.app.cmd({ op: "open", args: { file: t.file }, timeoutMs: 15_000 });
    await t.waitState((s) => s.file === t.file && !s.homeShown, "the file", 10_000);
    void t.cmd("qa.mainmenu", { title: "Share Comments to Cloud…", perform: true }).catch(() => {});
    await t.waitState((s) => s.modal, "the question which Cloud", 10_000);
    await t.shot(`${process.cwd()}/qa/out/native/share-pick.png`, "modal");
    // The first Cloud in the menu is chosen: Share.
    { const button = (await t.views("modal")).find(v => v.kind === "button" && v.title === "Share"); t.ok(button, "Share button"); await t.click(center(button), { window: "modal" }); }
    await t.waitState((s) => !s.modal, "the question to close", 6000);
    await t.waitState((s) => /^Comments shared to Acme/.test(s.toast ?? ""), "the shared toast names the Cloud", 10_000);
    const comments = () => { try { return JSON.parse(fs.readFileSync(path.join(t.file, "comments.json"), "utf8")); } catch { return null; } };
    t.eq(comments()?.server?.url, a.url, "the file names the Cloud chosen");
    t.ok(a.asked.some((x) => x.url === "/v1/docs") && !b.asked.some((x) => x.url === "/v1/docs"), "only that Cloud registered it");
    // Remove Acme: asked first; its row and page go; the file keeps its comments, its sync says the Cloud is gone.
    await settingsCloud(t);
    await t.cmd("qa.cloud", { select: (await t.cmd("qa.cloud", {})).clouds.find((c: any) => c.url === a.url).id });
    await t.click(center(await t.mark({ id: "cloud-remove-cloud", window: "settings" }, 4000)), { window: "settings" });
    await t.waitState((s) => s.modal, "Remove asks first", 6000);
    await t.shot(`${process.cwd()}/qa/out/native/cloud-remove-ask.png`, "modal");
    { const button = (await t.views("modal")).find(v => v.kind === "button" && v.title === "Remove"); t.ok(button, "Remove button"); await t.click(center(button), { window: "modal" }); }
    await t.waitFor(async () => (await t.cmd("qa.cloud", {})).clouds.length === 1, "Acme to leave the list", 8000);
    await t.mark({ id: "cloud-row", label: "Birch", window: "settings" }, 4000);
    t.eq((await t.marks({ id: "cloud-row", label: "Acme", window: "settings" })).length, 0, "its row is gone");
    const before = a.asked.length;
    await sleep(2500);
    t.eq(a.asked.length, before, "nothing more goes to a removed Cloud");
    t.eq(comments()?.server?.url, a.url, "the file keeps its comments and still names where they were shared");
    const sync = await t.js<{ status: string }>(`return (await (await fetch("/api/comments?file=" + encodeURIComponent(${JSON.stringify(t.file)}))).json()).sync;`);
    t.eq(sync.status, "notAdded", "its sync says the Cloud is not one of yours");
  } finally {
    await t.key("w", ["cmd"], { window: "settings" }).catch(() => {});
    await t.cmd("qa.cloud", { clouds: [] }).catch(() => {});
    try { fs.rmSync(path.join(t.file, "comments.json"), { force: true }); } catch { /* none */ }
    await a.close();
    await b.close();
  }
});

sc("settings", "A Cloud's name, typed on its page in Settings, names its row, its page and its files' cards; empty, the host; the shared file itself never names the Cloud", { covers: ["settings:cloud-name", "home:server-name", "comments:shared-bar"] }, async (t: NT) => {
  const a = await team();
  const doc = crypto.randomUUID();
  const thread = { id: crypto.randomUUID(), doc, anchor: { nodeId: "x", x: 0, y: 0, board: "b" }, createdAt: new Date().toISOString(), createdBy: { name: "Anna", email: "anna@studio.test" }, comments: [{ id: crypto.randomUUID(), body: "c", author: { name: "Anna", email: "anna@studio.test" }, createdAt: new Date().toISOString() }] };
  fs.writeFileSync(path.join(t.file, "comments.json"), JSON.stringify({ format: 1, doc, seq: 0, server: { url: a.url }, threads: [thread], outbox: [] }));
  const rename = async (name: string) => {
    await settingsCloud(t);
    const field = await t.mark({ id: "cloud-name", window: "settings" }, 4000);
    await t.click(center(field), { window: "settings" });
    await t.key("a", ["cmd"], { window: "settings" });
    await t.key("Delete", [], { window: "settings" });
    if (name) await t.type(name, { window: "settings" });
    await t.key("Return", [], { window: "settings" });
    await t.waitFor(async () => (await t.cmd("qa.cloud", {})).clouds[0]?.name === name, `the Cloud name saved as ${JSON.stringify(name)}`, 4000);
    await t.key("w", ["cmd"], { window: "settings" }).catch(() => {});
    await home(t);
  };
  try {
    await t.cmd("qa.cloud", { clouds: [{ url: a.url, devEmail: "anna@studio.test" }] });
    const id = (await t.cmd("qa.cloud", {})).clouds[0].id;
    await t.cmd("qa.cloud", { select: id });
    await t.js(`return window.canvasHost.comments.reload();`);
    await t.waitJs(`document.querySelector(".cm-shared")?.classList.contains("on")`, "the shared bar", 12_000);
    const bar = await t.js<{ text: string; label: string; title: string }>(`const b = document.querySelector(".cm-shared"); return { text: b.innerText, label: b.getAttribute("aria-label") || "", title: b.querySelector(".cm-server")?.title || "" };`);
    t.ok(!(bar.text + bar.label + bar.title).includes("127.0.0.1"), `the file shows no Cloud name: ${JSON.stringify(bar)}`);
    await home(t);
    t.note("checking the initial host-name row");
    await t.mark({ id: "home-row", label: a.host }, 6000);
    await rename("Studio team");
    await t.mark({ id: "home-row", label: "Studio team" }, 6000);
    t.eq((await t.marks({ id: "home-row", label: a.host })).length, 0, "the host is gone from the sidebar");
    t.ok((await t.marks({ id: "home-card-where-glyph", label: "Studio team" })).length >= 1, "the shared file's card names the Cloud by its name");
    await t.click(center(await t.mark({ id: "home-row", label: "Studio team" })));
    await t.waitState((s) => s.homeSection === "cloud", "the Cloud's page");
    await t.waitFor(async () => (await t.marks({ label: "Studio team" })).length >= 2, "the page's title", 4000);
    await rename("");
    t.note("checking the cleared-name host row");
    await t.mark({ id: "home-row", label: a.host }, 6000);
  } catch (error) {
    const shot = `${process.cwd()}/qa/out/native/cloud-name-failure.png`;
    await t.shot(shot).catch(() => {});
    t.note("before cleanup: qa/out/native/cloud-name-failure.png");
    throw error;
  } finally {
    await t.cmd("qa.cloud", { clouds: [] }).catch(() => {});
    fs.rmSync(path.join(t.file, "comments.json"), { force: true });
    await a.close();
  }
});

sc("settings", "Joined Mac Cloud: Home and Settings have no adapter Alpha badge or notice", { covers: ["settings:cloud", "home:clouds"] }, async (t: NT) => {
  const id = "3f2b8c1e-5d4a-4e6f-9a7b-1c2d3e4f5a6b";
  try {
    await t.cmd("qa.cloud", { clouds: [{ id: "joined", url: `canvas-cloud://${id}`, name: "Studio", kind: "joined" }], select: null, home: "joined" });
    await home(t);
    await t.waitState((s) => s.homeSection === "cloud", "the joined Cloud page");
    t.eq((await t.marks({ id: "cloud-alpha-badge" })).length, 0, "no Alpha badge on the joined Cloud");
    t.eq((await t.marks({ id: "cloud-alpha-notice" })).length, 0, "no Alpha notice on the joined Cloud");
    await settingsCloud(t);
    t.eq((await t.marks({ id: "cloud-alpha-badge", window: "settings" })).length, 0, "no badge on its Settings row");
    await t.click(center(await t.mark({ id: "cloud-row", label: "Studio", window: "settings" }, 4000)), { window: "settings" });
    await t.mark({ id: "cloud-back", window: "settings" }, 4000);
    t.eq((await t.marks({ id: "cloud-alpha-badge", window: "settings" })).length, 0, "no badge on its Settings page");
    await t.shot(`${process.cwd()}/qa/out/native/cloud-joined-no-alpha.png`, "settings");
  } finally {
    await t.key("w", ["cmd"], { window: "settings" }).catch(() => {});
    await t.cmd("qa.cloud", { clouds: [] }).catch(() => {});
  }
});
