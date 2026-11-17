// The page side of the alignment checks (qa/ink.ts): what to measure in the DOM, in one expression the page's eval
// (pnpm qa, qa/scenarios-alignment.ts) and the app's page (pnpm qa:native, qa/native/scenarios-alignment.ts) both run.
import type { Img } from "../fidelity/png.ts";
import { textLine } from "./ink.ts";

/**
 * Boxes (b: selector) and text lines (t: selector) of the page, by name; null when not drawn. A box's r is its
 * largest corner radius (a pin's teardrop: the round ones). A text line is its first line's box, its text and its
 * font's cap height and x-height: resolve() finds its baseline on the capture. An expression, for the page's eval or
 * the app's (qa/native/scenarios-alignment.ts).
 */
export function measureJs(want: Record<string, string>): string {
  return `(() => { const out = {}; const want = ${JSON.stringify(want)};
    const ctx = window.__alignCtx || (window.__alignCtx = document.createElement("canvas").getContext("2d"));
    for (const [k, spec] of Object.entries(want)) {
      const kind = spec.slice(0, 2), s = spec.slice(2);
      const e = document.querySelector(s); out[k] = null; if (!e) continue;
      if (kind === "b:") {
        const b = e.getBoundingClientRect(); if (!b.width) continue;
        const cs = getComputedStyle(e); const rs = [cs.borderTopLeftRadius, cs.borderTopRightRadius, cs.borderBottomRightRadius, cs.borderBottomLeftRadius].map(parseFloat);
        out[k] = { x: b.left, y: b.top, w: b.width, h: b.height, r: Math.min(Math.max(...rs), b.width / 2, b.height / 2) };
        continue;
      }
      let host = e, b = null;
      if (e.tagName === "TEXTAREA") {
        const r = e.getBoundingClientRect(), cs = getComputedStyle(e);
        b = { left: r.left + parseFloat(cs.paddingLeft), top: r.top, width: r.width - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight), height: r.height };
      } else {
        const tw = document.createTreeWalker(e, NodeFilter.SHOW_TEXT, { acceptNode: (n) => (n.textContent.trim() ? 1 : 3) });
        const n = tw.nextNode(); if (!n) continue;
        host = n.parentElement;
        const r = document.createRange(); r.selectNodeContents(n); b = r.getClientRects()[0]; if (!b) continue;
      }
      const cs = getComputedStyle(host); ctx.font = cs.fontStyle + " " + cs.fontWeight + " " + cs.fontSize + " " + cs.fontFamily;
      out[k] = { rect: { x: b.left, y: b.top, w: b.width, h: b.height }, text: e.tagName === "TEXTAREA" ? (e.value || e.placeholder) : host.textContent, capH: ctx.measureText("H").actualBoundingBoxAscent, xH: ctx.measureText("x").actualBoundingBoxAscent, x: b.left, w: b.width };
    } return out; })()`;
}
/** Text lines measured on the capture (qa/ink.ts textLine), at k px per point. */
export function resolve(img: Img, m: Record<string, any>, k: number): Record<string, any> {
  for (const v of Object.values(m)) if (v && v.rect) Object.assign(v, textLine(img, k, v.rect, v.text, v.capH, v.xH) ?? {});
  return m;
}
