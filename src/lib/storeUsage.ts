// How full an organization's file store actually is. Server-only (it touches
// the database); the arithmetic and the copy live in the pure lib/storage.
import { eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { attachments, assets, instruments, orgs } from "@/db/schema";
import { getBrand } from "@/lib/brand";
import { quotaFor, type Quota } from "@/lib/storage";

/**
 * `orgId` null is the operator's own store: the house shelf plus every system
 * and unit nobody else owns. The operator's ceiling is kept on its own org row
 * (brand.operatorOrgId), because the operator IS an org here - it just isn't
 * the one stamped on house-stewarded work.
 */
/**
 * The operator is reachable two ways - as the house (org null, which is what
 * stewarded work carries) and as its own org row, since an operator can own
 * equipment like anyone else. Those are one tenant and must be one store, or it
 * would quietly get twice the ceiling it was sold.
 */
async function storeKeys(orgId: number | null): Promise<[number | null, number | null]> {
  const op = (await getBrand()).operatorOrgId;
  if (orgId === null) return [null, op];
  if (op !== null && orgId === op) return [op, null];
  return [orgId, orgId];
}

export async function storeUsedBytes(orgId: number | null): Promise<number> {
  // k1/k2 rather than a/b: `a` is the attachments alias inside the SQL below.
  const [k1, k2] = await storeKeys(orgId);
  // Hand-written because the shape matters and reads clearly here: DISTINCT on
  // the blob URL, so a library document filed onto four units is one stored
  // file. Summing over the subquery rather than SUM(DISTINCT size) - two
  // unrelated files that happen to be the same length are still two files.
  //
  // `IS NOT DISTINCT FROM` throughout: the house store is org_id NULL, and
  // `= NULL` would quietly match nothing at all. Two keys per test, because the
  // operator answers to both of its names (see storeKeys).
  const rows = await db.execute<{ total: string | number }>(sql`
    SELECT coalesce(sum(t.size), 0) AS total FROM (
      SELECT DISTINCT a.url, a.size
      FROM ${attachments} a
      LEFT JOIN ${instruments} i ON i.id = a.instrument_id
      LEFT JOIN ${assets} s ON s.id = a.asset_id
      WHERE (a.instrument_id IS NULL AND a.asset_id IS NULL
             AND (a.org_id IS NOT DISTINCT FROM ${k1}::integer
               OR a.org_id IS NOT DISTINCT FROM ${k2}::integer))
         OR (a.instrument_id IS NOT NULL
             AND (i.owner_org_id IS NOT DISTINCT FROM ${k1}::integer
               OR i.owner_org_id IS NOT DISTINCT FROM ${k2}::integer))
         OR (a.asset_id IS NOT NULL
             AND (s.owner_org_id IS NOT DISTINCT FROM ${k1}::integer
               OR s.owner_org_id IS NOT DISTINCT FROM ${k2}::integer))
    ) t
  `);
  // neon-http returns { rows } for execute; a bare array from other drivers.
  const first = (Array.isArray(rows) ? rows[0] : (rows as { rows?: { total: string | number }[] }).rows?.[0]);
  return Number(first?.total ?? 0);
}

/** Usage and ceiling together, ready for the meter. */
export async function storeQuota(orgId: number | null): Promise<Quota & { storeName: string }> {
  const [used, limitMb, storeName] = await Promise.all([
    storeUsedBytes(orgId),
    storeLimitMb(orgId),
    storeLabel(orgId),
  ]);
  return { ...quotaFor(used, limitMb), storeName };
}

/** The ceiling in megabytes. 0 = none. */
export async function storeLimitMb(orgId: number | null): Promise<number> {
  const id = orgId ?? (await getBrand()).operatorOrgId;
  if (id === null) return 0; // no operator org configured yet: don't invent a wall
  const [row] = await db.select({ mb: orgs.storageLimitMb }).from(orgs).where(eq(orgs.id, id));
  return row?.mb ?? 0;
}

async function storeLabel(orgId: number | null): Promise<string> {
  if (orgId !== null) {
    const [row] = await db.select({ name: orgs.name }).from(orgs).where(eq(orgs.id, orgId));
    return row?.name ?? "This organization";
  }
  const brand = await getBrand();
  return brand.operatorName || brand.name;
}
