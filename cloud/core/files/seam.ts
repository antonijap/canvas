// Shared protocol, schema and apply used by the file room and the local editor.
export * from "../../protocol-files.ts";
export { validateNode, DESCENDANTS_PREFIX, PROTO_KEYS, type DocNode } from "../schema.ts";
export { applyAction, isReject, opRunner, nextProps, refsOfNode, ApplyError, type TreeAccess, type ApplyCtx, type NodeView, type PageRow, type BlobRow, type Ver } from "./apply.ts";

import type { applyAction } from "./apply.ts";
/** The shared apply as the room takes it, so a test can wrap it. */
export type ApplyFn = typeof applyAction;
