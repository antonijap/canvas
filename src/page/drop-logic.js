// Drops on the canvas, the pure part (node-tested, test/drop-logic.test.ts): which layer a Cmd-drop fills, the fill
// list it gets, where a plain image drop puts its layers. The page side is /page/drops.js.
//
// A shader tile from the Widgets panel fills the layer it is dropped on (outlined while the pointer is over it) and
// makes a card only over empty canvas, or anywhere with Option held. Image files: a plain drop places
// image layers; holding Cmd while dragging outlines the layer under the pointer, and the drop becomes its fill. A component from the
// Components panel drops as an instance (into an auto layout frame's flow at the slot under the pointer); holding
// Option over an instance swaps that instance instead.
import { extrasOf, inFlow, layoutOf, orderWith, slotAt } from "./autolayout-logic.js";

/** Layers that take a fill dropped on them. Text, groups, icons and paths pass the drop to the nearest one around. */
export const FILLABLE = new Set(["frame", "rectangle", "ellipse"]);

/**
 * The layer a Cmd-drop fills: `chain` is the ids from the board down to the layer under the pointer, `typeOf(id)` its
 * type as drawn. The selected layer takes it when the pointer is over it (select a card, then drop anywhere on it);
 * otherwise the deepest fillable layer under the pointer. Null over empty canvas.
 */
export function fillTarget(chain, typeOf, selected) {
  if (!Array.isArray(chain) || !chain.length) return null;
  if (selected && chain.includes(selected) && FILLABLE.has(typeOf(selected))) return selected;
  for (let i = chain.length - 1; i >= 0; i--) if (FILLABLE.has(typeOf(chain[i]))) return chain[i];
  return null;
}

/**
 * The layer a shader tile dropped at the pointer fills, or null for a card: the fillable layer under the pointer
 * (fillTarget), none over empty canvas. Option held places a card even over a layer.
 */
export const tileTarget = (chain, typeOf, selected, alt = false) => (alt ? null : fillTarget(chain, typeOf, selected));

const asList = (v) => (v === undefined || v === null ? [] : Array.isArray(v) ? v.slice() : [v]);
const kindOf = (f) => (f && typeof f === "object" && !Array.isArray(f) ? f.type : "color");

/**
 * A layer's fill list with `fill` on top (the last entry paints on top). A fill of the same kind (shader on shader,
 * image on image) is replaced, not stacked: a second shader under an opaque one only costs GPU time, and a dropped
 * image means "this picture". Colours and gradients stay underneath, so a see-through shader or image shows them and
 * the old look is one fill away.
 */
export function withFill(current, fill) {
  const kind = kindOf(fill);
  const out = asList(current).filter((f) => kindOf(f) !== kind);
  out.push(fill);
  return out;
}

/** The fill a shader tile makes: a Paper Shaders id ("mesh-gradient") with its default preset (src/shader-fill.ts). */
export const shaderFill = (preset) => {
  const [shader, variant] = String(preset).split("/", 2);
  return { type: "shader", shader, preset: variant || "Default" };
};

/**
 * The fill a shader card makes when it is Cmd-dragged onto a layer: a Paper preset card gives its shader, preset and
 * params; a hand-written card its WGSL `source` and uniforms. A card set to play only on hover stays still as a fill
 * (`autoplay: false`). Null when there is nothing to fill with.
 */
export function cardFill(config, source) {
  const c = config && typeof config === "object" ? config : {};
  const still = c.autoplay === false ? { autoplay: false } : {};
  const p = c.paper;
  if (p && typeof p === "object" && typeof p.shader === "string" && p.shader) {
    const params = p.params && typeof p.params === "object" && Object.keys(p.params).length ? { params: { ...p.params } } : {};
    return { type: "shader", shader: p.shader, preset: typeof p.preset === "string" && p.preset ? p.preset : "Default", ...params, ...still };
  }
  if (typeof source !== "string" || !source) return null;
  const u = Array.isArray(c.uniforms) && c.uniforms.length ? { uniforms: [...c.uniforms] } : {};
  return { type: "shader", source, ...u, ...still };
}

