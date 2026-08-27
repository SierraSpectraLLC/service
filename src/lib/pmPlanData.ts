// The queries behind a PM plan: whose systems, what they are owed, what landed.
//
// One reader for both surfaces - the client's own plan tab and the shop-wide
// coverage board - because the two would otherwise ask the same question two
// ways and disagree about a number somebody is about to say to a client. The
// RULES are lib/pmPlan and stay pure; this is only the fetching.

import { and, eq, gte, inArray, isNotNull, ne } from "drizzle-orm";
import { db } from "@/db";
import { instruments, pmPlans, tasks } from "@/db/schema";
import { forTenant } from "@/lib/tenancy";
import { shopDay } from "@/lib/shopday";
import { getSystemLabels } from "@/lib/systemLabel";
import { pmCoverage, planFor, type Coverage, type PlanRow } from "@/lib/pmPlan";

/**
 * What counts as a preventive visit delivered.
 *
 * 'pm' is a schedule's own generated work, including the backfills an engineer
 * files after the fact. 'pm_request' is the client asking for upkeep, and it
 * counts too: it deliberately carries no schedule so that completing it does
 * not move a contract's calendar (see lib/pmRequest), but a preventive visit we
 * actually made is a preventive visit delivered, and refusing to count it would
 * have a client who called for their PM instead of waiting for it reading
 * "behind" for the year.
 *
 * Corrective work is not here. An emergency call-out is not a PM however much
 * of the same list got done on the day.
 */
export const PM_ORIGINS = ["pm", "pm_request"] as const;

export type SystemCoverage = {
  instrumentId: number;
  externalId: string;
  label: string;
  category: string;
  coverage: Coverage;
};

const asPlanRow = (r: typeof pmPlans.$inferSelect): PlanRow =>
  ({ id: r.id, orgId: r.orgId, category: r.category, perYear: r.perYear, note: r.note });

/** This workspace's plans, for one client or for every client it has. */
export async function plansFor(
  tenantOrgId: number | null,
  orgId?: number,
): Promise<PlanRow[]> {
  const where = orgId === undefined
    ? forTenant(pmPlans.tenantOrgId, tenantOrgId)
    : and(eq(pmPlans.orgId, orgId), forTenant(pmPlans.tenantOrgId, tenantOrgId));
  return (await db.select().from(pmPlans).where(where)).map(asPlanRow);
}

/**
 * The days preventive work was completed on each of these systems this year.
 *
 * Keyed by system, valued as a SET OF DAYS rather than a count, because the
 * unit of delivery is the day - three schedules closed on one visit is one PM.
 * See the header of lib/pmPlan, which is where that decision is argued.
 *
 * `completedAt` is a timestamp and the plan year is a shop-time year, so the
 * fetch is deliberately loose at the boundary - everything from the start of
 * the year comes back and lib/pmPlan drops what falls outside once the days
 * have been converted. Filtering by timestamp in SQL would have put a January
 * 1st visit in the wrong year for any shop not on UTC.
 */
export async function pmDaysByInstrument(
  instrumentIds: number[],
  year: number,
): Promise<Map<number, string[]>> {
  const out = new Map<number, string[]>();
  if (!instrumentIds.length) return out;
  const rows = await db.select({ instrumentId: tasks.instrumentId, completedAt: tasks.completedAt })
    .from(tasks)
    .where(and(
      inArray(tasks.instrumentId, instrumentIds),
      inArray(tasks.origin, [...PM_ORIGINS]),
      eq(tasks.state, "Done"),
      isNotNull(tasks.completedAt),
      gte(tasks.completedAt, new Date(Date.UTC(year - 1, 11, 30))),
    ));
  for (const r of rows) {
    if (r.instrumentId === null || r.completedAt === null) continue;
    const list = out.get(r.instrumentId) ?? [];
    list.push(shopDay(r.completedAt));
    out.set(r.instrumentId, list);
  }
  return out;
}

/**
 * Every system this client owns, against the plan that governs it.
 *
 * Archived systems are out. A retired unit that never had its second PM is not
 * a debt, and leaving it on the board is how a coverage page becomes something
 * nobody reads.
 */
export async function coverageForOrg(input: {
  orgId: number;
  tenantOrgId: number | null;
  today: string;
}): Promise<{ plans: PlanRow[]; rows: SystemCoverage[] }> {
  const [plans, systems] = await Promise.all([
    plansFor(input.tenantOrgId, input.orgId),
    db.select().from(instruments).where(and(
      eq(instruments.ownerOrgId, input.orgId),
      eq(instruments.archived, false),
      forTenant(instruments.tenantOrgId, input.tenantOrgId),
    )),
  ]);
  const labels = await getSystemLabels(systems);
  const days = await pmDaysByInstrument(systems.map((s) => s.id), Number(input.today.slice(0, 4)));

  const rows = systems.map((s) => ({
    instrumentId: s.id,
    externalId: s.externalId,
    label: labels.get(s.id) ?? s.model,
    category: s.category,
    coverage: pmCoverage({
      plan: planFor(plans, s.category),
      doneDays: days.get(s.id) ?? [],
      today: input.today,
    }),
  }));
  // Behind first, then the ones with a plan, then the rest - the board is read
  // top-down by somebody deciding what this week is for.
  const rank = (c: Coverage) =>
    c.state === "behind" ? 0 : c.state === "on_track" ? 1 : c.state === "complete" ? 2 : 3;
  rows.sort((a, b) =>
    rank(a.coverage) - rank(b.coverage)
    || a.category.localeCompare(b.category)
    || a.externalId.localeCompare(b.externalId));
  return { plans, rows };
}

