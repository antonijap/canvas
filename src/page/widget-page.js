import { block, parse, serialize, textOf } from "./note-doc.js";

export const PAGE_PADDING = 32;

export function pageName(markdown) {
  const line = parse(markdown).map((block) => textOf(block.runs).trim()).find(Boolean);
  return line ? line.slice(0, 120) : "Page";
}

/** Write a literal title without reserializing the body. */
export function withPageName(markdown, name, replaceFirstLine) {
  const end = markdown.search(/[\r\n]/);
  const first = parse(end < 0 ? markdown : markdown.slice(0, end))[0];
  if (!replaceFirstLine && textOf(first.runs).trim()) return markdown;
  const title = name.replace(/\s*[\r\n]+\s*/g, " ").trim();
  if (!replaceFirstLine && !title) return markdown;
  const type = ["h1", "h2", "h3"].includes(first.type) ? first.type : "h1";
  const heading = title ? serialize([block(type, [{ text: title }])]) : "";
  if (first.type === "hr") return heading ? heading + "\n" + markdown : markdown;
  return heading + (end < 0 ? "" : markdown.slice(end));
}

export function pageWidth(intrinsic, manual) {
  if (Number.isFinite(manual)) return Math.max(280, manual);
  return Math.max(480, Math.min(600, Math.ceil(intrinsic)) + PAGE_PADDING * 2);
}
