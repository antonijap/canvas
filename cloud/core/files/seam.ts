// The one place the file room imports the shared protocol, schema and apply from. Phase 1 owns those files; until it
// merges they come from ./phase1-snapshot. When it merges: point these three lines at "../../protocol-files.ts",
// "../schema.ts" and "./apply.ts", then delete ./phase1-snapshot. Nothing else in cloud/core/files changes.

export * from "./phase1-snapshot/protocol-files.ts";
export { validateNode, DESCENDANTS_PREFIX, PROTO_KEYS, type DocNode } from "./phase1-snapshot/schema.ts";
export { applyAction, isReject, opRunner, nextProps, refsOfNode, ApplyError, type TreeAccess, type ApplyCtx, type NodeView, type PageRow, type BlobRow, type Ver } from "./phase1-snapshot/apply.ts";

import type { applyAction } from "./phase1-snapshot/apply.ts";
/** The shared apply as the room takes it, so a test can wrap it (count calls, fail on purpose). */
export type ApplyFn = typeof applyAction;
