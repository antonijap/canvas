// Removal fails closed (Section 5): a room never applies an action on a role it checked more than ROLE_FRESH_MS ago.
// The Team pushes revocations (`push`); when a push is lost, the next action after the window asks the Team again.

import type { Role } from "./messages.ts";

export const ROLE_FRESH_MS = 60_000;

export interface RoleSource {
  role(person: string): Role | null;
}

export class RoleCache {
  private readonly seen = new Map<string, { role: Role | null; at: number }>();
  private readonly team: RoleSource;
  private readonly now: () => number;
  private readonly freshMs: number;
  /** Times the room asked the Team. */
  lookups = 0;
  constructor(team: RoleSource, now: () => number = Date.now, freshMs = ROLE_FRESH_MS) {
    this.team = team;
    this.now = now;
    this.freshMs = freshMs;
  }
  /** The person's role, asked again when the last answer is older than the window. */
  role(person: string): Role | null {
    const t = this.now();
    const hit = this.seen.get(person);
    if (hit && t - hit.at < this.freshMs) return hit.role;
    this.lookups++;
    const role = this.team.role(person);
    this.seen.set(person, { role, at: t });
    return role;
  }
  /** The Team's push: a new role (null: removed), in force at once. */
  push(person: string, role: Role | null): void {
    this.seen.set(person, { role, at: this.now() });
  }
}
