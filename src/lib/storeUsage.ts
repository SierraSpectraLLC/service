// How full an organization's file store actually is. Server-only (it touches
// the database); the arithmetic and the copy live in the pure lib/storage.
import { eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { attachments, assets, instruments, orgs } from "@/db/schema";
import { getBrand } from "@/lib/brand";
import { quotaFor, type Quota } from "@/lib/storage";

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

/**
 * What is IN a store, as one SQL predicate over `a` (attachments) joined to `i`
 * (instruments) and `s` (assets):
 *
 *   - a shelf file - no system, no unit - stamped to this org
 *   - the paperwork on a system it owns
 *   - the paperwork on a unit it owns
 *
 * Shared by the usage total and the file list on purpose. They disagreed once,
 * and the result was a page called "storage" that showed one file while the
 * meter beside it read 195 KB - two answers to the same question is worse than
 * either answer alone.
 *
 * `IS NOT DISTINCT FROM` throughout: the house store is org_id NULL, and
 * `= NULL` would quietly match nothing. Two keys per test, because the operator
 * answers to both of its names (see storeKeys).
 */
function storeWhere(k1: number | null, k2: number | null) {
  return sql`
       (a.instrument_id IS NULL AND a.asset_id IS NULL
        AND (a.org_id IS NOT DISTINCT FROM ${k1}::integer
          OR a.org_id IS NOT DISTINCT FROM ${k2}::integer))
    OR (a.instrument_id IS NOT NULL
        AND (i.owner_org_id IS NOT DISTINCT FROM ${k1}::integer
          OR i.owner_org_id IS NOT DISTINCT FROM ${k2}::integer))
    OR (a.asset_id IS NOT NULL
        AND (s.owner_org_id IS NOT DISTINCT FROM ${k1}::integer
          OR s.owner_org_id IS NOT DISTINCT FROM ${k2}::integer))`;
}

// neon-http returns { rows } from execute; other drivers a bare array.
const firstRow = <T,>(res: unknown): T | undefined =>
  Array.isArray(res) ? (res[0] as T) : (res as { rows?: T[] }).rows?.[0];
const allRows = <T,>(res: unknown): T[] =>
  Array.isArray(res) ? (res as T[]) : ((res as { rows?: T[] }).rows ?? []);

export async function storeUsedBytes(orgId: number | null): Promise<number> {
  // k1/k2 rather than a/b: `a` is the attachments alias inside the SQL.
  const [k1, k2] = await storeKeys(orgId);
  // DISTINCT on the blob URL, so a document filed onto four units is one stored
  // file. Summing over the subquery rather than SUM(DISTINCT size) - two
  // unrelated files that happen to be the same length are still two files.
  const res = await db.execute<{ total: string | number }>(sql`
    SELECT coalesce(sum(t.size), 0) AS total FROM (
      SELECT DISTINCT a.url, a.size
      FROM ${attachments} a
      LEFT JOIN ${instruments} i ON i.id = a.instrument_id
      LEFT JOIN ${assets} s ON s.id = a.asset_id
      WHERE ${storeWhere(k1, k2)}
    ) t
  `);
  return Number(firstRow<{ total: string | number }>(res)?.total ?? 0);
}

/** One row per attachment in the store - a stored file may have several. */
export type StoreFileRow = {
  id: number;
  fileName: string;
  url: string;
  size: number;
  kind: string;
  description: string;
  uploadedBy: string;
  createdAt: Date;
  /** Where it lives. All null = the shelf. */
  instrumentId: number | null;
  externalId: string | null;
  assetId: number | null;
  assetLabel: string | null;
  /** Set only for shelf files: which org's shelf. */
  orgId: number | null;
};

/**
 * Everything in the store, newest first. Capped: a store with ten thousand files
 * needs paging and a search box, not a page that quietly takes ten seconds. The
 * caller is told when it truncated.
 */
export async function storeFiles(orgId: number | null, limit = 500): Promise<StoreFileRow[]> {
  const [k1, k2] = await storeKeys(orgId);
  const res = await db.execute(sql`
    SELECT a.id, a.file_name, a.url, a.size, a.kind, a.description,
           a.uploaded_by, a.created_at, a.org_id,
           a.instrument_id, i.external_id,
           a.asset_id,
           CASE WHEN a.asset_id IS NULL THEN NULL ELSE
             concat_ws(' ', s.kind, nullif(s.model, ''),
                       CASE WHEN nullif(s.serial, '') IS NULL THEN NULL ELSE concat('SN ', s.serial) END)
           END AS asset_label
    FROM ${attachments} a
    LEFT JOIN ${instruments} i ON i.id = a.instrument_id
    LEFT JOIN ${assets} s ON s.id = a.asset_id
    WHERE ${storeWhere(k1, k2)}
    ORDER BY a.created_at DESC, a.id DESC
    LIMIT ${limit}
  `);
  type Raw = {
    id: number; file_name: string; url: string; size: number; kind: string; description: string;
    uploaded_by: string; created_at: string | Date; org_id: number | null;
    instrument_id: number | null; external_id: string | null;
    asset_id: number | null; asset_label: string | null;
  };
  return allRows<Raw>(res).map((r) => ({
    id: r.id, fileName: r.file_name, url: r.url, size: Number(r.size), kind: r.kind,
    description: r.description, uploadedBy: r.uploaded_by,
    createdAt: r.created_at instanceof Date ? r.created_at : new Date(r.created_at),
    instrumentId: r.instrument_id, externalId: r.external_id,
    assetId: r.asset_id, assetLabel: r.asset_label, orgId: r.org_id,
  }));
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
