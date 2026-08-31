// What maintenance costs, which nothing has ever asked.
//
// Job costing has only ever been a work order's question: a closed job, what
// it billed and what it cost. A completed PM is not a work order - it is a
// task carrying its schedule's id - so every preventive job the shop has ever
// done has been invisible on the money side, parts and all.
//
// The parts were there the whole time. parts.pm_schedule_id is stamped from
// the "Part of maintenance" picker, and lib/agreementUsage already sums it -
// for exactly one purpose: keeping those parts OFF the client's allowance
// where the contract includes PM parts. So the shop computed what a PM's parts
// cost in order not to bill for them, and then had nowhere to watch the money
// leave.
//
// COST ONLY, and no margin. A PM bills nothing of its own - an invoice points
// at a work order or an agreement, never at a schedule - so a percentage here
// would divide by zero and mean nothing if it didn't. This says what
// maintenance costs, which is the question that was missing.
//
// PARTS ONLY, for now, and the panel says so rather than quietly reporting a
// third of a number as the whole thing. time_entries and expenses link to a
// work order and to nothing else; attributing hours to a PM by system and date
// would take them off a work order that has a real claim to them. The honest
// fix is a link of their own, which is its own change.
//
// Pure. Callers hand in the rows.

import { inWindow } from "@/lib/costing";

/** One time somebody finished the job - a Done task carrying its schedule. */
export type PmCompletion = {
  taskId: number;
  scheduleId: number;
  title: string;
  orgName: string;
  systemName: string;
  /** Where the record lives, so a figure can be opened. Blank if nowhere. */
  href: string;
  /** YYYY-MM-DD in shop time. */
  completedOn: string;
};

export type PmPart = {
  scheduleId: number;
  /** YYYY-MM-DD. Blank means never fitted, and an unfitted part is not spent. */
  installedOn: string;
  costCents: number;
  /** The work order already answering for this part, when one is. */
  onWorkOrder: string;
};

export type PmJobCost = {
  taskId: number;
  title: string;
  orgName: string;
  systemName: string;
  href: string;
  completedOn: string;
  partsCents: number;
  /** How many part lines are in the figure. A kit is one line - see below. */
  parts: number;
  /** The sentence beside the figure, when something is deliberately not in it. */
  note: string;
};

export type PmCostBoard = {
  rows: PmJobCost[];
  /** Completed in the window with no parts recorded. Counted, not listed. */
  quiet: number;
  totalCents: number;
};

/**
 * What each completed maintenance job cost in parts.
 *
 * THE ATTRIBUTION RULE, which is the whole of the difficulty. pm_schedule_id
 * names the SCHEDULE, not the visit: a quarterly PM is one id and twelve
 * completions, and a part stamped with it says which recurring job it was for
 * and not which time. A part is put against the first completion on or after
 * the day it was FITTED - the job it was fitted for.
 *
 * Which is why `completions` must be every completion of the schedule and not
 * only the ones in the window. Hand it the window's rows alone and a seal
 * fitted two years ago lands on the oldest completion still on screen, dressed
 * up as this quarter's spend.
 *
 * Kits need no special handling and get none: a kit line carries the money and
 * its contents are written at zero cost (see the parts schema), so summing a
 * box and everything in it counts the box once. Full kit or loose components,
 * one honest total either way.
 */
export function pmCosts(
  completions: PmCompletion[],
  parts: PmPart[],
  today: string,
  windowDays: number,
): PmCostBoard {
  const bySchedule = new Map<number, PmCompletion[]>();
  for (const c of [...completions].sort((a, b) => a.completedOn.localeCompare(b.completedOn))) {
    bySchedule.set(c.scheduleId, [...(bySchedule.get(c.scheduleId) ?? []), c]);
  }

  const cents = new Map<number, number>();
  const lines = new Map<number, number>();
  const elsewhere = new Map<number, Set<string>>();
  for (const p of parts) {
    if (!p.installedOn) continue;
    const home = bySchedule.get(p.scheduleId)?.find((c) => c.completedOn >= p.installedOn);
    // Fitted since the last time this job was finished: real money, but not on
    // a completed job yet. It lands the next time somebody completes the PM.
    if (!home) continue;
    /* Already costed as a work order's part, and this page shows both panels.
       Adding it here would put one purchase in two totals on one screen, which
       is the way two figures end up disagreeing in front of the customer. The
       row says where it went instead of silently reading low. */
    if (p.onWorkOrder) {
      elsewhere.set(home.taskId, (elsewhere.get(home.taskId) ?? new Set<string>()).add(p.onWorkOrder));
      continue;
    }
    cents.set(home.taskId, (cents.get(home.taskId) ?? 0) + p.costCents);
    lines.set(home.taskId, (lines.get(home.taskId) ?? 0) + 1);
  }

  let quiet = 0;
  const rows: PmJobCost[] = [];
  for (const c of completions) {
    if (!inWindow(c.completedOn, today, windowDays)) continue;
    const on = elsewhere.get(c.taskId);
    const n = lines.get(c.taskId) ?? 0;
    /* A PM that took no parts is a true and completely uninteresting row, and
       a quarter of them would bury the ones that cost something. Counted in a
       sentence instead, so the total is still visibly accounted for. */
    if (n === 0 && !on) { quiet += 1; continue; }
    rows.push({
      taskId: c.taskId, title: c.title, orgName: c.orgName, systemName: c.systemName,
      href: c.href, completedOn: c.completedOn,
      partsCents: cents.get(c.taskId) ?? 0,
      parts: n,
      note: on ? `parts costed on ${[...on].sort().join(", ")}` : "",
    });
  }
  rows.sort((a, b) => b.completedOn.localeCompare(a.completedOn) || a.taskId - b.taskId);

  return { rows, quiet, totalCents: rows.reduce((n, r) => n + r.partsCents, 0) };
}
