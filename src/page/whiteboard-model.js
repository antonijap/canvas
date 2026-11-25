// Shared by the canvas, scene renderer and export. The document keeps the colour and sticker names.
export const STICKY_COLORS = Object.freeze({
  yellow: "#F8DC7B", peach: "#F7BE95", pink: "#F2B2C3", purple: "#CBBBF0",
  blue: "#A9D2F2", green: "#B0E2C5", gray: "#D9D9DE",
});

export const STICKERS = Object.freeze({
  agree: { label: "Agree", key: "a", color: "#20864E", path: "m5 12 4 4L19 6" },
  love: { label: "Love it", key: "l", color: "#C83A62", path: "M20.8 8.6c0 4.2-8.8 9.6-8.8 9.6s-8.8-5.4-8.8-9.6a4.5 4.5 0 0 1 8.8-1 4.5 4.5 0 0 1 8.8 1Z" },
  star: { label: "Star", key: "s", color: "#9A6200", path: "m12 3 2.8 5.7 6.2.9-4.5 4.4 1 6.2-5.5-3-5.5 3 1-6.2L3 9.6l6.2-.9Z" },
  question: { label: "Question", key: "q", color: "#4C75C6", path: "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18Zm-2.3 6.3a2.4 2.4 0 1 1 3.6 2c-1 .5-1.3 1.2-1.3 2.2m0 2.9h.01" },
  idea: { label: "Idea", key: "i", color: "#7954CB", path: "M9 18h6m-5 3h4M9 15c0-3-3-3.3-3-7a6 6 0 1 1 12 0c0 3.7-3 4-3 7Z" },
  flag: { label: "Flag", key: "f", color: "#BA5422", path: "M5 21V4m0 1c5-5 9 4 14 0v10c-5 4-9-5-14 0" },
  "plus-one": { label: "Plus one", key: "1", color: "#197D91", path: "M3 12h8m-4-4v8m8-6 4-2v8" },
  rocket: { label: "Rocket", key: "r", color: "#626D84", path: "M14 6c1.8-1.8 4-2.7 7-3-.3 3-1.2 5.2-3 7l-6 6-4-4 6-6Zm2.5 1.5h.01M9 10l-4 1-2 4 5-1m6 1-1 4-4 2 1-5m-6 3-1 2 2-1" },
});

export const WHITEBOARD_PAINT = Object.freeze({
  ink: "#18181B", authorInk: "#40384A", avatar: "#6554C0", white: "#FFFFFF", shadow: "#00000033", "vote-done": STICKERS.agree.color,
});
export const STICKY_SIZE = 184;
export const STICKY_PADDING = 16;
export const STICKER_SIZE = 42;
export const STICKY_GAP = 16;
export const STICKER_MIN_ICON = 16;
export const isStickyColor = (key) => typeof key === "string" && Object.hasOwn(STICKY_COLORS, key);
export const isStickerKind = (key) => typeof key === "string" && Object.hasOwn(STICKERS, key);
export const isTextLayer = (type) => type === "text" || type === "sticky";
export const stickyTextId = (id) => id + "/:sticky-text";
const stickyPart = /\/:sticky-(?:text|author(?:-avatar|-initial|-name)?)$/;
export const stickyOwner = (id) => typeof id === "string" ? id.replace(stickyPart, "") : id;

export function whiteboardPerson(value) {
  return value && typeof value === "object" && !Array.isArray(value) &&
    typeof value.name === "string" && value.name.trim() && value.name.length <= 60 && !/[\x00-\x1f\x7f]/.test(value.name) &&
    typeof value.id === "string" && /^[a-z0-9_-]{1,128}$/i.test(value.id) ? { name: value.name, id: value.id } : null;
}

export function stickerAnchor(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const { layer, x, y } = value;
  return typeof layer === "string" && layer.length > 0 && layer.length <= 1024 &&
     Number.isFinite(x) && x >= 0 && x <= 1 && Number.isFinite(y) && y >= 0 && y <= 1 ? { layer, x, y } : null;
}

export function stickerData(node) {
  if (node?.type !== "sticker" || node.enabled === false || !isStickerKind(node.kind) || typeof node.id !== "string") return null;
  const on = stickerAnchor(node.on);
  if (!on || on.layer === node.id) return null;
  return { id: node.id, kind: node.kind, on, by: whiteboardPerson(node.by), locked: node.locked === true,
    x: Number.isFinite(node.x) ? node.x : 0, y: Number.isFinite(node.y) ? node.y : 0 };
}

