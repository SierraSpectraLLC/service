// The reads behind the award ladder. The rules are lib/award and stay pure.

import { and, asc, eq, inArray } from "drizzle-orm";
import { db } from "@/db";
import { agreements, awards, orgs } from "@/db/schema";
import { forTenant } from "@/lib/tenancy";
import type { PeriodLike } from "@/lib/award";

export type AwardPeriod = PeriodLike & {
  id: number;
  number: string;
  title: string;
  billNextOn: string;
};

export type AwardWithPeriods = {
  id: number;
  /** Whose workspace. The weekly sweep needs it to know which house to tell. */
  tenantOrgId: number | null;
  orgId: number;
  orgName: string;
  number: string;
  title: string;
  awardedOn: string;
  optionNoticeDays: number;
  note: string;
  periods: AwardPeriod[];
};

/**
 * Every award in a workspace, each with its periods in order.
 *
 * Two reads and a group, rather than a join per award: a shop has a handful of
 * these and the page wants them all at once. An award whose periods have all
 * been deleted still comes back - with none - because an empty ladder is a
 * thing somebody needs to see and fix, not a row to hide.
 */
export async function awardsFor(tenantOrgId: number | null): Promise<AwardWithPeriods[]> {
  const rows = await db.select().from(awards)
    .where(forTenant(awards.tenantOrgId, tenantOrgId))
    .orderBy(asc(awards.awardedOn), asc(awards.id));
  if (!rows.length) return [];

  const [periods, orgRows] = await Promise.all([
    db.select().from(agreements)
      .where(inArray(agreements.awardId, rows.map((a) => a.id)))
      .orderBy(asc(agreements.periodIndex), asc(agreements.id)),
    db.select({ id: orgs.id, name: orgs.name }).from(orgs)
      .where(inArray(orgs.id, [...new Set(rows.map((a) => a.orgId))])),
  ]);
  const nameOf = new Map(orgRows.map((o) => [o.id, o.name]));

  return rows.map((a) => ({
    id: a.id, tenantOrgId: a.tenantOrgId, orgId: a.orgId,
    orgName: nameOf.get(a.orgId) ?? "an organization",
    number: a.number, title: a.title, awardedOn: a.awardedOn,
    optionNoticeDays: a.optionNoticeDays, note: a.note,
    periods: periods.filter((p) => p.awardId === a.id).map((p) => ({
      id: p.id, number: p.number, title: p.title, periodIndex: p.periodIndex,
      status: p.status, startsOn: p.startsOn, endsOn: p.endsOn,
      renewNoticeDays: p.renewNoticeDays, billAmountCents: p.billAmountCents,
      valueCents: p.valueCents, billNextOn: p.billNextOn,
    })),
  }));
}

/** Is this quote already an award? The quote page asks before offering to make one. */
export async function awardOfQuote(quoteId: number): Promise<{ id: number; number: string } | null> {
  const [row] = await db.select({ id: awards.id, number: awards.number })
    .from(awards).where(eq(awards.quoteId, quoteId));
  return row ?? null;
}

/** Does this quote carry coverage periods to award? */
export async function quoteHasPeriods(quoteId: number): Promise<number> {
  const { quoteLines } = await import("@/db/schema");
  const rows = await db.select({ id: quoteLines.id }).from(quoteLines)
    .where(and(eq(quoteLines.quoteId, quoteId), eq(quoteLines.kind, "retainer")));
  return rows.length;
}
