import { extras } from "../check.ts";
import type { Config, WidgetKind } from "../types.ts";

// The card on the Welcome file a first launch opens (src/onboarding.ts): what Canvas is for, the commands that register
// Canvas MCP with Claude Code and Codex, and whether an agent is connected. Not offered in the Widgets panel.
export const welcome: WidgetKind = {
  id: "welcome",
  title: "Welcome",
  symbol: "hand.wave",
  hidden: true,
  defaultSize: { w: 460, h: 440 },
  minSize: { w: 320, h: 300 },
  defaults: () => ({}),
  validate: (c: Config): Config => extras(c, []),
  fields: [],
};
