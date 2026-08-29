// What the operations rooms are saying today.
//
// The hub at /ops is a MORNING PAGE, not a menu: a grid of nine links would be
// the dropdown again in bigger type, and the reason to give a section a page
// of its own is that a page can carry the one line each room would say if you
// asked it. "EOD - not filed yet" decides where to tap; "EOD" does not.
//
// Cheap on purpose. Every signal here is one indexed count or one min(), and
// every one of them is caught: a hub that cannot read a count still renders
// the room, without the line. A page that 500s because a badge failed would be
// a worse morning than no badge.
import { and, asc, eq, lte, ne } from "drizzle-orm";
import { db } from "@/db";
import { eodUpdates, pmSchedules } from "@/db/schema";
import { forTenant } from "@/lib/tenancy";

export type Signal = {
  /** The line the card shows, or "" for a card with nothing to report. */
  text: string;
  /** Colours the card. Absent leaves it plain - see below on green. */
  tone?: "info" | "good" | "warn" | "bad";
};

export type OpsSignals = {
  eod: Signal;
  calendar: Signal;
  maintenance: Signal;
  parity: Signal;
};

/** Nothing to say. Rendered as a card with no pill at all. */
const QUIET: Signal = { text: "" };

export async function opsSignals(
  /** The workspace whose rooms these are - lib/tenancy.readTenant. */
  scope: number | null,
  today: string,
  /** Already counted by the shell, so the hub does not count it twice. */
  openDiffs: number,
  modules: { eod: boolean; sheetSync: boolean },
): Promise<OpsSignals> {
  const [eodRows, duePm, nextPm] = await Promise.all([
    modules.eod
      ? db.select({ id: eodUpdates.id }).from(eodUpdates)
          .where(and(forTenant(eodUpdates.tenantOrgId, scope), eq(eodUpdates.date, today)))
          .limit(1).catch(() => [])
      : [],
    db.select({ id: pmSchedules.id }).from(pmSchedules)
      .where(and(forTenant(pmSchedules.tenantOrgId, scope),
        eq(pmSchedules.paused, false), lte(pmSchedules.nextDue, today)))
      .catch(() => []),
    db.select({ nextDue: pmSchedules.nextDue }).from(pmSchedules)
      .where(and(forTenant(pmSchedules.tenantOrgId, scope),
        eq(pmSchedules.paused, false), ne(pmSchedules.nextDue, "")))
      .orderBy(asc(pmSchedules.nextDue)).limit(1).catch(() => []),
  ]);

  return {
    /* Filed or not, and nothing in between. "Filed" earns its green because
       the question it answers is binary and somebody has to answer it before
       they go home - which is exactly the case where a green pill is
       information rather than reassurance. */
    eod: !modules.eod ? QUIET
      : eodRows.length ? { text: "Filed today", tone: "good" }
        : { text: "Not filed yet", tone: "warn" },
    /* The next dated thing the shop has committed to. A date is a better
       signal than a count here: "3 this week" does not tell you whether one of
       them is tomorrow. */
    calendar: nextPm[0]?.nextDue
      ? { text: `Next ${nextPm[0].nextDue <= today ? "due now" : nextPm[0].nextDue}`, tone: nextPm[0].nextDue <= today ? "warn" : "info" }
      : QUIET,
    maintenance: duePm.length
      ? { text: `${duePm.length} due`, tone: "warn" }
      : QUIET,
    /* The count that used to be a suffix on a nav label - "Sheet parity (3)" -
       printed by every surface whether or not it had room for it. This is the
       room it belongs in. */
    parity: !modules.sheetSync ? QUIET
      : openDiffs ? { text: `${openDiffs} unresolved`, tone: "warn" } : QUIET,
  };
}