/** The fill an image file makes: cover, the Fill mode. */
export const imageFill = (url) => ({ type: "image", url, mode: "fill" });

/** An image layer's size: its own px, the long side at most `max` (images past 4096 px scale down). */
export function imageLayerSize(w, h, max = 4096) {
  const k = Math.min(1, max / Math.max(w, h, 1));
  return { w: Math.max(1, Math.round(w * k)), h: Math.max(1, Math.round(h * k)) };
}

/**
 * Where image layers dropped at world point `at` go: side by side in a row, `gap` apart, the row's middle under the
 * pointer, top edges level. `sizes`: [{w, h}].
 */
export function sideBySide(sizes, at, gap = 20) {
  const total = sizes.reduce((s, z) => s + z.w, 0) + gap * Math.max(0, sizes.length - 1);
  const tall = sizes.reduce((m, z) => Math.max(m, z.h), 0);
  let x = at.x - total / 2;
  const y = at.y - tall / 2;
  return sizes.map((z) => {
    const r = { x: Math.round(x), y: Math.round(y), w: z.w, h: z.h };
    x += z.w + gap;
    return r;
  });
}

/**
 * The frame a plain drop puts new layers in: the deepest frame under the pointer that is a stored layer (not a layer
 * drawn inside a component instance, nor the instance itself). `info(id)` gives {type, instance}. Null: the canvas.
 * keep: Space held, "keep the parent when adding": no frame takes the drop, it lands on the canvas.
 */
export function dropParent(chain, info, keep = false) {
  if (keep || !Array.isArray(chain)) return null;
  for (let i = chain.length - 1; i >= 0; i--) {
    const id = chain[i];
    if (typeof id !== "string" || id.includes("/")) continue;
    const n = info(id);
    if (n && n.type === "frame" && !n.instance) return id;
  }
  return null;
}

// ---------- a component dragged from the Components panel ----------

/**
 * The instance an Option-drop of a component swaps (hold Option while dropping a component on an instance):
 * the deepest instance under the pointer, a nested one included. `info(id)` gives {type, instance}. Null: none there.
 */
export function swapTarget(chain, info) {
  if (!Array.isArray(chain)) return null;
  for (let i = chain.length - 1; i >= 0; i--) {
    const n = typeof chain[i] === "string" ? info(chain[i]) : null;
    if (n && n.instance) return chain[i];
  }
  return null;
}

/** Where a dropped instance's top-left goes: its middle under the pointer (whole pixels); without a size, its corner. */
export function centredAt(at, size) {
  const w = size && Number.isFinite(size.w) ? size.w : 0, h = size && Number.isFinite(size.h) ? size.h : 0;
  return { x: Math.round(at.x - w / 2), y: Math.round(at.y - h / 2) };
}

/**
 * A layer dropped into an auto layout frame joins its flow at the slot under the pointer (the same slot a drag of a
 * layer there takes): its index among the frame's children. `parent`: the frame as drawn (scene node, children
 * included); `rectOf(id)`: world rects. Null: the frame does not lay out its children (x and y place the layer).
 */
export function flowIndex(parent, rectOf, p) {
  const dir = layoutOf(parent);
  if (dir === "none") return null;
  const kids = Array.isArray(parent.children) ? parent.children.filter((c) => c && c.id !== undefined) : [];
  const flow = [], rects = [];
  for (const c of kids) {
    if (!inFlow(parent, c)) continue;
    const r = rectOf(String(c.id));
    if (r) { flow.push(String(c.id)); rects.push(r); }
  }
  const NEW = "\u0000new";
  const order = orderWith(kids.map((c) => String(c.id)), flow, [NEW], slotAt(rects, p, dir, !!extrasOf(parent).wrap));
  return order.indexOf(NEW);
}

/** Image files among dropped or pasted files, in their order. */
export const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp", "image/svg+xml"]);
export const isImageFile = (f) => !!f && (IMAGE_TYPES.has(f.type) || /\.(png|jpe?g|gif|webp|svg)$/i.test(f.name || ""));
