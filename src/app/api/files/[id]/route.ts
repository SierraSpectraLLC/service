import { NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { attachments, instruments, assets, engagementRecords } from "@/db/schema";
import { currentUser } from "@/lib/authz";
import { isHouse, canSeeSystem, assetAccess } from "@/lib/tenancy";
import type { SystemDossier } from "@/lib/dossier";

export const dynamic = "force-dynamic";

/**
 * The only door to a stored file. Blob URLs are public-but-unguessable, which
 * was the v1 posture; from here on the app never renders one - every download
 * goes through this route and the same authorization the pages use:
 *
 *  - platform staff: everything;
 *  - a signed-in org: files on systems/assets it can see (lib/tenancy), plus
 *    files captured in an engagement record it holds (their frozen copy keeps
 *    working after revocation, but only for what the record actually froze);
 *  - anyone, signed in or not: files a seller marked "show on listing" while
 *    the listing is live.
 *
 * Grants respond with a redirect to the blob rather than streaming - the
 * recipient was just authorized to read the bytes, and Blob serves them
 * without tying up a function. Everything else is a plain 404: the file's
 * existence is itself information.
 */
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const fileId = parseInt(id);
  if (isNaN(fileId)) return new NextResponse(null, { status: 404 });
  const [file] = await db.select().from(attachments).where(eq(attachments.id, fileId));
  if (!file) return new NextResponse(null, { status: 404 });

  if (await mayRead(file)) return NextResponse.redirect(file.url, 302);
  return new NextResponse(null, { status: 404 });
}

async function mayRead(file: typeof attachments.$inferSelect): Promise<boolean> {
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
  if (isHouse(user.role)) return true;

  if (file.instrumentId !== null && (await canSeeSystem(user, file.instrumentId))) return true;
  if (file.assetId !== null && (await assetAccess(user, file.assetId)).see) return true;

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
