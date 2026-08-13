import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { vocabTerms } from "@/db/schema";
import { currentUser } from "@/lib/authz";
import { viewTenant } from "@/lib/tenancy";

export const dynamic = "force-dynamic";

/**
 * The door to a stock photo on a catalog row.
 *
 * Separate from /api/files because a catalog photo is not a file on a record: it
 * belongs to a model, a module type or a system type, illustrates every unit of
 * that kind, and is nobody's evidence. Routing it through the attachment proxy
 * would have meant giving it an attachment row, which is precisely what it must
 * not have - a stock photo in a client's files, gallery and storage bill.
 *
 * Authorization is the catalog's own: anyone signed in may read the vocabulary
 * of the workspace they work in (see viewTenant), which is the same rule that
 * puts these models in their pickers. Anything else is a plain 404.
 */
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const termId = parseInt(id);
  if (isNaN(termId)) return new NextResponse(null, { status: 404 });

  const u = await currentUser();
  if (!u) return new NextResponse(null, { status: 404 });

  const [term] = await db.select().from(vocabTerms).where(eq(vocabTerms.id, termId));
  if (!term?.photoUrl) return new NextResponse(null, { status: 404 });

  // null = no restriction, which is platform staff and an instance with no
  // operator named yet. Otherwise the term has to be this workspace's.
  const tenant = await viewTenant(u);
  if (tenant !== null && term.tenantOrgId !== tenant) return new NextResponse(null, { status: 404 });

  // Redirect rather than stream: the reader was just authorized to see the
  // bytes, and Blob serves them without tying up a function.
  return NextResponse.redirect(term.photoUrl, 302);
}
