// Types for link-logic.js (the page imports the .js; the MCP and tests import it through these).
export type CanvasLink = { file: string; cloud?: string; cloudFile?: string; page: string | null; nodes: string[] };
export const PREFIX: string;
export const MAX_NODES: number;
export function encodePart(s: string): string;
export function buildLink(o: { file?: string; cloud?: string; cloudFile?: string; page?: string | null; nodes?: string[] }): string | null;
export function parseLink(text: unknown): CanvasLink | null;
export function findLinks(text: unknown): CanvasLink[];
export function boardInView(boards: { id: string; x: number; y: number; w: number; h: number }[], view: { x: number; y: number; w: number; h: number }): string | null;
