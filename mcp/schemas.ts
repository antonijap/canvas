// Shared zod pieces for the tool inputs.

import { z } from "zod";

export const file = z.string().optional().describe("Path to the Canvas file (a .canvas document; absolute, ~/..., or file:// URL). Default: the file on the active canvas page, else the app's front tab");
export const fileRequired = z.string().describe("Path to the Canvas file (a .canvas document; absolute, ~/..., or file:// URL)");
export const client = z.string().optional().describe("Target a specific canvas page or app client id (see canvas_status). Default: the active one");
export const nodeId = z.string().min(1).max(200).describe("Node id, or an instance path like Ins01/Lbl01");
export const nodeIds = z.array(z.string().min(1).max(200)).min(1).max(20).describe("Node ids (1 to 20)");
export const depth = z.number().int().min(0).max(8).optional().describe("Child levels to include (default 4)");
export const timeoutMs = (max: number, def: number) => z.number().int().min(100).max(max).optional().describe(`Milliseconds to wait (default ${def}, max ${max})`);
export const themeMode = z.enum(["light", "dark", "system"]);
export const highlightStyle = z.enum(["pulse", "outline", "flash"]);
export const toastLevel = z.enum(["info", "success", "warn", "error"]);

// The document validator checks known track fields and keeps fields from newer versions.
export const motionAnimations = z.array(z.object({
  id: z.string().min(1),
  on: z.string().min(1),
  leave: z.string().min(1).optional().describe("reverse, reset or hold. Future names are kept with a warning."),
  origin: z.tuple([z.number().min(0).max(1), z.number().min(0).max(1)]).optional(),
  tracks: z.array(z.object({
    prop: z.string(),
    to: z.number().optional(),
    keys: z.array(z.object({
      t: z.number().min(0).max(60000),
      v: z.number(),
      ease: z.unknown().optional().describe("Easing of the segment ending at this key."),
    }).passthrough()).min(2).max(16).optional().describe("Strictly increasing times in ms. Use instead of from, to, delay, duration and ease."),
  }).passthrough()).min(1).max(8),
}).passthrough()).max(4);