/** The categories actually present in a client's fleet, for the plan form. */
export async function fleetCategories(
  orgId: number,
  tenantOrgId: number | null,
): Promise<string[]> {
  const rows = await db.select({ category: instruments.category }).from(instruments)
    .where(and(
      eq(instruments.ownerOrgId, orgId),
      eq(instruments.archived, false),
      ne(instruments.category, ""),
      forTenant(instruments.tenantOrgId, tenantOrgId),
    ));
  return [...new Set(rows.map((r) => r.category.trim()).filter(Boolean))].sort();
}

export type ClientCoverage = {
  orgId: number;
  orgName: string;
  rows: SystemCoverage[];
  plans: PlanRow[];
};

/**
 * Every client in the workspace, with their plan and where each of their
 * systems stands - the question the maintenance calendar cannot answer.
 *
 * The calendar says what is due next; this says whether the year's promise is
 * being kept, which is a different question with a different audience. A
 * schedule can be perfectly on cadence while the client is owed two visits
 * nobody has booked, and a client can have no schedules at all and still be
 * owed a PM.
 *
 * Four queries flat rather than one per client. A shop with sixty clients would
 * otherwise open sixty connections to render one page, and the grouping is
 * cheaper in memory than in the database here because every row is wanted.
 */
export async function coverageBoard(input: {
  tenantOrgId: number | null;
  today: string;
  /** Client orgs the caller may see, already scoped. Their ids gate the fetch. */
  orgs: { id: number; name: string }[];
}): Promise<ClientCoverage[]> {
  if (!input.orgs.length) return [];
  const ids = input.orgs.map((o) => o.id);
  const [plans, systems] = await Promise.all([
    plansFor(input.tenantOrgId),
    db.select().from(instruments).where(and(
      inArray(instruments.ownerOrgId, ids),
      eq(instruments.archived, false),
      forTenant(instruments.tenantOrgId, input.tenantOrgId),
    )),
  ]);
  const labels = await getSystemLabels(systems);
  const days = await pmDaysByInstrument(systems.map((s) => s.id), Number(input.today.slice(0, 4)));

  const rank = (c: Coverage) =>
    c.state === "behind" ? 0 : c.state === "on_track" ? 1 : c.state === "complete" ? 2 : 3;

  return input.orgs
    .map((o) => {
      const mine = plans.filter((p) => p.orgId === o.id);
      const rows = systems
        .filter((s) => s.ownerOrgId === o.id)
        .map((s) => ({
          instrumentId: s.id,
          externalId: s.externalId,
          label: labels.get(s.id) ?? s.model,
          category: s.category,
          coverage: pmCoverage({
            plan: planFor(mine, s.category),
            doneDays: days.get(s.id) ?? [],
            today: input.today,
          }),
        }))
        .sort((a, b) =>
          rank(a.coverage) - rank(b.coverage)
          || a.category.localeCompare(b.category)
          || a.externalId.localeCompare(b.externalId));
      return { orgId: o.id, orgName: o.name, rows, plans: mine };
    })
    // A client with no plan AND no systems is not on this board at all - it is
    // a board about maintenance, and they have nothing to maintain.
    .filter((c) => c.rows.length > 0 || c.plans.length > 0);
}

/**
 * One system against its client's plan, for the system's own page.
 *
 * The same reader as the two boards - a third way of answering "has this had
 * its PMs" would be a third number to disagree with. A system nobody owns has
 * no plan: an entitlement is something promised to somebody, and the house's
 * own bench units are promised to nobody.
 */
export async function coverageForSystem(input: {
  instrumentId: number;
  ownerOrgId: number | null;
  category: string;
  tenantOrgId: number | null;
  today: string;
}): Promise<{ coverage: Coverage; plan: PlanRow | null }> {
  if (input.ownerOrgId === null) {
    return {
      plan: null,
      coverage: pmCoverage({ plan: null, doneDays: [], today: input.today }),
    };
  }
  const plans = await plansFor(input.tenantOrgId, input.ownerOrgId);
  const plan = planFor(plans, input.category);
  const days = await pmDaysByInstrument([input.instrumentId], Number(input.today.slice(0, 4)));
  return {
    plan,
    coverage: pmCoverage({ plan, doneDays: days.get(input.instrumentId) ?? [], today: input.today }),
  };
}
