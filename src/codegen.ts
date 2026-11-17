// Copy as code (right-click > Copy as > CSS / SwiftUI): a layer's own styles as code to
// paste into a project. It describes the selected layer itself (size, position, auto layout, fill,
// stroke, corners, effects, type), not its children. Sizes come from the laid-out box, so Hug and Fill read as the
// pixels drawn; the auto layout rules are named too. Pure: src/export-run.ts gives it the node and boxes.
// "text" is Copy as text: the text of the text layers in the selection.

import { gradientCss, resolveProps, type CanvasDoc, type DocNode } from "./engine.ts";

export type CodeFormat = "css" | "swiftui" | "text";
export type CodeAnswer = { id: string; name: string; text: string };
type Box = { x: number; y: number; width: number; height: number };
export type CodeInput = { node: DocNode; parent: DocNode | null; doc: CanvasDoc; theme: Record<string, string>; warnings: string[]; box: Box; parentBox?: Box };

const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
const r2 = (v: number) => Math.round(v * 100) / 100;
const px = (v: number) => (v === 0 ? "0px" : `${r2(v)}px`);
const list = (v: unknown): any[] => (v === undefined || v === null ? [] : Array.isArray(v) ? v : [v]);
const on = (f: any) => !(f && typeof f === "object" && f.enabled === false);

/** "#RGB", "#RRGGBB", "#RRGGBBAA" as 0-1 components, or null. */
export function hexRgba(c: unknown): { r: number; g: number; b: number; a: number } | null {
  if (typeof c !== "string" || !c.startsWith("#")) return null;
  let h = c.slice(1);
  if (h.length === 3 || h.length === 4) h = [...h].map((x) => x + x).join("");
  if (!/^[0-9a-f]{6}([0-9a-f]{2})?$/i.test(h)) return null;
  const v = (i: number) => parseInt(h.slice(i, i + 2), 16) / 255;
  return { r: v(0), g: v(2), b: v(4), a: h.length === 8 ? v(6) : 1 };
}

/** Upper-case hex, 6 digits when opaque. */
function hex(c: unknown): string | undefined {
  const k = hexRgba(c);
  if (!k) return typeof c === "string" ? c : undefined;
  const b = (x: number) => Math.round(x * 255).toString(16).padStart(2, "0").toUpperCase();
  return `#${b(k.r)}${b(k.g)}${b(k.b)}${k.a < 1 ? b(k.a) : ""}`;
}

function colorOf(f: any): string | undefined {
  if (typeof f === "string") return hex(f);
  if (f?.type === "color") return hex(f.color);
  return undefined;
}

const sizing = (v: unknown) => (typeof v === "number" ? "fixed" : typeof v === "string" && v.startsWith("fill_container") ? "fill" : "hug");
const isText = (t: string) => t === "text";
const JUSTIFY: Record<string, string> = { start: "flex-start", center: "center", end: "flex-end", space_between: "space-between", space_around: "space-around" };
const ALIGN: Record<string, string> = { start: "flex-start", center: "center", end: "flex-end" };

function pads(v: unknown): [number, number, number, number] | null {
  if (typeof v === "number") return [v, v, v, v];
  if (Array.isArray(v) && v.length === 2) return [v[0], v[1], v[0], v[1]].map((x) => num(x) ?? 0) as [number, number, number, number];
  if (Array.isArray(v) && v.length === 4) return v.map((x) => num(x) ?? 0) as [number, number, number, number];
  return null;
}

