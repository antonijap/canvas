import { z } from "zod";
import type { CanvasDoc } from "./docfile.ts";

const value = z.union([z.string(), z.number()]);
type Value = z.infer<typeof value>;

function variableType(value: Value): "number" | "color" | "string" {
  if (typeof value === "number") return "number";
  return /^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(value) ? "color" : "string";
}

const name = z.string().trim().min(1).refine(
  (name) => !name.startsWith("$") && !Object.hasOwn(Object.prototype, name),
  "Use the variable name without $ or a reserved property name",
);
const themed = z.strictObject({ light: value, dark: value }).refine(
  ({ light, dark }) => variableType(light) === variableType(dark),
  "Light and dark values must have the same type",
);
export const variableEdit = {
  variables: z.record(name, z.union([value, themed])),
  remove: z.array(name).optional(),
};
export const variableEditBody = z.object({ file: z.string().min(1), ...variableEdit });

export function updateVariables(doc: CanvasDoc, { variables, remove }: z.infer<typeof variableEditBody>): void {
  const next = { ...doc.variables };
  for (const name of remove ?? []) delete next[name];

  const themes = doc.themes ?? {};
  const usesLightAndDark = (axis: string) => themes[axis]?.includes("light") && themes[axis]?.includes("dark");
  const axis = usesLightAndDark("mode") ? "mode" : Object.keys(themes).find(usesLightAndDark) ?? "mode";
  for (const [name, input] of Object.entries(variables)) {
    if (typeof input === "object") {
      if (!usesLightAndDark(axis)) {
        doc.themes = { ...themes, [axis]: [...new Set([...(themes[axis] ?? []), "light", "dark"])] };
      }
      next[name] = {
        type: variableType(input.light),
        value: [{ value: input.light, theme: { [axis]: "light" } }, { value: input.dark, theme: { [axis]: "dark" } }],
      };
    } else {
      next[name] = { type: variableType(input), value: input };
    }
  }
  if (doc.variables !== undefined || Object.keys(next).length) doc.variables = next;
}
