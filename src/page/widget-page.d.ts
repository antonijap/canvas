export const PAGE_PADDING: number;
export function pageName(markdown: string): string;
export function withPageName(markdown: string, name: string, replaceFirstLine: boolean): string;
export function pageWidth(intrinsic: number, manual?: number): number;
