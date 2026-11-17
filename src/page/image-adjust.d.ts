export const ADJUST_KEYS: string[];
export function adjustValues(a: unknown): number[] | null;
export function adjustFragment(a: unknown): string;
export function adjustFromUrl(url: string): number[] | null;
export function adjustMatrix(v: number[]): number[][];
export function adjustPixels<T extends { length: number; [i: number]: number }>(data: T, m: number[][]): T;
export function svgMatrixValues(m: number[][]): string;
