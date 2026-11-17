// Types for text-spans.js (the page imports the plain module; the server and tests import it through these).
export type Span = { start: number; end: number; [style: string]: unknown };
export const SPAN_KEYS: string[];
export function validSpanValue(k: string, v: unknown): boolean;
export function spanErrors(spans: unknown, len?: number): string[];
export function normalize(spans: unknown, len?: number, base?: Record<string, unknown> | null): Span[];
export function shift(spans: Span[], at: number, removed: number, inserted: number): Span[];
export function diff(a: string, b: string): { at: number; removed: number; inserted: number } | null;
export function follow(spans: Span[], before: string, after: string): Span[];
export function apply(spans: Span[], start: number, end: number, style: Record<string, unknown>, len?: number, base?: Record<string, unknown> | null): Span[];
export function styleAt(spans: Span[], start: number, end: number, base: Record<string, unknown> | null, len?: number): Record<string, unknown>;
export function keysIn(spans: unknown): string[];
export function without(spans: unknown, keys: string[], len?: number): Span[];
