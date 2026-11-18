// Canvas's design system — the single source of truth for every element of the studio chrome.
//
// The vocabulary: zinc palette, floating
// islands with a rim, overlay scrollbars, tabular numerals. One object defines everything;
// `cssVariables()` renders it as CSS custom properties, and the page uses nothing but
// var(--c-*) — so a token change restyles the whole app.

export type Palette = Record<string, string>;

const light: Palette = {
  canvasBg: "#f6f6f6",
  sidebar: "#fafafa",
  sidebarBorder: "#e4e4e7",
  sidebarFg: "#18181b",
  popover: "#ffffff",
  island: "color-mix(in srgb, var(--c-popover), var(--c-fg) 5%)",
  islandRim: "color-mix(in srgb, var(--c-sidebar-border), transparent 40%)",
  fg: "#18181b",
  mutedFg: "#6e6e77", // zinc-500 a shade darker: 4.5:1 on the canvas, islands and muted fills (WCAG AA)
  muted: "#f4f4f5",
  accent: "#f4f4f5",
  primary: "#18181b",
  primaryFg: "#fafafa",
  ring: "#d4d4d8",
  danger: "#d82323", // red, dark enough for 4.5:1 as text on white and under white text
  /** A red fill under white text (a note's error). Light: the danger red; dark: deeper than the danger text red. */
  dangerFill: "#d82323",
  warn: "#f59e0b",
  ok: "#22c55e",
  hover: "#0000000d",
  field: "#0000001f", // 12%: at 8% light-theme fields vanished on the glass panels
  active: "#00000017",
  stroke: "#00000014",
  sel: "#0766EB",
  component: "#9747FF",
  componentSoft: "#9747FF1f",
  scrollbarThumb: "#00000038",
  scrollbarThumbActive: "#0000006b",
  scrollbarTrackHover: "#0000000d",
  // Talk to the selection (src/page/spark.js, apps/macos/Palette.swift's Recent asks).
  hairline: "#0000001a",
  line: "#e4e4e7",
  placeholder: "#62626d", // 4.5:1 on a field (12% black)
  disabled: "#d4d4d8",
  tooltip: "#18181be6",
  /** A selected row in a list or the palette: neutral grey, never the accent (the accent is the canvas selection). */
  rowSelected: "#0000000f",
  /** Secondary text and icons on the accent tint: the tint's hue, darker. Never grey on a coloured background. */
  selInk: "#3f6db8",
};

const dark: Palette = {
  canvasBg: "#18181b",
  sidebar: "#18181b",
  sidebarBorder: "#3f3f46",
  sidebarFg: "#f4f4f5",
  popover: "#27272a",
  island: "color-mix(in srgb, var(--c-popover), var(--c-fg) 5%)",
  islandRim: "color-mix(in srgb, var(--c-sidebar-border), transparent 30%)",
  fg: "#f4f4f5",
  mutedFg: "#a1a1aa",
  muted: "#27272a",
  accent: "#3f3f46",
  primary: "#fafafa",
  primaryFg: "#18181b",
  ring: "#52525b",
  danger: "#f87171",
  dangerFill: "#dc2626", // 4.5:1 under white text; the danger red above stays for text on dark surfaces
  warn: "#f59e0b",
  ok: "#4ade80",
  hover: "#ffffff12",
  field: "#ffffff17",
  active: "#ffffff1f",
  stroke: "#ffffff14",
  sel: "#3B82F6",
  component: "#A66EFF",
  componentSoft: "#A66EFF2e",
  scrollbarThumb: "#ffffff3d",
  scrollbarThumbActive: "#ffffff73",
  scrollbarTrackHover: "#ffffff0f",
  hairline: "#ffffff1f",
  line: "#3f3f46",
  placeholder: "#a4a4ab", // 4.5:1 on a field
  disabled: "#52525b",
  tooltip: "#3f3f46f2",
  rowSelected: "#ffffff14",
  selInk: "#93b4f0",
};

// One spacing scale: 4, 8, 10, 12. Every gap, pad and inset below is one of them, and every
// control is 32pt so it is comfortable to hit; pills wrap a control with 4pt around it.
export const METRICS = {
  inset: 10,
  gap: 10,
  islandGap: 10,
  radiusIsland: 22,
  islandHeight: 40,
  islandPad: 8,
  radius: 10,
  radiusRow: 10,
  sidebarWidth: 244,
  sidebarMin: 200,
  sidebarMax: 420,
  resizeHit: 12,
  propsWidth: 284,
  scrollbar: 10,
  pill: 40,
  pillPad: 4,
  control: 32,
  icon: 15,
  row: 32,
  field: 28,
  radiusField: 8,
  railWidth: 40,
  tabMin: 96,
  trafficLights: 78,
};

export const TYPE = {
  sans: `ui-sans-serif, -apple-system, "system-ui", "Segoe UI", Helvetica, "Apple Color Emoji", Arial, sans-serif`,
  mono: `"Roboto Mono", ui-monospace, Menlo, monospace`,
  size2xs: "11px",
  sizeXs: "12px",
  sizeSm: "13px",
  sizeBase: "16px",
};

export const MOTION = {
  fast: "0.15s cubic-bezier(0.4, 0, 0.2, 1)",
  island: "0.25s cubic-bezier(0.22, 1, 0.36, 1)",
};

export const TOKENS = { light, dark, metrics: METRICS, type: TYPE, motion: MOTION };

const kebab = (k: string) => k.replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`);

function block(palette: Palette): string {
  const lines = Object.entries(palette).map(([k, v]) => `  --c-${kebab(k)}: ${v};`);
  const metrics = Object.entries(METRICS).map(([k, v]) => `  --c-${kebab(k)}: ${v}px;`);
  const type = [
    `  --c-font-sans: ${TYPE.sans};`,
    `  --c-font-mono: ${TYPE.mono};`,
    `  --c-size-2xs: ${TYPE.size2xs};`,
    `  --c-size-xs: ${TYPE.sizeXs};`,
    `  --c-size-sm: ${TYPE.sizeSm};`,
    `  --c-size-base: ${TYPE.sizeBase};`,
  ];
  const motion = [
    `  --c-fast: ${MOTION.fast};`,
    `  --c-island-ease: ${MOTION.island};`,
  ];
  return [":root {", ...lines, ...metrics, ...type, ...motion, "}"].join("\n");
}

/** :root (light) plus the dark palette under a prefers-color-scheme: dark media query. */
export function cssVariables(): string {
  return `${block(light)}\n@media (prefers-color-scheme: dark) {\n:root {\n${Object.entries(dark)
    .map(([k, v]) => `  --c-${kebab(k)}: ${v};`)
    .join("\n")}\n}\n}`;
}
