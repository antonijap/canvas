// The app's settings the server and page use (src/settings.ts, Canvas > Settings in apps/macos): the default harness
// and run cap that ride on the shell's state, the harness order the composer shows, and "Scroll to zoom".

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { byPreference, pickHarness, type HarnessInfo } from "../src/agent-run.ts";
import { wheelAction } from "../src/pagelogic.ts";
import { agentSettings, cleanSettings, DEFAULT_SETTINGS, runCapMs, setAgentSettings } from "../src/settings.ts";

const claude: HarnessInfo = { id: "claude", label: "Claude Code", path: "/x/claude", real: "/x/claude" };
const codex: HarnessInfo = { id: "codex", label: "Codex", path: "/x/codex", real: "/x/codex" };

describe("agent settings", () => {
  test("defaults: Claude Code, 10 minutes", () => {
    assert.deepEqual(cleanSettings(undefined), DEFAULT_SETTINGS);
    assert.deepEqual(DEFAULT_SETTINGS, { harness: "claude", runCapMin: 10, claude: { model: "", effort: "" }, codex: { model: "", effort: "" }, commentName: "" });
  });
  test("the name in comments is plain text of at most 60 characters", () => {
    assert.equal(cleanSettings({ commentName: "  Ana \n Test\u0000 " }).commentName, "Ana Test");
    assert.equal(cleanSettings({ commentName: "x".repeat(200) }).commentName.length, 60);
    assert.equal(cleanSettings({ commentName: 7 }).commentName, "");
  });
  test("unknown harnesses and out-of-range caps fall back or clamp", () => {
    assert.equal(cleanSettings({ harness: "rm -rf" }).harness, "claude");
    assert.equal(cleanSettings({ runCapMin: 0 }).runCapMin, 1);
    assert.equal(cleanSettings({ runCapMin: 999 }).runCapMin, 60);
    assert.equal(cleanSettings({ runCapMin: "abc" }).runCapMin, 10);
  });
  test("the shell's settings set the run cap", () => {
    setAgentSettings({ harness: "codex", runCapMin: 3 });
    assert.equal(agentSettings().harness, "codex");
    assert.equal(runCapMs(), 3 * 60_000);
    setAgentSettings({});
    assert.equal(runCapMs(), 10 * 60_000);
  });
  test("the default harness goes first; the other is the backup; a follow-up keeps its own", () => {
    assert.equal(pickHarness([claude, codex], undefined, "codex")?.id, "codex");
    assert.equal(pickHarness([claude], undefined, "codex")?.id, "claude", "Codex picked but not installed");
    assert.equal(pickHarness([claude, codex], "claude", "codex")?.id, "claude");
    assert.deepEqual(byPreference([claude, codex], "codex").map((h) => h.id), ["codex", "claude"]);
  });
});

describe("Scroll to zoom", () => {
  const ev = (o: Partial<Parameters<typeof wheelAction>[0]>) => ({ deltaX: 0, deltaY: 10, deltaMode: 0, ctrlKey: false, metaKey: false, shiftKey: false, ...o });
  test("off (default): scroll pans, Cmd+scroll zooms", () => {
    assert.ok("dy" in wheelAction(ev({})));
    assert.ok("zoom" in wheelAction(ev({ metaKey: true })));
  });
  test("on: scroll zooms, Cmd+scroll and Shift+scroll pan, pinch zooms", () => {
    assert.ok("zoom" in wheelAction(ev({}), false, true));
    assert.ok("dy" in wheelAction(ev({ metaKey: true }), false, true));
    assert.ok("dx" in wheelAction(ev({ shiftKey: true }), false, true));
    assert.ok("zoom" in wheelAction(ev({ ctrlKey: true }), false, true));
  });
});
