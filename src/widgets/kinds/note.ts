import { extras, int, oneOf, str } from "../check.ts";
import type { Config, WidgetKind } from "../types.ts";

const TONES = ["plain", "yellow", "green", "blue", "pink"] as const;
const KNOWN = ["text", "tone", "pageWidth"];
// text is Markdown, one line per block (src/page/note-doc.js; the MCP tools in mcp/tools/widgets.ts describe it).

export const note: WidgetKind = {
  id: "note",
  title: "Page",
  description: "Rich text and checklists",
  symbol: "text.page",
  defaultSize: { w: 480, h: 80 },
  minSize: { w: 280, h: 80 },
  defaults: () => ({ text: "", tone: "plain" }),
  validate(c: Config): Config {
    const text = str(c.text, "text", "", 50_000);
    return { text, tone: oneOf(c.tone, "tone", "plain", TONES), ...(c.pageWidth === undefined ? {} : { pageWidth: int(c.pageWidth, "Width", 480, 280, 100_000) }), ...extras(c, KNOWN) };
  },
  fields: [
    { key: "text", label: "Text", type: "textarea", help: "Markdown: #, ## and ### headings, - bullets, 1. numbers, - [ ] checkboxes, **bold**, *italic*." },
    { key: "tone", label: "Color", type: "select", options: TONES.map((t) => ({ value: t, label: t[0].toUpperCase() + t.slice(1) })) },
  ],
};
