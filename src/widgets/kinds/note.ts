import { extras, oneOf, str } from "../check.ts";
import type { Config, WidgetKind } from "../types.ts";

const TONES = ["plain", "yellow", "green", "blue", "pink"] as const;
const KNOWN = ["text", "tone"];
// text is Markdown, one line per block (src/page/note-doc.js; the MCP tools in mcp/tools/widgets.ts describe it).

export const note: WidgetKind = {
  id: "note",
  title: "Note",
  symbol: "text.page",
  defaultSize: { w: 320, h: 240 },
  minSize: { w: 120, h: 80 },
  defaults: () => ({ text: "", tone: "plain" }),
  validate(c: Config): Config {
    const text = str(c.text, "text", "", 50_000);
    return { text, tone: oneOf(c.tone, "tone", "plain", TONES), ...extras(c, KNOWN) };
  },
  fields: [
    { key: "text", label: "Text", type: "textarea", help: "Markdown: #, ## and ### headings, - bullets, 1. numbers, - [ ] checkboxes, **bold**, *italic*." },
    { key: "tone", label: "Color", type: "select", options: TONES.map((t) => ({ value: t, label: t[0].toUpperCase() + t.slice(1) })) },
  ],
};
