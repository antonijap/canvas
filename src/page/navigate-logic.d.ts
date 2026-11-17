// Types for navigate-logic.js (the page imports the .js; tests import it through these).
export type Cam = { x: number; y: number; z: number };
export type Guide = { axis: "x" | "y"; at: number };
export type DrawnGuide = { board: string; index: number; axis: string; at: number; from: number; to: number };
export const MIN_ZOOM: number;
export const MAX_ZOOM: number;
export const PIXEL_GRID_ZOOM: number;
export const PAN_STEP: number;
export const PAN_STEP_BIG: number;
export const RULER: number;
export function zoomAbout(cam: Cam, z: number, px: number, py: number): Cam;
export function navKey(e: { metaKey?: boolean; ctrlKey?: boolean; altKey?: boolean; shiftKey?: boolean; key?: string; code?: string }, o?: { selected?: boolean }): { op: string; dx?: number; dy?: number } | null;
export function gridLines(offset: number, z: number, size: number): number[];
export function rulerStep(z: number, minPx?: number): number;
export function rulerTicks(offset: number, z: number, size: number, minPx?: number): { step: number; ticks: { value: number; at: number }[] };
export function dropGuide(axis: "x" | "y", world: { x: number; y: number }, boards: { id: string; x: number; y: number; w: number; h: number }[], snap?: boolean): { board: string; at: number } | null;
export function guideAt(guides: DrawnGuide[], px: number, py: number, slop?: number): DrawnGuide | null;
export function withGuides(metadata: unknown, guides: Guide[]): Record<string, unknown> | null;
