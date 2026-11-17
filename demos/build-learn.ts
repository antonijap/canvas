// Builds demos/learn.canvas: the file a first launch opens (src/onboarding.ts copies it to
// ~/Documents/Canvas/Welcome.canvas). A short course, one board per lesson on the "Learn" page: what to press on the
// left, things to try it on at the right. Run: node demos/build-learn.ts   (rewrites demos/learn.canvas)
//
// Text is SF Pro (always on a Mac, no download on first launch) with Apple's tracking for each size and a single line
// at line height 1. Boards, cards and keycaps are separated by shadows, not borders.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { validateNode } from "../src/engine.ts";
import { appleTracking, SF_PRO } from "../src/tracking.ts";
import { ROOT, api, startServer } from "../qa/lib.ts";

type Node = Record<string, unknown>;
export const LEARN = path.join(ROOT, "demos", "learn.canvas");

// ---------------------------------------------------------------- look

const INK = "#1D1D1F";
const MUTED = "#6E6E73";
const FAINT = "#8E8E93";
const PAPER = "#FFFFFF";
const TRY = "#F5F5F7";
const FONT = "SF Pro";
/** Apple's leading for the size (Large Title 34/41 ... Footnote 13/18); one-line labels use 1. */
const LEADING: Record<number, number> = { 13: 18 / 13, 15: 20 / 15, 17: 22 / 17, 20: 25 / 20, 22: 28 / 22, 40: 48 / 40 };
const round2 = (n: number) => Math.round(n * 100) / 100;

const SHADOW_CARD = [
  { type: "shadow", offset: { x: 0, y: 0 }, blur: 0, spread: 1, color: "#0000000D" },
  { type: "shadow", offset: { x: 0, y: 1 }, blur: 2, spread: 0, color: "#0000000F" },
  { type: "shadow", offset: { x: 0, y: 8 }, blur: 24, spread: -4, color: "#0000001A" },
];
const SHADOW_KEY = [
  { type: "shadow", offset: { x: 0, y: 0 }, blur: 0, spread: 1, color: "#00000014" },
  { type: "shadow", offset: { x: 0, y: 1 }, blur: 1, spread: 0, color: "#0000001A" },
];

let seq = 0;
const nid = (p: string) => `${p}${(++seq).toString(36)}`;

/** SF Pro text. `wrap`: fills its row and wraps (with leading); otherwise one line at line height 1. */
function text(content: string, size: number, o: { weight?: string; fill?: string; wrap?: boolean; width?: number | string; name?: string; align?: string } = {}): Node {
  const wrap = o.wrap ?? false;
  return {
    type: "text", id: nid("t"), name: o.name ?? content.slice(0, 40), content, fill: o.fill ?? INK,
    fontFamily: FONT, fontSize: size, fontWeight: o.weight ?? "400", letterSpacing: round2(appleTracking(SF_PRO, size)),
    lineHeight: wrap ? round2(LEADING[size] ?? 1.3) : 1,
    ...(wrap ? { textGrowth: "fixed-width", width: o.width ?? "fill_container" } : {}),
    ...(o.align ? { textAlign: o.align } : {}),
  };
}

/** One key as a cap; several keys of one shortcut sit tight together. Words like "drag" are plain text beside them. */
const GLYPH = new Set(["⌘", "⇧", "⌥", "⌃", "↩", "←", "→", "↑", "↓", "⌫", "⇥"]);
function key(k: string): Node {
  return {
    type: "frame", id: nid("k"), name: `Key ${k}`, height: 24, ...(GLYPH.has(k) || k.length === 1 ? { width: 24 } : {}),
    padding: GLYPH.has(k) || k.length === 1 ? 0 : [0, 7], cornerRadius: 6, fill: PAPER, effect: SHADOW_KEY,
    justifyContent: "center", alignItems: "center",
    children: [text(k, 12, { weight: "500", name: k })],
  };
}
/** A shortcut: tokens are keys, except lower-case words (drag, click, scroll) and "+" / "or", which are plain text. */
function keys(tokens: string[]): Node {
  const kids: Node[] = [];
  for (const t of tokens) {
    if (t === "+" || t === "or" || /^[a-z][a-z -]*$/.test(t)) kids.push(text(t, 13, { fill: MUTED, weight: "500" }));
    else kids.push(key(t));
  }
  return { type: "frame", id: nid("ks"), name: "Keys", width: 112, height: 24, gap: 3, alignItems: "center", children: kids };
}
const step = (tokens: string[], what: string): Node => ({
  type: "frame", id: nid("s"), name: what.slice(0, 40), width: "fill_container", gap: 16, alignItems: "center",
  children: [keys(tokens), text(what, 15, { wrap: true })],
});

