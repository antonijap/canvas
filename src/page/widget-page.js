import { parse, textOf } from "./note-doc.js";

export const PAGE_PADDING = 32;

export function pageName(markdown) {
  const line = parse(markdown).map((block) => textOf(block.runs).trim()).find(Boolean);
  return line ? line.slice(0, 120) : "Page";
}

export function pageWidth(intrinsic, manual) {
  if (Number.isFinite(manual)) return Math.max(280, manual);
  return Math.max(480, Math.min(600, Math.ceil(intrinsic)) + PAGE_PADDING * 2);
}
