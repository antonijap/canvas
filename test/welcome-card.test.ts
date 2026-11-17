// The Welcome card's rows (src/page/widget-kinds.js welcomeRow): what each agent's row shows from GET /api/mcp/setup.

import assert from "node:assert/strict";
import { describe, test } from "node:test";
// @ts-ignore: a plain ES module the page imports too
import { WELCOME_HINT, WELCOME_TEMPORARY, WELCOME_TITLE, welcomeHint, welcomeRow } from "../src/page/widget-kinds.js";
import { TEMPORARY_SERVER } from "../src/mcp-connect.ts";

describe("welcome card rows", () => {
  test("the card's words", () => {
    assert.equal(WELCOME_TITLE, "Connect an agent");
    assert.equal(WELCOME_HINT, "Then select a layer and ask for a change. ⌘Z undoes its work.");
  });

  test("an installed agent that is not registered offers Connect", () => {
    const s = { installed: { claude: true, codex: true }, registered: { claude: false, codex: false } };
    assert.deepEqual(welcomeRow(s, "claude"), { connected: false, button: "Connect" });
    assert.deepEqual(welcomeRow(s, "codex"), { connected: false, button: "Connect" });
  });

  test("Connect running says so", () => {
    assert.deepEqual(welcomeRow({ installed: { claude: true } }, "claude", true), { connected: false, button: "Connecting…" });
  });

  test("an agent Canvas could not find offers Copy command instead of Connect", () => {
    assert.deepEqual(welcomeRow({ installed: { claude: false, codex: true } }, "claude"), { connected: false, button: "Copy command" });
    assert.deepEqual(welcomeRow({}, "codex"), { connected: false, button: "Copy command" });
  });

  test("a server in a temporary worktree: Copy command instead of Connect, and the footer says why", () => {
    const s = { installed: { claude: true, codex: true }, registered: { claude: false, codex: true }, temporary: true };
    assert.deepEqual(welcomeRow(s, "claude"), { connected: false, button: "Copy command" });
    assert.deepEqual(welcomeRow(s, "codex"), { connected: true, button: null }, "an agent already registered still shows Connected");
    assert.equal(welcomeHint(s), TEMPORARY_SERVER);
    assert.equal(WELCOME_TEMPORARY, TEMPORARY_SERVER, "the page's copy of the server's words");
    assert.equal(welcomeHint({ temporary: false }), WELCOME_HINT);
    assert.equal(welcomeHint(null), WELCOME_HINT);
  });

  test("registered, or the client talking now, shows Connected and no button", () => {
    assert.deepEqual(welcomeRow({ installed: { claude: true }, registered: { claude: true } }, "claude"), { connected: true, button: null });
    const live = { installed: {}, registered: {}, connected: true, client: "Claude" };
    assert.deepEqual(welcomeRow(live, "claude"), { connected: true, button: null });
    assert.deepEqual(welcomeRow(live, "codex"), { connected: false, button: "Copy command" }, "only the agent that is talking");
  });
});