/** The body under the heading: the steps on the left, the practice area filling the rest. */
const BODY_H = 470;
/** Every board the same whole-pixel height: the heading, the body and the padding, with a few px to spare. */
const BOARD_H = 760;
const ACCENTS = ["#FF6B3D", "#F2A900", "#34C759", "#00B5A3", "#30B0FF", "#5E5CE6", "#AF52DE", "#FF2D92", "#FF453A", "#8E8E93", "#1D1D1F"];

/** A lesson board: number, title and one line on the left above the steps; the practice area on the right. */
function lesson(n: number, total: number, id: string, title: string, intro: string, steps: Node[], tryIt: string, practice: Node[], x: number, y: number): Node {
  const accent = ACCENTS[(n - 1) % ACCENTS.length];
  return {
    type: "frame", id, name: `${n}. ${title}`, x, y, width: 1200, height: BOARD_H, fill: PAPER, cornerRadius: 20, clip: true,
    layout: "vertical", padding: 64, gap: 40,
    children: [
      { type: "frame", id: `${id}_head`, name: "Heading", width: "fill_container", layout: "vertical", gap: 14, children: [
        { type: "frame", id: `${id}_eyebrow`, name: "Lesson", gap: 10, alignItems: "center", children: [
          { type: "frame", id: `${id}_num`, name: "Number", width: 26, height: 26, cornerRadius: 13, fill: accent, justifyContent: "center", alignItems: "center", children: [text(String(n), 13, { weight: "700", fill: PAPER })] },
          text(`Lesson ${n} of ${total}`, 13, { weight: "600", fill: MUTED }),
        ] },
        text(title, 40, { weight: "700", name: "Title" }),
        text(intro, 17, { wrap: true, width: 1072, fill: MUTED, name: "Intro" }),
      ] },
      { type: "frame", id: `${id}_body`, name: "Body", width: "fill_container", height: BODY_H, gap: 48, children: [
        { type: "frame", id: `${id}_steps`, name: "Steps", width: 480, layout: "vertical", gap: 20, children: steps },
        { type: "frame", id: `${id}_try`, name: "Try it", width: "fill_container", height: BODY_H, cornerRadius: 20, fill: TRY, clip: true, layout: "none", children: [
          { ...text("TRY IT", 11, { weight: "700", fill: FAINT, name: "Try it label" }), x: 28, y: 26 },
          { ...text(tryIt, 15, { weight: "500", wrap: true, width: 500, name: "Try it prompt" }), x: 28, y: 46 },
          ...practice,
        ] },
      ] },
    ],
  };
}

// ---------------------------------------------------------------- practice pieces

const rect = (name: string, x: number, y: number, w: number, h: number, fill: string, extra: Node = {}): Node =>
  ({ type: "rectangle", id: nid("r"), name, x, y, width: w, height: h, fill, cornerRadius: 12, ...extra });
const ellipse = (name: string, x: number, y: number, d: number, fill: string, extra: Node = {}): Node =>
  ({ type: "ellipse", id: nid("e"), name, x, y, width: d, height: d, fill, ...extra });
const icon = (name: string, x: number, y: number, size: number, fill: string): Node =>
  ({ type: "icon", id: nid("i"), name, library: "lucide", icon: name, x, y, width: size, height: size, fill });
const card = (name: string, x: number, y: number, w: number, h: number, children: Node[], extra: Node = {}): Node =>
  ({ type: "frame", id: nid("c"), name, x, y, width: w, height: h, fill: PAPER, cornerRadius: 16, effect: SHADOW_CARD, layout: "none", ...extra, children });