/** The layer's own CSS, in order: position and size, auto layout, paint, type. */
export function cssFor(i: CodeInput): string {
  const n = resolveProps(i.doc, i.node, i.theme, i.warnings);
  const p = i.parent ? resolveProps(i.doc, i.parent, i.theme, i.warnings) : null;
  const type = String(n.type);
  const out: string[] = [`/* ${String(n.name ?? n.id).replace(/\*\//g, "* /")} */`, ""];
  const add = (k: string, v: string | undefined) => { if (v !== undefined && v !== "") out.push(`${k}: ${v};`); };
  const parentLayout = p ? (String(p.type) === "group" ? "none" : String(p.layout ?? "horizontal")) : "none";
  const inFlow = p && parentLayout !== "none" && n.layoutPosition !== "absolute";
  if (p && !inFlow) add("position", "absolute");
  add("width", px(i.box.width));
  add("height", px(i.box.height));
  if (p && !inFlow) { add("left", px(i.box.x)); add("top", px(i.box.y)); }
  if (inFlow) {
    const main = parentLayout === "vertical" ? "height" : "width";
    const cross = main === "width" ? "height" : "width";
    out.push("");
    add("flex", sizing(n[main]) === "fill" ? "1 1 0" : "none");
    if (sizing(n[cross]) === "fill") add("align-self", "stretch");
  }
  if (type === "frame" && n.layout !== "none") {
    out.push("", "/* Auto layout */");
    add("display", "flex");
    add("flex-direction", n.layout === "vertical" ? "column" : "row");
    add("justify-content", JUSTIFY[String(n.justifyContent)] ?? "flex-start");
    add("align-items", ALIGN[String(n.alignItems)] ?? "flex-start");
    const pd = pads(n.padding);
    if (pd) add("padding", pd.every((x) => x === pd[0]) ? px(pd[0]) : pd[0] === pd[2] && pd[1] === pd[3] ? `${px(pd[0])} ${px(pd[1])}` : pd.map(px).join(" "));
    if (num(n.gap)) add("gap", px(n.gap as number));
  }
  out.push("");
  if (!isText(type)) {
    const bgs = list(n.fill).filter(on).map((f) => (f?.type === "gradient" ? gradientCss(f) : f?.type === "image" ? `url(${JSON.stringify(String(f.url ?? ""))})` : colorOf(f))).filter(Boolean) as string[];
    if (bgs.length) add("background", bgs.reverse().join(", "));
    const stroke = list(n.stroke).filter(on).map(colorOf).find(Boolean);
    const sw = n.strokeWidth;
    if (stroke && typeof sw === "number" && sw > 0) add("border", `${px(sw)} solid ${stroke}`);
    else if (stroke && sw && typeof sw === "object") for (const side of ["top", "right", "bottom", "left"]) { const w = num((sw as any)[side]); if (w) add(`border-${side}`, `${px(w)} solid ${stroke}`); }
    const r = n.cornerRadius;
    if (type === "ellipse") add("border-radius", "50%");
    else if (typeof r === "number" && r > 0) add("border-radius", px(r));
    else if (Array.isArray(r) && r.some((x) => num(x))) add("border-radius", r.map((x) => px(num(x) ?? 0)).join(" "));
  }
  const shadows: string[] = [], filters: string[] = [];
  for (const e of list(n.effect).filter(on)) {
    if (e?.type === "shadow") shadows.push(`${e.shadowType === "inner" ? "inset " : ""}${px(num(e.offset?.x) ?? 0)} ${px(num(e.offset?.y) ?? 0)} ${px(num(e.blur) ?? 0)}${num(e.spread) ? " " + px(e.spread) : ""} ${hex(e.color ?? "#00000040")}`);
    else if (e?.type === "blur") filters.push(`blur(${px((num(e.radius) ?? 0) / 2)})`);
    else if (e?.type === "background_blur") add("backdrop-filter", `blur(${px((num(e.radius) ?? 0) / 2)})`);
  }
  if (shadows.length) add(isText(type) ? "text-shadow" : "box-shadow", shadows.join(", "));
  if (filters.length) add("filter", filters.join(" "));
  if (num(n.opacity) !== undefined && (n.opacity as number) < 1) add("opacity", String(r2(n.opacity as number)));
  if (num(n.rotation)) add("transform", `rotate(${r2(-(n.rotation as number))}deg)`);
  if (isText(type)) {
    add("font-family", `'${String(n.fontFamily ?? "Inter").replace(/'/g, "")}'`);
    add("font-style", typeof n.fontStyle === "string" && /italic/i.test(n.fontStyle) ? "italic" : "normal");
    add("font-weight", String(n.fontWeight ?? "400"));
    if (num(n.fontSize)) add("font-size", px(n.fontSize as number));
    if (num(n.lineHeight)) add("line-height", `${r2((n.lineHeight as number) * 100)}%`);
    if (num(n.letterSpacing)) add("letter-spacing", px(n.letterSpacing as number));
    if (typeof n.textAlign === "string") add("text-align", n.textAlign);
    const deco = [n.underline === true ? "underline" : "", n.strikethrough === true ? "line-through" : ""].filter(Boolean).join(" ");
    if (deco) add("text-decoration", deco);
    const tt = ({ upper: "uppercase", lower: "lowercase", title: "capitalize" } as Record<string, string>)[String(n.letterCase)];
    if (tt) add("text-transform", tt);
    if (n.letterCase === "small-caps") add("font-variant-caps", "small-caps");
    const c = list(n.fill).filter(on).map(colorOf).find(Boolean);
    if (c) add("color", c);
  }
  while (out[out.length - 1] === "") out.pop();
  return out.filter((l, k) => !(l === "" && out[k - 1] === "")).join("\n");
}

const sw = (v: number) => String(r2(v));
function swiftColor(c: unknown): string | undefined {
  const k = hexRgba(c);
  if (!k) return undefined;
  const base = `Color(red: ${sw(k.r)}, green: ${sw(k.g)}, blue: ${sw(k.b)})`;
  return k.a < 1 ? `${base}.opacity(${sw(k.a)})` : base;
}
const WEIGHT: Record<string, string> = { "100": "ultraLight", "200": "thin", "300": "light", "400": "regular", "500": "medium", "600": "semibold", "700": "bold", "800": "heavy", "900": "black" };

