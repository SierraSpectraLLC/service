import { NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { attachments, shareLinks, shareLinkFiles } from "@/db/schema";
import { linkUsable } from "@/lib/dropShare";
import { shopToday } from "@/lib/shopday";

export const dynamic = "force-dynamic";

/**
 * One shared file. The token authorizes exactly the ids named at creation -
 * everything else is the same 404 the rest of the file API speaks, because a
 * share link must never become a probe for what else the store holds.
 * Redirects to the blob like /api/files does: authorized means Blob serves
 * the bytes, not a function.
 */
export async function GET(_req: Request, ctx: { params: Promise<{ token: string; id: string }> }) {
  const { token, id } = await ctx.params;
  const fileId = parseInt(id);
  if (isNaN(fileId)) return new NextResponse(null, { status: 404 });
  const [link] = await db.select().from(shareLinks).where(eq(shareLinks.token, token));
  if (!link || !linkUsable(link, shopToday())) return new NextResponse(null, { status: 404 });
  const [named] = await db.select().from(shareLinkFiles)
    .where(and(eq(shareLinkFiles.shareId, link.id), eq(shareLinkFiles.attachmentId, fileId)));
  if (!named) return new NextResponse(null, { status: 404 });
  const [file] = await db.select().from(attachments).where(eq(attachments.id, fileId));
  if (!file) return new NextResponse(null, { status: 404 });
  return NextResponse.redirect(file.url);
}
