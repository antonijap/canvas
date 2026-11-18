// The file room's messages (Section 2.2 of the plan), the parts Phase 2 runs. They belong in cloud/protocol-files.ts
// once Phase 1 merges; until then they live here so the room and its tests share one shape.

import { sha256Hex } from "./sha256.ts";
import type { Action, AppliedAction, Author, RejectCode, Uuid } from "./seam.ts";

export type Role = "owner" | "editor" | "commenter" | "viewer";
export const CAN_EDIT: Record<Role, boolean> = { owner: true, editor: true, commenter: false, viewer: false };
export type FileRejectCode = RejectCode | "expired" | "reset";

export interface Hello {
  type: "hello";
  protocol: 2;
  file: Uuid;
  /** The last seq this Mac holds confirmed (0: none). */
  since: number;
  /** The epoch it holds (0: none yet). */
  epoch: number;
  /** Actions it may have sent before; the room answers which it applied. At most 500. */
  pending: { id: Uuid; sha: string }[];
}
export interface ActionsMessage {
  type: "actions";
  epoch: number;
  actions: Action[];
}
export interface Welcome {
  type: "welcome";
  protocol: 2;
  role: Role;
  me: Author;
  epoch: number;
  seq: number;
  /** Present when the Mac must start from a snapshot: its manifest, then the tail after `seq`. */
  snapshot?: { seq: number; manifest: string };
  known: { id: Uuid; first: number; last: number }[];
  limits: { opsPerMessage: number; actionBytes: number };
}
export type FileServerMessage =
  | Welcome
  | { type: "applied"; actions: AppliedAction[] }
  | { type: "ack"; id: Uuid; first: number; last: number }
  | { type: "reject"; id: Uuid; code: FileRejectCode; message: string }
  | { type: "reset"; epoch: number; reason: "restored" }
  | { type: "error"; code: RejectCode; message: string };

/**
 * The payload hash a receipt binds: the action exactly as sent (id, base, epoch, time, ops, label). A resend is byte
 * for byte, so it hashes the same; anything else with that id is another action.
 */
export function actionSha(a: Action): string {
  return sha256Hex(JSON.stringify([a.id, a.baseSeq, a.epoch, a.at ?? null, a.ops, a.agent ?? null]));
}