const placed = (n: Node, x: number, y: number): Node => ({ ...n, x, y });

// ---------------------------------------------------------------- the lessons

const T = 10;
const COL = 1360, ROW = 920;
const at = (i: number) => ({ x: (i % 3) * COL, y: Math.floor(i / 3) * ROW });

function welcome(): Node {
  const rows = [
    "Move around", "Select", "Move and copy", "Auto layout", "Style", "Text", "Components", "Work with an agent", "Cards and pages", "Share and export",
  ].map((t, i) => ({
    type: "frame", id: `wel_row${i + 1}`, name: t, width: "fill_container", gap: 12, alignItems: "center", children: [
      { type: "frame", id: nid("n"), name: "Number", width: 22, height: 22, cornerRadius: 11, fill: ACCENTS[i], justifyContent: "center", alignItems: "center", children: [text(String(i + 1), 11, { weight: "700", fill: PAPER })] },
      text(t, 15, { weight: "500" }),
    ],
  }));
  return {
    type: "frame", id: "welcome", name: "Welcome", ...at(0), width: 1200, height: BOARD_H, fill: PAPER, cornerRadius: 20, clip: true, layout: "vertical", padding: 64, gap: 40,
    children: [
      { type: "frame", id: "wel_head", name: "Heading", width: "fill_container", layout: "vertical", gap: 16, children: [
        { type: "frame", id: "wel_alpha", name: "Alpha", height: 24, padding: [0, 10], cornerRadius: 12, fill: "#FFF1E0", alignItems: "center", children: [text("Alpha", 12, { weight: "600", fill: "#B25000" })] },
        text("Welcome to Canvas", 40, { weight: "700", name: "Title" }),
        text("Canvas is a design canvas you share with AI agents. Agents draw here while you watch, and you point at things to talk about them.", 17, { wrap: true, width: 1000, fill: MUTED, name: "Intro" }),
      ] },
      { type: "frame", id: "wel_body", name: "Body", width: "fill_container", height: BODY_H, gap: 48, children: [
        { type: "frame", id: "wel_how", name: "How this file works", width: 480, layout: "vertical", gap: 20, children: [
          text("This file is a short course: ten lessons, one board each. Every board says what to press and has something to try it on.", 15, { wrap: true }),
          step(["N"], "Go to the next lesson."),
          step(["⇧", "N"], "Go back one."),
          step(["⇧", "1"], "See every lesson at once."),
          step(["⌘", "Z"], "Undo anything. Nothing here can break."),
          text("Using Claude Code or Codex? The card to the left connects it to Canvas. Lesson 8 shows what to do next.", 15, { wrap: true }),
          text("Canvas is in alpha. When something feels wrong, slow or confusing, report it on GitHub (Issues). Every report makes the first real version come sooner.", 15, { wrap: true, fill: MUTED }),
        ] },
        { type: "frame", id: "wel_list", name: "Lessons", width: "fill_container", height: BODY_H, cornerRadius: 20, fill: TRY, layout: "vertical", padding: [28, 28], gap: 14, children: [
          text("LESSONS", 11, { weight: "700", fill: FAINT }),
          ...rows,
        ] },
      ] },
    ],
  };
}

