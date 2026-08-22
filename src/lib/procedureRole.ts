// What a procedure IS, said in one word, and which systems a system-level one
// covers.
//
// Both halves exist for the same complaint: the catalog knew these things and
// never said them.
//
// A procedure's character was spread across three independent fields - `kind`
// (task or test), `runsAtIntake`, and `intervalDays` - and the reader had to
// assemble "this is a PM" from the fact that a repeat box was ticked. Nothing on
// the row or in the form used the words the shop uses. So procedureRole names
// it, and the name is DERIVED rather than stored: the timing is the truth, and a
// stored label beside it would be a second version of the same fact, free to
// disagree.
//
// The second half is the thing that made system-level procedures unusable. They
// existed, and they applied to every system in the workspace with no way to
// narrow them - so an annual LC-MS PM would also land on every GC, and the only
// safe move was not to use them and to write each system's upkeep out by hand.
// A category scope fixes that, and an empty scope still means every system,
// which is exactly what the ones already defined meant.

import { scopeMatches } from "@/lib/checkout";
import type { Tone } from "@/lib/tones";

export type Timing = { runsAtIntake: boolean; intervalDays: number | null };

export type Role = "checkout" | "maintenance" | "both" | "none";

/**
 * The role in one word.
 *
 * "Both" is a real answer, not a fallback: a leak check run once when a unit
 * arrives AND every ninety days after is one procedure, and forcing it to be two
 * would mean maintaining the criteria twice.
 *
 * "None" is unreachable through the form, which refuses to save a procedure that
 * never runs, but a row can predate that rule or be edited by hand - and a badge
 * saying so is how somebody finds it.
 */
export function procedureRole(t: Timing): Role {
  if (t.runsAtIntake && t.intervalDays !== null) return "both";
  if (t.intervalDays !== null) return "maintenance";
  if (t.runsAtIntake) return "checkout";
  return "none";
}

export const ROLE_LABEL: Record<Role, string> = {
  checkout: "Checkout",
  maintenance: "Maintenance",
  both: "Checkout + maintenance",
  none: "Never runs",
};

export const ROLE_TONE: Record<Role, Tone> = {
  checkout: "info",
  maintenance: "good",
  both: "accent",
  none: "bad",
};

/**
 * Does this system-level procedure cover a system of this category?
 *
 * An empty scope covers every system. That is deliberate rather than lazy: it is
 * what every system procedure defined before this column existed meant, so the
 * default has to keep meaning it or a deploy would silently unschedule work.
 */
export const coversSystem = (categoryScope: string[], category: string): boolean =>
  categoryScope.length === 0 || scopeMatches(categoryScope, category);

/** "(LC-MS, GC-MS only)", or nothing at all when it covers everything. */
export const scopeLabel = (scope: string[], all: string) =>
  (scope.length ? ` (${scope.join(", ")} only)` : ` (${all})`);
