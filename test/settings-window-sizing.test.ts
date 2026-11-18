// Settings sizes its window one way only: each pane reports its content height (SettingsPane in
// apps/macos/Settings.swift) and SettingsTabs follows the selected pane's. A pane that resizes the window itself, or a
// hand-kept list of triggers like the old refit(), misses changes and leaves panes cut off.
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

describe("Settings window sizing", () => {
  const settings = fs.readFileSync("apps/macos/Settings.swift", "utf8");
  const cloud = fs.readFileSync("apps/macos/CloudSettings.swift", "utf8");

  test("no pane asks the window to refit", () => {
    assert.doesNotMatch(settings + cloud, /\brefit\(\)/);
  });

  test("Settings > Cloud never sizes the Settings window", () => {
    assert.doesNotMatch(cloud, /SettingsWindow\.shared\.(nsWindow|window)[^\n]*\.(setFrame|setContentSize)/);
    assert.doesNotMatch(cloud, /SettingsTabs/);
  });

  test("the panes report their height and nothing else sizes them", () => {
    assert.match(settings, /onGeometryChange\(for: CGFloat\.self\) \{ \$0\.size\.height \} action: \{[^}]*onHeight\(\$0\) \}/);
    assert.match(settings, /rootView: SettingsPane\([^\n]*paneHeight[^\n]*\n[^\n]*\n\s*host\.sizingOptions = \[\]/);
    assert.doesNotMatch(settings, /fittingSize/);
  });
});
