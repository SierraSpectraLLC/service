import { NextResponse } from "next/server";
import { asc } from "drizzle-orm";
import { db } from "@/db";
import { partCatalog, partPrices } from "@/db/schema";
import { myTenantOrgId, requireStaff } from "@/lib/authz";
import { forTenant } from "@/lib/tenancy";
import { toCsv } from "@/lib/csv";
import { exportGrid } from "@/lib/partImport";

export const dynamic = "force-dynamic";

/**
 * The parts catalog and every vendor price, in the import's own columns.
 *
 * The round trip is the whole point: download this, fix the forty prices that
 * changed in Excel, upload it back. Same columns out as in - see
 * lib/partImport, which owns the list - so nothing about the shape has to be
 * remembered on either side.
 *
 * Staff of this workspace only, and scoped to it: a parts catalog is a shop's
 * accumulated knowledge of what its numbers mean, and on a multi-operator
 * instance one shop's is not another's to download.
 */
export async function GET() {
  let user;
  try { user = await requireStaff(); } catch { return NextResponse.json({ error: "Staff only" }, { status: 403 }); }
  /* The workspace this staff member WRITES in, not the wider set they may be
     able to read: an export that showed more than the import can match would
     re-import as duplicates, which is not a round trip. See actions.importParts. */
  const tenant = myTenantOrgId(user);

  const [parts, prices] = await Promise.all([
    db.select().from(partCatalog).where(forTenant(partCatalog.tenantOrgId, tenant))
      .orderBy(asc(partCatalog.partNumber)),
    db.select().from(partPrices).where(forTenant(partPrices.tenantOrgId, tenant)),
  ]);

  const csv = toCsv(exportGrid(parts, prices));
  return new NextResponse(csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="parts-catalog.csv"`,
    },
  });
}
