// Scheduled vs advisory maintenance.
//
// A maintenance schedule says two things at once: what this model NEEDS
// ("seals every 12 months, kit X") and that somebody OWES that work. For a
// service contract both are true. For a reseller only the first is - they
// intake, test, and ship; the calendar knowledge matters at intake and at the
// sale, never as a to-do. Advisory keeps the schedules and their history but
// stops the machine acting on them: no generated tasks, no queue handoffs, no
// overdue red. Running one by hand still works - recording is never gated.
//
// Why advisory instead of just deleting the schedules: the last-done dates are
// worth the most at the moment the unit sells. "Full PM at intake, next due
// 8/2027" is a listing line, and the buyer's clock starts from truth instead
// of from a blank.
//
// The default follows the owning org - resellers (resale_enabled) get
// advisory, everyone else scheduled - and a per-system override beats the
// default in either direction, so a reseller's own service arm can put one
// system back on a real calendar without touching the org.

export type PmPosture = "scheduled" | "advisory";

/** What instruments.pm_posture may hold. '' = follow the owner. */
export const PM_POSTURES = ["", "scheduled", "advisory"] as const;

export const isPmPosture = (v: string): v is (typeof PM_POSTURES)[number] =>
  (PM_POSTURES as readonly string[]).includes(v);

/**
 * The posture in effect for one system. Unowned systems are scheduled: house
 * stock on a service shop's bench wants its calendar, and the reseller whose
 * whole instance runs advisory can say so explicitly per system.
 */
export function pmPosture(stored: string, ownerResale: boolean): PmPosture {
  if (stored === "scheduled" || stored === "advisory") return stored;
  return ownerResale ? "advisory" : "scheduled";
}

/** Is the stored value an explicit choice, or is the owner's default deciding? */
export const postureIsDefault = (stored: string): boolean =>
  stored !== "scheduled" && stored !== "advisory";

/**
 * The one-line explanation next to the toggle. Says where the current answer
 * came from, because "why is this system advisory" has two possible answers
 * and the fix for each is a different button.
 */
export function postureLine(stored: string, ownerResale: boolean, ownerName: string): string {
  const p = pmPosture(stored, ownerResale);
  if (!postureIsDefault(stored)) return p === "advisory"
    ? "Set on this system: upkeep is reference, nothing comes due."
    : "Set on this system: due work turns into tasks.";
  if (p === "advisory") return `${ownerName || "The owner"} is a reseller, so upkeep is reference by default - nothing comes due.`;
  return "Due work turns into tasks and moves the queue.";
}