function lessons(): Node[] {
  const L: Node[] = [];
  let i = 1;
  const add = (id: string, title: string, intro: string, steps: Node[], tryIt: string, practice: Node[]) => { L.push(lesson(i, T, id, title, intro, steps, tryIt, practice, at(i).x, at(i).y)); i++; };

  add("move_around", "Move around", "The canvas is endless. Boards sit on it side by side, like sheets on a table.", [
    step(["Space", "+", "drag"], "Pan. A trackpad scrolls too."),
    step(["⌘", "+", "scroll"], "Zoom, or pinch on a trackpad."),
    step(["⇧", "1"], "Fit everything on the page."),
    step(["⇧", "2"], "Fit what is selected."),
    step(["⇧", "0"], "Zoom to 100%."),
    step(["N"], "Next board. Shift+N goes back."),
  ], "Zoom into the small dot until you can read what it says.", [
    ellipse("Dot", 244, 236, 56, "#FFE3D6"),
    // 2 px is far below Apple's tracking chart: no letter spacing, centred on the dot by its measured width (35 px).
    { ...text("You found it. Press Shift+1.", 2, { weight: "600", fill: "#B23A12", name: "Secret" }), letterSpacing: 0, x: 255, y: 263 },
    { ...text("Small, isn't it?", 13, { fill: FAINT }), x: 225, y: 312 },
  ]);

  add("select", "Select", "Click picks the top layer. Cmd+click reaches the one deepest under the pointer.", [
    step(["click"], "Select a layer."),
    step(["⇧", "click"], "Add to the selection, or take away."),
    step(["drag"], "On empty canvas: select everything the box touches."),
    step(["⌘", "click"], "Select the deepest layer under the pointer."),
    step(["↩"], "Select the children. Shift+Return: the parent."),
    step(["Esc"], "Select nothing."),
  ], "Select the star inside the card with Cmd+click. Press Shift+Return for the card, then Esc.", [
    card("Profile card", 81, 160, 260, 200, [
      ellipse("Avatar", 24, 24, 48, "#D6E4FF"),
      { ...text("Mira Novak", 15, { weight: "600" }), x: 88, y: 32 },
      { ...text("Product designer", 13, { fill: MUTED }), x: 88, y: 54 },
      rect("Cover", 24, 96, 212, 80, "#F2F2F7"),
      icon("star", 118, 124, 24, "#F2A900"),
    ]),
    rect("Square", 391, 172, 72, 72, "#34C759"),
    ellipse("Circle", 395, 280, 64, "#30B0FF"),
  ]);

  add("move_copy", "Move and copy", "Drag to move. Option leaves the original where it is and moves a copy.", [
    step(["drag"], "Move. Hold Shift for a straight line."),
    step(["⌥", "drag"], "Drag a copy; the original stays."),
    step(["⌘", "D"], "Duplicate. Again repeats the same step."),
    step(["←", "→", "↑", "↓"], "Nudge 1 px. With Shift: 10 px."),
    step(["⌥", "hover"], "Show the distance to another layer."),
  ], "Drag the circle into the ring. Then Option-drag the square to make a row of three.", [
    ellipse("Ring", 360, 160, 96, "#00000000", { stroke: "#C7C7CC", strokeWidth: 2, strokeAlignment: "inner", name: "Ring" }),
    ellipse("Circle", 90, 176, 64, "#FF6B3D"),
    rect("Square", 90, 330, 64, 64, "#5E5CE6"),
  ]);

  const loose = ["Inbox", "Today", "Done"].map((t, k) => card(t, 52 + k * 150, 140 + (k % 2) * 24, 120, 64, [{ ...text(t, 15, { weight: "600" }), x: 20, y: 24 }]));
  const list: Node = {
    type: "frame", id: "al_list", name: "Fruit list", x: 182, y: 270, width: 180, layout: "vertical", padding: 12, gap: 8, cornerRadius: 16, fill: PAPER, effect: SHADOW_CARD,
    children: ["Apple", "Banana", "Cherry"].map((t) => ({ type: "frame", id: nid("f"), name: t, width: "fill_container", height: 40, padding: [0, 14], cornerRadius: 10, fill: TRY, alignItems: "center", children: [text(t, 15, { weight: "500" })] })),
  };
  add("auto_layout", "Auto layout", "A stack keeps its items in a row or column, evenly spaced, and makes room when one grows.", [
    step(["⇧", "A"], "Put the selection in a stack."),
    step(["drag"], "Drag an item inside a stack to reorder it."),
    step(["⌥", "⇧", "A"], "Take the stack away, keep the layers."),
    step(["click"], "The pink bars on a selected stack set its padding and gap."),
  ], "Select the three cards and press Shift+A. Then drag Banana above Apple.", [...loose, list]);

  add("style", "Style", "The inspector on the right sets fill, stroke and effects. A few keys do it faster.", [
    step(["drag"], "A shader from the Widgets panel onto a layer becomes its fill."),
    step(["1", "or", "0"], "Opacity: 1 is 10%, 0 is 100%."),
    step(["⌥", "⌘", "C"], "Copy a layer's style. Option+Cmd+V pastes it."),
    step(["."], "Repeat the last change on what is selected now."),
    step(["⇧", "X"], "Swap fill and stroke."),
  ], "Open the Widgets panel on the left and drag a shader onto the empty card.", [
    card("Empty card", 57, 130, 220, 260, []),
    { ...text("Drop a shader on this card", 13, { weight: "500", fill: FAINT, align: "center", wrap: true, width: 220 }), x: 57, y: 404 },
    card("Styled", 327, 140, 160, 120, [], { fill: "#FF2D92", cornerRadius: 28 }),
    card("Plain", 327, 280, 160, 110, []),
    { ...text("Paste the pink style here", 13, { weight: "500", fill: FAINT, align: "center", wrap: true, width: 160 }), x: 327, y: 404 },
  ]);

  add("text", "Text", "Double-click a text to type in it. The keys below work on the letters you select.", [
    step(["double-click"], "Edit a text."),
    step(["⌘", "B"], "Bold. Cmd+I italic, Cmd+U underline."),
    step(["⇧", "⌘", "."], "Bigger. Shift+Cmd+comma: smaller."),
    step(["⌥", "⌘", "T"], "Centre the text. L, R and J for the others."),
    step(["⇧", "⌘", "8"], "A bulleted list. 7 makes it numbered."),
    step(["⌘", "F"], "Find and replace across every page."),
  ], "Make the headline bold and bigger. Turn the three lines into a list.", [
    card("Note", 57, 150, 430, 200, [
      { ...text("A headline that needs weight", 20, { name: "Headline" }), x: 28, y: 28 },
      { ...text("Buy paint\nCall the printer\nSend the proofs", 15, { wrap: true, width: 360, name: "Lines" }), x: 28, y: 76 },
    ]),
  ]);

  const button: Node = {
    type: "frame", id: "cmp_button", name: "Button", x: 201, y: 238, height: 44, padding: [0, 20], cornerRadius: 12, fill: INK, justifyContent: "center", alignItems: "center", gap: 8,
    children: [icon("sparkles", 0, 0, 16, PAPER), text("Get started", 15, { weight: "600", fill: PAPER })],
  };
  add("components", "Components", "Make a layer a component once, use copies of it everywhere. Change the main one and every copy follows.", [
    step(["⌥", "⌘", "K"], "Make the selection a component."),
    step(["⌘", "D"], "A copy is an instance of it."),
    step(["drag"], "Or drag one in from the Components panel."),
    step(["⌥", "⌘", "B"], "Detach an instance into plain layers."),
  ], "Make the button a component, duplicate it twice, then change the main one's colour.", [button]);

  const screen = card("Sign-in card", 122, 130, 300, 290, [
    { ...text("Sign in", 22, { weight: "700" }), x: 28, y: 32 },
    rect("Email field", 28, 84, 244, 40, TRY, { cornerRadius: 10 }),
    { ...text("you@example.com", 13, { fill: FAINT }), x: 42, y: 98 },
    rect("Password field", 28, 136, 244, 40, TRY, { cornerRadius: 10 }),
    { ...text("Password", 13, { fill: FAINT }), x: 42, y: 150 },
    { type: "frame", id: "agent_btn", name: "Button", x: 28, y: 204, width: 244, height: 44, cornerRadius: 12, fill: "#5E5CE6", justifyContent: "center", alignItems: "center", children: [text("Continue", 15, { weight: "600", fill: PAPER })] },
  ]);
  add("agent", "Work with an agent", "Connect Claude Code or Codex once (the card on the Welcome board has the command). Then point at a layer and ask.", [
    step(["⌘", "L"], "Copy a link to the selection. Paste it to your agent."),
    step(["⌘", "↩"], "Ask about the selection right here."),
    step(["⇧", "⌘", "↩"], "Three variations of a board, side by side."),
    step(["⌘", "Z"], "An agent's change undoes like your own."),
  ], "Select the card, press Cmd+L and ask your agent: make this friendlier.", [screen]);

  add("cards_pages", "Cards and pages", "Notes, to-dos, shaders and videos live on the canvas next to your boards. Pages keep big files tidy.", [
    step(["drag"], "A card from the Widgets panel onto the canvas."),
    step(["⌘", "K"], "Quick actions: find any layer, page or command."),
    step(["⌘", "\\"], "Hide or show the panels."),
    step(["click"], "Pages are in the left panel. This file has two."),
  ], "Tick off the lessons you finished on the to-do card. Then find the Playground page.", []);

  add("share", "Share and export", "Everything you make can leave Canvas as a picture, code or a link.", [
    step(["⇧", "⌘", "C"], "Copy as PNG. Paste it into any chat."),
    step(["right-click"], "Copy as SVG, CSS, SwiftUI or text."),
    step(["⇧", "⌘", "E"], "Export with each layer's settings."),
    step(["⌘", "L"], "A link that opens this exact layer."),
  ], "Copy the badge as PNG and paste it somewhere.", [
    card("Badge", 132, 180, 280, 180, [
      icon("party-popper", 28, 28, 28, "#FF2D92"),
      { ...text("Course done", 22, { weight: "700" }), x: 28, y: 76 },
      { ...text("You know your way around Canvas.", 15, { fill: "#A3245F", wrap: true, width: 224 }), x: 28, y: 112 },
    ], { fill: "#FFF0F7" }),
  ]);
  return L;
}

