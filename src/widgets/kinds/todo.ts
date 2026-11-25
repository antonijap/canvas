import { randomBytes } from "node:crypto";
import { bad, bool, extras, isObject, str } from "../check.ts";
import { WidgetError, type ActionResult, type Config, type WidgetKind } from "../types.ts";

type Item = { id: string; text: string; done: boolean };
const KNOWN = ["title", "hideDone", "items"];
const MAX_ITEMS = 200;
const MAX_TEXT = 500;

const newId = () => "i_" + [...randomBytes(6)].map((b) => (b % 36).toString(36)).join("");

function cleanItems(v: unknown): Item[] {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v)) throw bad("items", "must be a list");
  if (v.length > MAX_ITEMS) throw bad("items", `can hold at most ${MAX_ITEMS} items`);
  const seen = new Set<string>();
  return v.map((raw, n) => {
    if (!isObject(raw)) throw bad(`items[${n}]`, "must be an object");
    let id = str(raw.id, `items[${n}].id`, "", 40);
    if (!id || seen.has(id)) id = newId();
    seen.add(id);
    return { id, text: str(raw.text, `items[${n}].text`, "", MAX_TEXT), done: bool(raw.done, `items[${n}].done`, false) };
  });
}

const items = (c: Config) => (c.items as Item[]).map((i) => ({ ...i }));
const find = (list: Item[], id: unknown) => {
  const at = list.findIndex((i) => i.id === id);
  if (at < 0) throw new WidgetError(404, "item-not-found", `No item "${String(id)}"`);
  return at;
};
const text = (v: unknown) => {
  const t = str(v, "text", "", MAX_TEXT);
  if (typeof v !== "string") throw bad("text", "is required");
  return t;
};

export const todo: WidgetKind = {
  id: "todo",
  title: "To-do",
  description: "Tasks with checkboxes",
  cardSubtitle: "Tasks you tick off",
  symbol: "checklist",
  defaultSize: { w: 280, h: 160 },
  minSize: { w: 200, h: 120 },
  defaults: () => ({ title: "To-do", hideDone: false, items: [] }),
  validate(c: Config): Config {
    return { title: str(c.title, "title", "", 200), hideDone: bool(c.hideDone, "hideDone", false), items: cleanItems(c.items), ...extras(c, KNOWN) };
  },
  fields: [
    { key: "title", label: "Title", type: "text" },
    { key: "hideDone", label: "Hide done items", type: "bool" },
  ],
  actions: {
    addItem(c, a): ActionResult {
      const list = items(c);
      const item = { id: newId(), text: text(a.text), done: false };
      const at = typeof a.index === "number" ? Math.max(0, Math.min(list.length, Math.trunc(a.index))) : list.length;
      list.splice(at, 0, item);
      return { config: { ...c, items: list }, result: { id: item.id } };
    },
    toggleItem(c, a): ActionResult {
      const list = items(c);
      const i = list[find(list, a.id)];
      i.done = typeof a.done === "boolean" ? a.done : !i.done;
      return { config: { ...c, items: list }, result: { id: i.id, done: i.done } };
    },
    updateItem(c, a): ActionResult {
      const list = items(c);
      const i = list[find(list, a.id)];
      i.text = text(a.text);
      return { config: { ...c, items: list }, result: { id: i.id } };
    },
    removeItem(c, a): ActionResult {
      const list = items(c);
      list.splice(find(list, a.id), 1);
      return { config: { ...c, items: list } };
    },
    moveItem(c, a): ActionResult {
      const list = items(c);
      const [i] = list.splice(find(list, a.id), 1);
      if (typeof a.index !== "number" || !Number.isFinite(a.index)) throw bad("index", "is required");
      list.splice(Math.max(0, Math.min(list.length, Math.trunc(a.index))), 0, i);
      return { config: { ...c, items: list }, result: { id: i.id } };
    },
  },
};
