import type { ciData, diskData, gitData, usageData } from "./source-data.ts";

// Shared widget types. No runtime imports, so every other widget module can use them without cycles.

export type Config = Record<string, unknown>;

/** One widget as stored in the sidecar. Unknown extra keys are carried through untouched. */
export type Widget = {
  id: string;
  kind: string;
  name: string;
  x: number;
  y: number;
  w: number;
  h: number;
  locked: boolean;
  config: Config;
  [extra: string]: unknown;
};

export type SecretRef = { service: string; account: string };

export type ReadingState = "loading" | "ok" | "empty" | "stale" | "error" | "needs-secret" | "needs-approval";

/** `value` is the change against the previous sample, `pct` that change as a ratio (0.12 = +12%), `display` is ready to print. */
export type Delta = { value: number; pct?: number; display: string };

export type ChartType = "number" | "line" | "area" | "bar" | "hbar" | "stacked" | "pie" | "donut" | "table" | "funnel" | "ring" | "heatmap" | "sparklines";

/**
 * Structured data for a chart card. `labels` are the x positions (or slice, bar or row names); every
 * series has one value per label. `time` says the labels are ISO dates or times. `other` says the last
 * label folds the rest. `format` is the stat format every value is printed with.
 */
export type ChartData = {
  type: ChartType;
  labels: string[];
  series: { name: string; values: number[] }[];
  format: string;
  time?: boolean;
  other?: boolean;
  /** The whole the parts belong to, when it is not their sum (distinct people seen in two groups count once). */
  total?: number;
};

/** What a live widget shows right now. Never stored in the sidecar; pushed over SSE as `wdata`. */
export type Reading = {
  state: ReadingState;
  approvalTarget?: string;
  empty?: string;
  content?: {
    git?: ReturnType<typeof gitData>;
    ci?: ReturnType<typeof ciData>;
    usage?: ReturnType<typeof usageData>;
    preview?: string;
    local?: { hash: string; data: unknown };
    disk?: ReturnType<typeof diskData>;
  };
  display?: string;
  value?: number | string;
  spark?: number[];
  delta?: Delta;
  chart?: ChartData;
  label?: string;
  updatedAt?: number;
  error?: { code: string; message: string };
};

/** Server error with an HTTP status and a stable machine code. Also used for fetch failures (status 0). */
export class WidgetError extends Error {
  status: number;
  code: string;
  retryAfterSec?: number;
  constructor(status: number, code: string, message: string, retryAfterSec?: number) {
    super(message);
    this.name = "WidgetError";
    this.status = status;
    this.code = code;
    this.retryAfterSec = retryAfterSec;
  }
}

export class SourceApproval extends WidgetError {
  readonly target: string;
  constructor(target: string, verb: "load" | "read") {
    super(0, "needs-approval", `Allow this widget to ${verb} ${target}`);
    this.target = target;
  }
}

export type Field = {
  /** Dotted keys ("auth.type") address nested config; PATCH merges nested objects, so send just that branch. */
  key: string;
  label: string;
  type: "text" | "textarea" | "number" | "select" | "bool" | "secret" | "url";
  options?: { value: string; label: string }[];
  help?: string;
};

export type RequestOptions = {
  url: string;
  sameOrigin?: boolean;
  method?: "GET" | "POST";
  headers?: Record<string, string>;
  body?: unknown;
  secret?: SecretRef;
  /** How the secret travels: "bearer" (Authorization header) or a named header. */
  secretAs?: "bearer" | { header: string };
  maxBytes?: number;
};

export type JsonResponse = { status: number; headers: Record<string, string>; json: unknown };

export type FetchCtx = {
  file: string;
  widget: Widget;
  /** True for the manual Refresh button: skip caches the upstream keeps. */
  force: boolean;
  now: number;
  request(o: RequestOptions): Promise<JsonResponse>;
};

export type SourceData = Omit<Reading, "state" | "updatedAt" | "error">;

export type Source = {
  approval?: {
    field: string;
    verb: "load" | "read";
    target(c: Config): string | undefined;
  };
  /** On-disk bundle version for local sources. */
  version?: string;
  /** Two widgets with the same key share one fetch per round. Cover everything that changes the result. */
  key(c: Config): string;
  minIntervalSec: number;
  intervalSec(c: Config): number;
  fetch(ctx: FetchCtx): Promise<SourceData>;
  /** The secret this widget sends and the origin it sends it to, for the trust prompt. */
  secretUse?(c: Config): { ref: SecretRef; origin: string } | undefined;
};

export type ActionResult = { config: Config; result?: unknown };

export type WidgetKind = {
  id: string;
  title: string;
  description?: string;
  cardSubtitle?: string;
  picker?: boolean;
  /** SF Symbol name for the native shell. */
  symbol: string;
  /** Not offered in the Widgets panel or to agents' list_widget_kinds (the Welcome card): only Canvas makes one. */
  hidden?: boolean;
  defaultSize: { w: number; h: number };
  minSize: { w: number; h: number };
  defaults(): Config;
  /** Fill gaps from defaults, reject bad values with a 422, keep unknown keys. Returns the config to store. */
  validate(c: Config): Config;
  fields: Field[];
  local?: { hash: string; previewHTML?: string };
  source?: Source;
  actions?: Record<string, (c: Config, args: Record<string, unknown>) => ActionResult>;
};