/** The layer as a SwiftUI view with its modifiers: a Text, a shape, or a stack for auto layout. */
export function swiftUIFor(i: CodeInput): string {
  const n = resolveProps(i.doc, i.node, i.theme, i.warnings);
  const type = String(n.type);
  const lines: string[] = [`// ${String(n.name ?? n.id)}`];
  const mod = (s: string) => lines.push(`    .${s}`);
  const r = num(n.cornerRadius) ?? 0;
  const shape = type === "ellipse" ? "Ellipse()" : r > 0 ? `RoundedRectangle(cornerRadius: ${sw(r)})` : "Rectangle()";
  const fill = list(n.fill).filter(on).map((f) => swiftColor(typeof f === "string" ? f : f?.type === "color" ? f.color : undefined)).find(Boolean);
  if (isText(type)) {
    lines.push(`Text(${JSON.stringify(String(n.content ?? ""))})`);
    const fam = String(n.fontFamily ?? "Inter");
    const size = sw(num(n.fontSize) ?? 14);
    const w = WEIGHT[String(n.fontWeight ?? "400")] ?? "regular";
    mod(/^(SF Pro|system-ui|-apple-system)/i.test(fam) ? `font(.system(size: ${size}, weight: .${w}))` : `font(.custom(${JSON.stringify(fam)}, size: ${size}).weight(.${w}))`);
    if (num(n.letterSpacing)) mod(`tracking(${sw(n.letterSpacing as number)})`);
    if (num(n.lineHeight) && num(n.fontSize)) mod(`lineSpacing(${sw(((n.lineHeight as number) - 1) * (n.fontSize as number))})`);
    if (fill) mod(`foregroundStyle(${fill})`);
    if (n.textAlign === "center" || n.textAlign === "right") mod(`multilineTextAlignment(.${n.textAlign === "center" ? "center" : "trailing"})`);
    mod(`frame(width: ${sw(i.box.width)}, height: ${sw(i.box.height)}${n.textAlign === "center" ? "" : n.textAlign === "right" ? ", alignment: .trailing" : ", alignment: .leading"})`);
  } else if (type === "frame" && n.layout !== "none") {
    const v = n.layout === "vertical";
    const al = { start: v ? "leading" : "top", center: "center", end: v ? "trailing" : "bottom" }[String(n.alignItems ?? "start")] ?? (v ? "leading" : "top");
    lines.push(`${v ? "VStack" : "HStack"}(alignment: .${al}, spacing: ${sw(num(n.gap) ?? 0)}) {`, "    // children", "}");
    const pd = pads(n.padding);
    if (pd && pd.some((x) => x)) mod(pd.every((x) => x === pd[0]) ? `padding(${sw(pd[0])})` : `padding(EdgeInsets(top: ${sw(pd[0])}, leading: ${sw(pd[3])}, bottom: ${sw(pd[2])}, trailing: ${sw(pd[1])}))`);
    mod(`frame(width: ${sw(i.box.width)}, height: ${sw(i.box.height)})`);
    if (fill) mod(`background(${fill}, in: ${shape})`);
  } else {
    lines.push(shape);
    if (fill) mod(`fill(${fill})`);
    mod(`frame(width: ${sw(i.box.width)}, height: ${sw(i.box.height)})`);
  }
  const stroke = list(n.stroke).filter(on).map((f) => swiftColor(typeof f === "string" ? f : f?.type === "color" ? f.color : undefined)).find(Boolean);
  if (!isText(type) && stroke && num(n.strokeWidth)) mod(`overlay(${shape}.stroke(${stroke}, lineWidth: ${sw(n.strokeWidth as number)}))`);
  for (const e of list(n.effect).filter(on)) {
    if (e?.type === "shadow" && e.shadowType !== "inner") mod(`shadow(color: ${swiftColor(e.color ?? "#00000040") ?? "Color.black.opacity(0.25)"}, radius: ${sw((num(e.blur) ?? 0) / 2)}, x: ${sw(num(e.offset?.x) ?? 0)}, y: ${sw(num(e.offset?.y) ?? 0)})`);
    else if (e?.type === "blur") mod(`blur(radius: ${sw((num(e.radius) ?? 0) / 2)})`);
  }
  if (num(n.opacity) !== undefined && (n.opacity as number) < 1) mod(`opacity(${sw(n.opacity as number)})`);
  if (num(n.rotation)) mod(`rotationEffect(.degrees(${sw(-(n.rotation as number))}))`);
  return lines.join("\n");
}

/** Every text layer's text, in reading order, one per line (Copy as text). */
export function textOf(node: DocNode): string {
  const out: string[] = [];
  const walk = (n: DocNode) => {
    if (n.enabled === false) return;
    if (n.type === "text" && typeof n.content === "string") out.push(n.content);
    for (const c of (n.children as DocNode[] | undefined) ?? []) walk(c);
  };
  walk(node);
  return out.join("\n");
}

export function codeFor(format: CodeFormat, i: CodeInput): string {
  return format === "css" ? cssFor(i) : format === "swiftui" ? swiftUIFor(i) : textOf(i.node);
}
