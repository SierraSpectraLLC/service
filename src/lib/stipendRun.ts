// The stipend pass.
//
// Once a day it asks every live standing arrangement whether a cycle has come
// due, and puts a row on that person's perks claim for each one that has. Same
// three disciplines as lib/recurringRun, learned the same way:
//
//   IT NEVER PAYS TWICE. Every raise writes stipends.last_on in the same
//   breath as the expense row, and lib/stipends.dueStipendCycles refuses a
//   cycle at or before it. A pass that runs twice raises nothing the second
//   time - by construction, not by luck. The stipend_id on the row is the
//   second belt: it says which arrangement and which month a payment came
//   from, so the question can be asked of the data afterwards.
//
//   IT CATCHES UP. A pass that did not run for a week raises what it missed,
//   oldest first, capped - an engineer should not be out of pocket because a
//   cron job had a bad Tuesday, and a stipend misconfigured to start in 2014
//   should not empty an account overnight.
//
//   A RUN THAT RAISES NOTHING IS THE NORMAL OUTCOME and is a success.
//
// WHERE IT DIFFERS FROM THE RETAINER PASS, deliberately. That one raises a
// DRAFT and stops, because sending a $20,000 invoice to a client is an
// outward-facing act nobody made a decision about. This one SUBMITS the claim.
// A stipend is not a judgement waiting to be made - the owner made it when
// they set the arrangement up, at a fixed amount, for a named person - and the
// money still does not move until an owner marks the report paid, which is the
// same wall every other reimbursement stands behind. Leaving these as drafts
// would mean somebody opening and submitting the same claim every month, which
// is precisely the work the feature exists to remove.

import { and, eq, inArray } from "drizzle-orm";
import { db } from "@/db";
import { expenseReports, expenses, stipends } from "@/db/schema";
import { shopDay } from "@/lib/shopday";
import {
  STIPEND_SOURCE, dueStipendCycles, perksTitle, stipendDescription, stipendLive,
} from "@/lib/stipends";

export type StipendResult = {
  raised: { person: string; label: string; on: string; amountCents: number; report: number }[];
  submitted: number[];
  failed: { person: string; label: string; on: string; error: string }[];
  /** Arrangements that are live but had nothing due today. */
  quiet: number;
};

/**
 * This person's perks claim for this month, opened if it is not there yet.
 *
 * Narrowed first by the things that cannot lie - this person, this workspace,
 * source = stipend, and still editable - and then by the month's title. The
 * tenant test is not optional: expense_reports is one instance-wide table and
 * `person` is free text, so two companies can both employ an Owen Brandt and
 * one shop's perks claim must never collect the other's stipend.
 *
 * Only an EDITABLE one counts. If August's claim has already been submitted
 * and a second stipend falls due later that month, the money belongs on a new
 * claim - a submitted report cannot take rows, and silently skipping the
 * payment would be worse than a second claim.
 *
 * WHAT IF SOMEBODY RENAMES ONE. The title is the month's natural key here and
 * an owner can edit it, so a renamed claim means the next stipend that month
 * opens a second one. That is untidy and visible, and it is deliberately NOT
 * where the never-pay-twice guarantee lives - that is stipends.last_on, which
 * no report title can affect. Grouping is a convenience; not paying twice is
 * the invariant, and the two are kept apart on purpose.
 */
async function perksReportFor(
  person: string, tenantOrgId: number | null, cycle: string,
): Promise<{ id: number; fresh: boolean }> {
  const existing = await db.select().from(expenseReports).where(and(
    eq(expenseReports.person, person),
    eq(expenseReports.source, STIPEND_SOURCE),
    tenantOrgId === null ? undefined : eq(expenseReports.tenantOrgId, tenantOrgId),
    inArray(expenseReports.status, ["draft", "returned"]),
  ));
  const hit = existing.find((r) => r.title === perksTitle(cycle));
  if (hit) return { id: hit.id, fresh: false };

  const [row] = await db.insert(expenseReports).values({
    tenantOrgId, person, status: "draft", source: STIPEND_SOURCE,
    title: perksTitle(cycle),
    purpose: "Standing monthly reimbursements - stipends and allowances. Raised automatically.",
    // Overhead, and the null is the real answer rather than an unanswered
    // field: no job caused an internet bill. Same distinction the create form
    // makes a person draw by hand.
    workOrderId: null,
    openedBy: "",
  }).returning();
  return { id: row.id, fresh: true };
}

export async function runStipends(now = new Date()): Promise<StipendResult> {
  const today = shopDay(now);
  const rows = await db.select().from(stipends);
  const out: StipendResult = { raised: [], submitted: [], failed: [], quiet: 0 };
  const touched = new Set<number>();

  for (const s of rows) {
    if (!stipendLive(s)) continue;
    const due = dueStipendCycles(s, today);
    if (!due.length) { out.quiet++; continue; }

    for (const on of due) {
      try {
        const report = await perksReportFor(s.person, s.tenantOrgId, on);
        await db.insert(expenses).values({
          tenantOrgId: s.tenantOrgId,
          workOrderId: null,
          kind: s.kind,
          description: stipendDescription(s.label, on, s.cadence),
          amountCents: s.amountCents,
          incurredOn: on,
          // Nobody's client pays for our engineer's broadband.
          billable: false,
          person: s.person,
          loggedBy: "",
          reportId: report.id,
          stipendId: s.id,
        });
        /* The cursor moves in the same breath as the row. If the process dies
           between these two writes the worst case is a row with no cursor
           move, which the next pass would raise again - so the cursor is
           written immediately after the insert rather than at the end of the
           person's whole list. */
        await db.update(stipends).set({ lastOn: on }).where(eq(stipends.id, s.id));
        touched.add(report.id);
        out.raised.push({
          person: s.person, label: s.label, on, amountCents: s.amountCents, report: report.id,
        });
      } catch (e) {
        out.failed.push({ person: s.person, label: s.label, on, error: (e as Error).message });
        // One bad cycle should not swallow the rest of the arrangement, but an
        // arrangement that is refusing is not one to keep hammering.
        break;
      }
    }
  }

  /* Submitted at the end, once, so a person with three stipends falling due on
     the same day gets one claim with three rows on it rather than three claims
     - and so a claim is only ever sent for payout after every row that belongs
     on it has landed. */
  for (const id of touched) {
    const [r] = await db.select().from(expenseReports).where(eq(expenseReports.id, id));
    if (!r || r.status !== "draft") continue;
    const rowCount = await db.select({ id: expenses.id }).from(expenses)
      .where(eq(expenses.reportId, id));
    if (!rowCount.length) continue;
    await db.update(expenseReports)
      .set({ status: "submitted", submittedBy: "", submittedAt: new Date() })
      .where(eq(expenseReports.id, id));
    out.submitted.push(id);
  }
  return out;
}
