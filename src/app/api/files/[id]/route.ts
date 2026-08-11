import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { attachments } from "@/db/schema";
import { mayReadAttachment } from "@/lib/fileAccess";

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

  if (await mayReadAttachment(file)) return NextResponse.redirect(file.url, 302);
  return new NextResponse(null, { status: 404 });
}
