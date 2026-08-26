import { inArray } from "drizzle-orm";
import { db } from "@/db";
import { orgs } from "@/db/schema";

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
