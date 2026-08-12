// May this viewer read this stored file? One answer for every consumer - the
// download proxy and the PDF combiner both call this, so they cannot drift.
// Extracted verbatim from /api/files/[id]; the rules are documented there.
import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { attachments, instruments, assets, engagementRecords } from "@/db/schema";
import { currentUser } from "@/lib/authz";
import { canSeeSystem, assetAccess } from "@/lib/tenancy";
import { houseOfRecord } from "@/lib/tenants";
import type { SystemDossier } from "@/lib/dossier";

export async function mayReadAttachment(file: typeof attachments.$inferSelect): Promise<boolean> {
  // Live listing files are public by the seller's explicit choice.
  if (file.showOnListing) {
    if (file.instrumentId !== null) {
      const [inst] = await db.select({ forSale: instruments.forSale }).from(instruments).where(eq(instruments.id, file.instrumentId));
      if (inst?.forSale) return true;
    } else if (file.assetId !== null) {
      const [asset] = await db.select({ forSale: assets.forSale }).from(assets).where(eq(assets.id, file.assetId));
      if (asset?.forSale) return true;
    }
  }

  const user = await currentUser();
  if (!user) return false;
  // Staff of the workspace the file belongs to. Being staff somewhere else is
  // not a key to this file: on a shared instance an id would otherwise be
  // enough to read another service company's documents.
  if (houseOfRecord(user, file.tenantOrgId)) return true;

  if (file.instrumentId !== null && (await canSeeSystem(user, file.instrumentId))) return true;
  if (file.assetId !== null && (await assetAccess(user, file.assetId)).see) return true;

  // A homeless file belongs to a document library, and each organization's
  // shelf is its own. Null org_id is the operator's, which no client reads.
  if (file.instrumentId === null && file.assetId === null) {
    return user.orgId !== null && file.orgId === user.orgId;
  }

  // A frozen engagement record keeps its files readable for the org that
  // holds it - but only files the record actually captured, so nothing
  // uploaded after the revocation rides along.
  if (user.orgId !== null && file.instrumentId !== null) {
    const records = await db.select({ data: engagementRecords.data }).from(engagementRecords)
      .where(and(eq(engagementRecords.orgId, user.orgId), eq(engagementRecords.instrumentId, file.instrumentId)));
    for (const r of records) {
      const d = r.data as SystemDossier;
      if (d?.attachments?.some((a) => a.url === file.url)) return true;
    }
  }
  return false;
}