function playground(): Node {
  return {
    type: "frame", id: "playground", name: "Your board", x: 0, y: 0, width: 1200, height: 760, fill: PAPER, cornerRadius: 20,
    children: [{ ...text("Your board. Make something, or ask your agent to.", 15, { fill: FAINT }), x: 40, y: 36 }],
  };
}

// ---------------------------------------------------------------- write

async function main() {
  const boards = [welcome(), ...lessons()];
  const yours = playground();
  const doc = { version: "2.22", children: [...boards, yours] };
  for (const b of doc.children) validateNode(b as never);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "canvas-learn-"));
  const pkg = path.join(tmp, "Learn.canvas");
  fs.mkdirSync(pkg);
  fs.writeFileSync(path.join(pkg, "document.json"), JSON.stringify(doc, null, 2) + "\n");
  const srv = await startServer(tmp);
  try {
    const a = api(srv.base, pkg);
    const d = await a.get("/api/doc");
    for (const b of d.boards) {
      const r = await a.get(`/api/board?id=${encodeURIComponent(b.id)}`);
      if (r.warnings?.length) throw new Error(`board ${b.id}: ${r.warnings.join("; ")}`);
    }
    await a.put("/api/pages", { pages: [
      { id: "learn", name: "Learn", boards: boards.map((b) => b.id) },
      { id: "playground", name: "Playground", boards: ["playground"] },
    ] });
    const cp = at(9);
    await a.post("/api/widgets", { kind: "todo", name: "Your progress", x: cp.x + 684, y: cp.y + 330, w: 360, h: 380, page: "learn", config: { title: "Your progress", items: [
      "Move around", "Select", "Move and copy", "Auto layout", "Style", "Text", "Components", "Work with an agent", "Cards and pages", "Share and export",
    ].map((t) => ({ text: t, done: false })) } });
    const f = await a.flush();
    if (!f.ok) throw new Error(`flush: ${JSON.stringify(f)}`);
  } finally {
    await srv.stop();
  }
  fs.rmSync(LEARN, { recursive: true, force: true });
  fs.mkdirSync(LEARN, { recursive: true });
  for (const e of fs.readdirSync(pkg, { withFileTypes: true })) {
    if (e.name.startsWith(".")) continue;
    fs.cpSync(path.join(pkg, e.name), path.join(LEARN, e.name), { recursive: true, filter: (s) => !path.basename(s).startsWith(".") });
  }
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`wrote ${path.relative(ROOT, LEARN)}: ${boards.length} lesson boards, a Playground page`);
}

await main();
