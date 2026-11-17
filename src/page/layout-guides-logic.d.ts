// Types for layout-guides-logic.js (the page imports the .js; the server and tests import it through these).
export type LayoutGuide = {
  type: "grid" | "columns" | "rows";
  size?: number;
  count?: number;
  align?: "stretch" | "start" | "center" | "end";
  gutter?: number;
  margin?: number;
  width?: number;
  offset?: number;
  color: string;
  visible?: boolean;
};
export type Rect = { x: number; y: number; w: number; h: number };
export const KEY: string;
export const TYPES: string[];
export const ALIGNS: string[];
export const DEFAULT_COLOR: string;
export function defaultGuide(type?: string): LayoutGuide;
export function cleanGuide(g: unknown): LayoutGuide | null;
export function guidesOf(metadata: unknown): LayoutGuide[];
export function withLayoutGuides(metadata: unknown, guides: unknown[]): Record<string, unknown> | null;
export function bands(g: LayoutGuide, len: number): { a: number; b: number }[];
export function shapes(g: LayoutGuide, w: number, h: number): { rects: Rect[]; lines: { axis: "x" | "y"; at: number }[] };
export function snapRects(frame: Rect, guides: LayoutGuide[]): Rect[];
export function cssColor(hex: string): string;
