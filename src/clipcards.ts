// Cards on the clipboard: copy, cut and paste of widget, shader and video cards, alone or with layers and boards
// (src/structure.ts carries them in the payload's `cards`). What travels with each kind:
//   note, todo     the config (the note's text, the list's items)
//   shader         the WGSL source, written under the new card's id in the target's shaders folder
//   video          the file: a video inside the source package is copied into the target's media folder; a linked
//                  one (an absolute path) stays a link. A card pinned over a node lets go of it.
//   posthog, app   the config, but never a secret across files: the Keychain reference is dropped, so the pasted
//                  card asks to be connected again. In its own file it keeps the reference (like Option-drag).
// A paste is one write of the widgets file and one undo step; with layers it joins their structure step.

import fs from "node:fs";
import path from "node:path";
import { cardRev, readShaderSource, SHADER_TEMPLATE, writePastedSource } from "./shaders.ts";
import { addWidgets, listWidgets, removeWidgets, type WidgetInput } from "./widgets.ts";
import { kindOf } from "./widgets/registry.ts";
import { VIDEO_TYPES } from "./widgets/kinds/video.ts";
import { copyIn, mediaDir, resolveSrc } from "./videos.ts";
import type { WriteOpts } from "./widgets/store.ts";
import type { Widget } from "./widgets/types.ts";
import type { ClipCard, Rect } from "./structure.ts";
import { randomBytes } from "node:crypto";

export const CARD_PREFIX = "widget:";
export const isCard = (id: unknown): id is string => typeof id === "string" && id.startsWith(CARD_PREFIX);
export const bareCard = (id: string) => id.slice(CARD_PREFIX.length);

const clone = <T>(v: T): T => structuredClone(v);

/** The cards to copy, by bare id, as they show (`rects` from the page: a card pinned over a node shows there). */
export async function copyCards(docFile: string, ids: string[], rects: Record<string, Rect> = {}): Promise<ClipCard[]> {
  if (!ids.length) return [];
  const all = listWidgets(docFile).widgets as Widget[];
  const out: ClipCard[] = [];
  for (const id of ids) {
    const w = all.find((x) => x.id === id);
    if (!w) continue;
    const r = rects[CARD_PREFIX + id];
    const ok = (v: unknown) => typeof v === "number" && Number.isFinite(v);
    const box = r && ok(r.x) && ok(r.y) && ok(r.w) && ok(r.h) && r.w > 0 && r.h > 0 ? r : { x: w.x, y: w.y, w: w.w, h: w.h };
    const card: ClipCard = { id: w.id, kind: w.kind, name: w.name, x: box.x, y: box.y, w: box.w, h: box.h, locked: w.locked === true, config: clone(w.config) };
    if ("link" in card.config) card.config.link = null;
    if (w.kind === "shader") card.source = (await readShaderSource(docFile, w.id)).source;
    if (w.kind === "video" && typeof w.config.src === "string" && w.config.src) {
      const abs = resolveSrc(docFile, w.config.src);
      if (abs) card.file = abs;
    }
    out.push(card);
  }
  return out;
}

/** Remove the cut cards in one write (joining the cut's step when `opts.record` says so). */
export async function cutCards(docFile: string, ids: string[], opts: WriteOpts): Promise<void> {
  if (ids.length) await removeWidgets(docFile, ids, opts);
}

/** A config without its secrets: the `secret` key and every field the kind declares as a secret (dotted keys). */
export function withoutSecrets(kind: string, config: Record<string, unknown>): Record<string, unknown> {
  // Null, not deleted: the kind's defaults would fill a missing key back in (mergeConfig deletes a null instead).
  const out = clone(config);
  out.secret = null;
  for (const f of kindOf(kind)?.fields ?? []) {
    if (f.type !== "secret") continue;
    const keys = f.key.split(".");
    let o: Record<string, unknown> = out;
    for (const k of keys.slice(0, -1)) o = typeof o[k] === "object" && o[k] !== null ? (o[k] as Record<string, unknown>) : (o[k] = {}) as Record<string, unknown>;
    o[keys[keys.length - 1]] = null;
  }
  return out;
}