export function stackStickers(stickers) {
  const stacks = new Map();
  for (const sticker of stickers) {
    const key = sticker.missingTarget ? sticker.id : JSON.stringify([sticker.on.layer, sticker.kind]);
    const stack = stacks.get(key);
    if (stack) stack.push(sticker);
    else stacks.set(key, [sticker]);
  }
  return stacks;
}

export function stickerGlyph(kind, size = STICKER_MIN_ICON) {
  const art = isStickerKind(kind) ? STICKERS[kind] : STICKERS.agree;
  return `<svg xmlns="http://www.w3.org/2000/svg" aria-hidden="true" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.25" stroke-linecap="round" stroke-linejoin="round"><path d="${art.path}"/></svg>`;
}

export function stickyText(node) {
  const text = { type: "text", id: stickyTextId(node.id), content: node.content ?? "", width: "fill_container",
    textGrowth: "fixed-width", fontFamily: node.fontFamily ?? "system-ui", fontSize: node.fontSize ?? 15,
    fontWeight: node.fontWeight ?? "500", fill: node.fill ?? WHITEBOARD_PAINT.ink };
  for (const key of ["contentVar", "spans", "lineHeight", "fontStyle", "letterSpacing", "underline", "strikethrough",
    "textAlign", "lists", "paragraphSpacing", "paragraphIndent", "listSpacing", "hangingList", "hangingPunctuation", "letterCase", "href"]) {
    if (node[key] !== undefined) text[key] = node[key];
  }
  return text;
}

function stickyAuthor(node) {
  const person = node.showAuthor !== false && whiteboardPerson(node.author);
  if (!person) return null;
  const id = node.id + "/:sticky-author";
  const label = { type: "text", fontFamily: "system-ui", fontSize: 11, fontWeight: "500", fill: WHITEBOARD_PAINT.authorInk };
  return { type: "frame", id, layout: "horizontal", alignItems: "center", gap: 6, width: "fill_container", height: 16, clip: true,
    children: [
      { type: "frame", id: id + "-avatar", width: 16, height: 16, cornerRadius: 8, fill: WHITEBOARD_PAINT.avatar,
        layout: "none", children: [{ ...label, id: id + "-initial", content: Array.from(person.name.trim())[0].toUpperCase(),
          width: 16, height: 16, textAlign: "center", textAlignVertical: "middle", textGrowth: "fixed-width-height", fill: WHITEBOARD_PAINT.white }] },
      { ...label, id: id + "-name", content: person.name },
    ] };
}

/** The stored layer is a text-editable leaf. Only the renderer sees the frame and its children. */
export function stickyFrame(node) {
  const { content, spans, author, showAuthor, autoHeight, ...frame } = node;
  const width = node.width ?? STICKY_SIZE;
  const height = node.height ?? (typeof width === "number" ? width : STICKY_SIZE);
  const by = stickyAuthor(node);
  const paddingX = typeof width === "number" ? Math.max(2, Math.min(STICKY_PADDING, (width - 1) / 2)) : STICKY_PADDING;
  return { ...frame, type: "frame", width, height: autoHeight === false ? height : "fit_content",
    ...(autoHeight === false ? {} : { canvasLayout: { minHeight: typeof height === "number" ? height : STICKY_SIZE } }),
    layout: "vertical", padding: [STICKY_PADDING, paddingX], gap: 10, justifyContent: "space_between",
    cornerRadius: 6, fill: STICKY_COLORS[isStickyColor(node.color) ? node.color : "yellow"],
    effect: { type: "shadow", offset: { x: 0, y: 4 }, blur: 12, color: WHITEBOARD_PAINT.shadow },
    clip: autoHeight === false, children: [stickyText(node), ...(by ? [by] : [])] };
}

/** Leaves without whiteboard content keep their identity, so ordinary scenes do not need to be re-encoded. */
export function whiteboardScene(node) {
  if (node.type === "sticky") return stickyFrame(node);
  if (node.type === "sticker") return { type: "rectangle", id: node.id, width: 0, height: 0, layoutPosition: "absolute", locked: true, opacity: 0 };
  if (!node.children?.length) return node;
  const children = node.children.map(whiteboardScene);
  return children.some((child, i) => child !== node.children[i]) ? { ...node, children } : node;
}
