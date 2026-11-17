import { extras } from "../check.ts";
import type { Config, WidgetKind } from "../types.ts";

// The card on the Welcome file a first launch opens (src/onboarding.ts): Connect an agent, a row each for Claude Code
// and Codex (Connect, or Connected; the register command in each row's menu). Not offered in the Widgets panel.
export const welcome: WidgetKind = {
  id: "welcome",
  title: "Welcome",
  symbol: "hand.wave",
  hidden: true,
  defaultSize: { w: 400, h: 180 },
  minSize: { w: 320, h: 180 },
  defaults: () => ({}),
  validate: (c: Config): Config => extras(c, []),
  fields: [],
};
