// What the shop has eaten for a client, per client.
//
// A claim filed against a client with no job open (expense_reports.org_id, see
// the schema) is spend nobody will invoice: a part bought for a partner on a
// handshake, a courier run for an account the shop is courting. Each claim
// records it; nothing has ever added it up. Costing counts a job's expenses
// against the job's revenue, and these claims have no job to count under, so
// the running total for "what LabZen has cost us this year" was a question
// with no page to answer it. This is that rollup.
//
// Two rules, both the ones the rest of costing already uses:
//
//   A returned claim is refused money and counts for nothing. A draft counts,
//   because the money left the building when the part was bought, not when
//   the claim was submitted; the desk is where a draft that should not exist
//   gets caught, not the ledger.
//
//   A row is placed by the day it was spent, like a part is placed by the day
//   it was fitted. A claim's submission date is when somebody got round to the
//   paperwork, and "this quarter" on a costing page means the money, not the
//   paperwork. A row with no date at all falls back to the claim's submission
//   day rather than vanishing.
//
// Pure. Callers hand in the rows.

import { inWindow } from "@/lib/costing";

export type AbsorbedReport = {
  id: number;
  orgId: number;
  orgName: string;
  title: string;
  person: string;
  status: string;
  /** YYYY-MM-DD; where an undated row lands. */
  submittedOn: string;
};

export type AbsorbedExpense = {
  reportId: number;
  amountCents: number;
  /** YYYY-MM-DD, or blank. */
  incurredOn: string;
};

export type AbsorbedClaim = {
  id: number;
  title: string;
  person: string;
  status: string;
  /** The latest day any of its rows was spent. */
  on: string;
  amountCents: number;
};

export type AbsorbedClient = {
  orgId: number;
  orgName: string;
  totalCents: number;
  /** Newest first. */
  claims: AbsorbedClaim[];
};

export type AbsorbedBoard = {
  /** Biggest bill first. */
  rows: AbsorbedClient[];
  totalCents: number;
};

export function absorbedSpend(
  reports: AbsorbedReport[],
  rows: AbsorbedExpense[],
  today: string,
  windowDays: number,
): AbsorbedBoard {
  const byOrg = new Map<number, AbsorbedClient>();

  for (const r of reports) {
    if (r.status === "returned") continue;
    let cents = 0;
    let on = "";
    for (const e of rows) {
      if (e.reportId !== r.id) continue;
      const day = e.incurredOn || r.submittedOn;
      if (!inWindow(day, today, windowDays)) continue;
      cents += e.amountCents;
      if (day > on) on = day;
    }
    if (cents === 0) continue;

    const client = byOrg.get(r.orgId) ?? {
      orgId: r.orgId, orgName: r.orgName, totalCents: 0, claims: [],
    };
    client.totalCents += cents;
    client.claims.push({
      id: r.id, title: r.title, person: r.person, status: r.status, on, amountCents: cents,
    });
    byOrg.set(r.orgId, client);
  }

  const out = [...byOrg.values()].map((c) => ({
    ...c, claims: [...c.claims].sort((a, b) => b.on.localeCompare(a.on) || b.id - a.id),
  })).sort((a, b) => b.totalCents - a.totalCents || a.orgName.localeCompare(b.orgName));

  return { rows: out, totalCents: out.reduce((n, c) => n + c.totalCents, 0) };
}
