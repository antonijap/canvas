// Tool registration with one error format: "code: message. Hint: ...".

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ToolError } from "./client.ts";
import { expandLink, linkShape, missingAfterLink } from "./link.ts";

export type Content = ({ type: "text"; text: string } | { type: "image"; data: string; mimeType: string })[];
/** Return this from a handler to send content as is (images, plain text). */
export class Raw {
  content: Content;
  constructor(content: Content) {
    this.content = content;
  }
}

export type Extra = { signal?: AbortSignal; _meta?: { progressToken?: string | number }; sendNotification?: (n: any) => Promise<void> };

export const text = (v: unknown) => (typeof v === "string" ? v : JSON.stringify(v, null, 2));

export function errorText(e: unknown): string {
  if (e instanceof ToolError) return `${e.code}: ${e.message}${e.hint ? ` Hint: ${e.hint}` : ""}`;
  return `failed: ${(e as Error)?.message ?? String(e)}`;
}

export function tool<S extends Record<string, any>>(server: McpServer, name: string, description: string, shape: S, handler: (args: any, extra: Extra) => Promise<unknown> | unknown, annotations: { readOnlyHint?: boolean; destructiveHint?: boolean; idempotentHint?: boolean } = {}) {
  // A canvas:// link (Cmd+L in Canvas) fills the file and the node arguments (mcp/link.ts).
  server.registerTool(name, { description, inputSchema: linkShape(name, shape), annotations }, (async (args: any, extra: Extra) => {
    try {
      const a = expandLink(name, shape, args ?? {});
      const miss = missingAfterLink(name, shape, a);
      if (miss) throw new ToolError("invalid", `${miss} is required`, `Pass ${miss}, or a link that names it.`);
      const out = await handler(a, extra);
      if (out instanceof Raw) return { content: out.content };
      return { content: [{ type: "text" as const, text: text(out) }] };
    } catch (e) {
      return { isError: true, content: [{ type: "text" as const, text: errorText(e) }] };
    }
  }) as any);
}

/** Send a progress notification when the caller asked for them. */
export async function progress(extra: Extra, done: number, total: number, message: string) {
  const token = extra._meta?.progressToken;
  if (token === undefined || !extra.sendNotification) return;
  try {
    await extra.sendNotification({ method: "notifications/progress", params: { progressToken: token, progress: done, total, message } });
  } catch {
    // The client may have stopped listening; a missed update is harmless.
  }
}
