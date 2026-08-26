import { and, eq, inArray } from "drizzle-orm";
import { db } from "@/db";
import { agreements, orgs } from "@/db/schema";
import { advisoryByCoverage, coverageOf, type CoverageAgreement } from "@/lib/coverage";

/**
 * The companies named as service providers on a set of agreements.
 *
 * A third-party provider is an orgs row with no users and no workspace, so
 * there is nowhere else its name lives - and four pages need to resolve the
 * same handful of ids. One read, keyed by id; ours (a null provider) is not in
 * here at all, because null is a statement rather than a missing name.
 */
export async function providerNames(
  rows: { providerOrgId: number | null }[],
): Promise<Map<number, string>> {
  const ids = [...new Set(rows.map((r) => r.providerOrgId).filter((x): x is number => x !== null))];
  if (ids.length === 0) return new Map();
  const found = await db.select({ id: orgs.id, name: orgs.name }).from(orgs)
    .where(inArray(orgs.id, ids))
    .catch(() => []);
  return new Map(found.map((o) => [o.id, o.name]));
}

/** The name to show, or null when it is ours. */
export const providerNameOf = (
  providerOrgId: number | null, names: Map<number, string>,
): string | null =>
  providerOrgId === null ? null : names.get(providerOrgId) ?? "another company";


/**
 * Which of these systems somebody else is under contract to maintain, and who.
 *
 * The batch form of coverageOf, for the two places that act on it rather than
 * display it: the maintenance posture on a record, and the job that turns due
 * dates into tasks. Both need the answer for many systems at once and neither
 * should be re-deriving the rule.
 *
 * Every contract for the owning organizations is read, not only third-party
 * ones - a system we cover AND the manufacturer covers is ours to maintain,
 * and fetching only theirs would silently hand our own work away.
 */
export async function coveredElsewhere(
  systems: { id: number; ownerOrgId: number | null }[],
  today: string,
  operatorName: string,
): Promise<Map<number, string>> {
  const orgIds = [...new Set(systems.map((s) => s.ownerOrgId).filter((x): x is number => x !== null))];
  const out = new Map<number, string>();
  if (orgIds.length === 0) return out;

  const rows = await db.select({
    id: agreements.id, title: agreements.title, number: agreements.number,
    status: agreements.status, startsOn: agreements.startsOn, endsOn: agreements.endsOn,
    renewNoticeDays: agreements.renewNoticeDays, instrumentIds: agreements.instrumentIds,
    providerOrgId: agreements.providerOrgId, orgId: agreements.orgId,
  }).from(agreements)
    .where(and(inArray(agreements.orgId, orgIds), eq(agreements.kind, "contract")))
    .catch(() => []);
  if (rows.length === 0) return out;

  const names = await providerNames(rows);
  for (const s of systems) {
    if (s.ownerOrgId === null) continue;
    const theirs: CoverageAgreement[] = rows
      .filter((r) => r.orgId === s.ownerOrgId)
      .map((r) => ({ ...r, providerName: providerNameOf(r.providerOrgId, names) }));
    const c = coverageOf(s.id, theirs, today, operatorName);
    if (advisoryByCoverage(c.state)) out.set(s.id, c.provider);
  }
  return out;
}