const isFile = (p: string) => !!fs.statSync(p, { throwIfNoEntry: false })?.isFile();
const shaderId = () => "sh_" + [...randomBytes(8)].map((b) => (b % 36).toString(36)).join("");

export type PasteCardsOpts = {
  /** The payload came from this document. */
  sameFile: boolean;
  /** A cut pasted in its own file: the cards keep their ids where they are free (a move). */
  cut?: boolean;
  /** Where each card goes (null or missing: where it was copied). */
  positions?: ({ x: number; y: number } | null)[];
  /** The page the cards land on (undefined: the first page). */
  page?: string;
  record: NonNullable<WriteOpts["record"]>;
  /** Gets the files the paste copied into this document (a video into media/), for its undo to take back. */
  created?: string[];
};

/** Paste cards: their files first (shader sources, copied videos), then every card in one write. */
export async function pasteCards(docFile: string, cards: ClipCard[], o: PasteCardsOpts): Promise<Widget[]> {
  const list = cards.filter((c) => c && typeof c === "object" && typeof c.kind === "string" && c.config && typeof c.config === "object");
  if (!list.length) return [];
  const have = new Set((listWidgets(docFile).widgets as Widget[]).map((w) => w.id));
  const inputs: WidgetInput[] = [];
  const written: string[] = [];
  try {
    for (const c of list) {
      const pos = o.positions?.[cards.indexOf(c)] ?? null;
      let config = clone(c.config) as Record<string, unknown>;
      if ("link" in config) config.link = null;
      if (!o.sameFile) config = withoutSecrets(c.kind, config);
      const keepId = o.sameFile && o.cut && typeof c.id === "string" && !have.has(c.id) ? c.id : undefined;
      let id = keepId;
      if (c.kind === "shader") {
        id = id ?? shaderId();
        let source = typeof c.source === "string" ? c.source : null;
        if (source === null && o.sameFile && typeof c.id === "string") source = await readShaderSource(docFile, c.id).then((s) => s.source, () => null);
        source = source ?? SHADER_TEMPLATE;
        const f = await writePastedSource(docFile, id, source);
        if (!keepId) written.push(f);
        config.rev = cardRev(source, config.uniforms);
        config.source = 'shaders/' + path.basename(f);
      } else if (c.kind === "video" && !o.sameFile && typeof config.src === "string" && config.src && !path.isAbsolute(config.src)) {
        // A video inside the source package: copied into this one. Missing: the card names the file it had.
        const file = typeof c.file === "string" && path.isAbsolute(c.file) ? c.file : null;
        if (file && Object.hasOwn(VIDEO_TYPES, path.extname(file).toLowerCase()) && isFile(file)) {
          let had = new Set<string>();
          try { had = new Set(fs.readdirSync(mediaDir(docFile))); } catch { /* no media folder yet */ }
          const { src, hash, dest } = await copyIn(docFile, file);
          if (!had.has(path.basename(dest))) o.created?.push(dest);
          config.src = src;
          config.hash = hash;
        } else if (file) config.src = file;
      }
      const at = pos ?? { x: c.x, y: c.y };
      inputs.push({ kind: c.kind, name: typeof c.name === "string" ? c.name : undefined, x: Math.round(at.x * 100) / 100, y: Math.round(at.y * 100) / 100, w: c.w, h: c.h, locked: c.locked === true, config, ...(id ? { id } : {}), ...(o.page ? { page: o.page } : {}) });
    }
    return (await addWidgets(docFile, inputs, { record: o.record })).widgets;
  } catch (e) {
    // Nothing was added: the source files written for it go too.
    for (const f of written) await fs.promises.rm(f, { force: true }).catch(() => {});
    throw e;
  }
}
