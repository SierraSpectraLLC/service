import { NextResponse } from "next/server";
import { asc } from "drizzle-orm";
import { db } from "@/db";
import { vocabTerms } from "@/db/schema";
import { myTenantOrgId, requireStaff } from "@/lib/authz";
import { forTenant } from "@/lib/tenancy";
import { toCsv } from "@/lib/csv";
import { exportGrid } from "@/lib/catalogImport";
import { makerNames } from "@/lib/makersData";

export const dynamic = "force-dynamic";

/**
 * Every module in the equipment catalog, and every OEM, in the import's own
 * columns.
 *
 * The round trip is what this is for and what the shop asked for first: export
 * to see the shape, put the new models under it, send it back. Same columns out
 * as in - lib/catalogImport owns the list - so nothing about the shape has to be
 * remembered on either side, and re-importing an untouched export changes
 * nothing at all.
 *
 * Staff of this workspace only, and scoped to it. Deliberately myTenantOrgId
 * rather than the wider set a viewer may READ: an export showing more than the
 * import can merge against would re-import as duplicates of rows this workspace
 * cannot see, which is the opposite of a round trip. Same reasoning, and the
 * same one line, as the parts export.
 */
export async function GET() {
  let user;
  try { user = await requireStaff(); } catch { return NextResponse.json({ error: "Staff only" }, { status: 403 }); }
  const tenant = myTenantOrgId(user);

  const terms = await db.select().from(vocabTerms)
    .where(forTenant(vocabTerms.tenantOrgId, tenant))
    .orderBy(asc(vocabTerms.assetType), asc(vocabTerms.name));

  const csv = toCsv(exportGrid(
    terms.filter((t) => t.kind === "model").map((t) => ({
      moduleType: t.assetType, name: t.name,
      manufacturer: t.manufacturer, categories: t.categories,
    })),
    // The book, not just the defined half: a maker the shop has only ever typed
    // onto a system is still one of its OEMs, and a round trip that dropped it
    // would quietly shrink the book to whoever happens to make a model.
    await makerNames(tenant),
  ));

  return new NextResponse(csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="equipment-catalog.csv"`,
    },
  });
}
