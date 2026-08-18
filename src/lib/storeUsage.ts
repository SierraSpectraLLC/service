// How full an organization's file store actually is. Server-only (it touches
// the database); the arithmetic and the copy live in the pure lib/storage.
import { desc, eq, inArray, or, sql } from "drizzle-orm";
import { db } from "@/db";
import { attachments, assets, instruments, orgs } from "@/db/schema";
import { getBrand } from "@/lib/brand";
import { quotaFor, type Quota } from "@/lib/storage";
import type { SessionUser } from "@/lib/authz";
import { isHouse } from "@/lib/houseRole";
import { visibleAssetIds, visibleSystemIds } from "@/lib/tenancy";

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
  /** How the photo sits in its tile, for the ones that are photos. See lib/photoFrame. */
  framing: string;
  /** Which folder holds it, for a loose file. Null = the root. */
  folderId: number | null;
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
           a.uploaded_by, a.created_at, a.org_id, a.framing, a.folder_id,
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
    uploaded_by: string; created_at: string | Date; org_id: number | null; framing: string | null;
    folder_id: number | null;
    instrument_id: number | null; external_id: string | null;
    asset_id: number | null; asset_label: string | null;
  };
  return allRows<Raw>(res).map((r) => ({
    id: r.id, fileName: r.file_name, url: r.url, size: Number(r.size), kind: r.kind,
    description: r.description, uploadedBy: r.uploaded_by, framing: r.framing ?? "",
    createdAt: r.created_at instanceof Date ? r.created_at : new Date(r.created_at),
    instrumentId: r.instrument_id, externalId: r.external_id,
    assetId: r.asset_id, assetLabel: r.asset_label, orgId: r.org_id,
    folderId: r.folder_id ?? null,
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

/**
 * Files this person can READ that are in somebody else's store.
 *
 * This is the other half of the answer to "why does the PDF studio list files my
 * storage page doesn't?". The studio offers everything you can read; the store
 * lists what you own. A system shared with you - or one you sold and stayed on as
 * a viewer - is readable and is NOT yours, so its paperwork appears in one place
 * and not the other. Both were right and the page said neither, which reads as a
 * bug. So: list them, plainly marked as not counting.
 *
 * House users get nothing here: they can read everything, so "readable but not
 * mine" would be every other organization's files, which is not a useful page.
 */
export async function visibleNotOwnedFiles(user: SessionUser, limit = 200): Promise<StoreFileRow[]> {
  if (user.orgId === null || isHouse(user.role)) return [];
  const [sysIds, assetIds] = await Promise.all([visibleSystemIds(user), visibleAssetIds(user)]);
  const reach = or(
    sysIds === null ? undefined : sysIds.length ? inArray(attachments.instrumentId, sysIds) : sql`false`,
    assetIds === null ? undefined : assetIds.length ? inArray(attachments.assetId, assetIds) : sql`false`,
  );
  const rows = await db.select({
    id: attachments.id, fileName: attachments.fileName, url: attachments.url, size: attachments.size,
    kind: attachments.kind, description: attachments.description, uploadedBy: attachments.uploadedBy,
    createdAt: attachments.createdAt, orgId: attachments.orgId, framing: attachments.framing,
    instrumentId: attachments.instrumentId, externalId: instruments.externalId,
    assetId: attachments.assetId,
    assetKind: assets.kind, assetModel: assets.model, assetSerial: assets.serial,
    systemOwner: instruments.ownerOrgId, assetOwner: assets.ownerOrgId,
  }).from(attachments)
    .leftJoin(instruments, eq(instruments.id, attachments.instrumentId))
    .leftJoin(assets, eq(assets.id, attachments.assetId))
    .where(reach)
    .orderBy(desc(attachments.createdAt))
    .limit(limit)
    .catch(() => []);

  return rows
    // Anything already in their own store belongs to the list above, not here.
    .filter((r) => {
      const owner = r.instrumentId !== null ? r.systemOwner : r.assetId !== null ? r.assetOwner : null;
      return (owner ?? null) !== user.orgId;
    })
    .map((r) => ({
      id: r.id, fileName: r.fileName, url: r.url, size: r.size, kind: r.kind,
      description: r.description, uploadedBy: r.uploadedBy, createdAt: r.createdAt, framing: r.framing,
      instrumentId: r.instrumentId, externalId: r.externalId,
      assetId: r.assetId,
      assetLabel: r.assetId === null ? null
        : [r.assetKind, r.assetModel, r.assetSerial ? `SN ${r.assetSerial}` : ""].filter(Boolean).join(" "),
      orgId: r.orgId,
      // Somebody else's filing, not yours to browse - these are listed flat.
      folderId: null,
    }));
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
