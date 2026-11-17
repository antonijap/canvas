import { roleFor } from "../../protocol";
import type { PeopleRule, Role } from "../../protocol";

export const ranks: Record<Role, number> = { viewer: 1, commenter: 2, editor: 3, owner: 4 };
export function configuredOwners(value: string): string[] {
  return value.split(",").map(email => email.trim().toLowerCase()).filter(Boolean);
}
export function effectiveRole(email: string, rules: PeopleRule[], owners: string[]): Role | null {
  return owners.includes(email) ? "owner" : roleFor(email, rules);
}
export function validateRules(value: unknown): value is PeopleRule[] {
  if (!Array.isArray(value) || value.length > 10_000) return false;
  const seen = new Set<string>();
  for (const rule of value) {
    if (!rule || typeof rule !== "object" || typeof rule.match !== "string") return false;
    if (rule.match !== rule.match.toLowerCase() || !/^(?:[^\s@]+)?@[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?\.[a-z0-9-]+$/.test(rule.match)) return false;
    if (!["owner", "editor", "commenter", "viewer", "deny"].includes(rule.role) || seen.has(rule.match)) return false;
    seen.add(rule.match);
  }
  return true;
}
export function hasOwner(rules: PeopleRule[], owners: string[]): boolean {
  if (owners.length) return true;
  return rules.some(rule => rule.role === "owner" && (
    rule.match.startsWith("@") || effectiveRole(rule.match, rules, owners) === "owner"
  ));
}
