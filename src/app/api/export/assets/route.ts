import { NextResponse } from "next/server";
import { asc, inArray } from "drizzle-orm";
import { db } from "@/db";
import { assets, instruments } from "@/db/schema";
import { currentUser } from "@/lib/authz";
import { visibleAssetIds } from "@/lib/tenancy";
import { toCsv } from "@/lib/csv";
import { shopToday } from "@/lib/shopday";

export const dynamic = "force-dynamic";

/**
 * The registry as a spreadsheet, scoped exactly like the /assets page. No
 * pricing columns at all - exports must never out-disclose the pages.
 */
export async function GET() {
  const user = await currentUser();
  if (!user) return new NextResponse(null, { status: 401 });
  const visible = await visibleAssetIds(user);
  if (visible !== null && visible.length === 0) {
    return csvResponse("assets", [["kind", "model", "serial", "manufacturer", "status", "owner", "location", "system", "note"]]);
  }
  const rows = await db.select().from(assets)
    .where(visible === null ? undefined : inArray(assets.id, visible))
    .orderBy(asc(assets.kind), asc(assets.model), asc(assets.id));
  const instIds = [...new Set(rows.map((a) => a.instrumentId).filter((x): x is number => x !== null))];
  const insts = instIds.length
    ? await db.select({ id: instruments.id, externalId: instruments.externalId }).from(instruments).where(inArray(instruments.id, instIds))
    : [];
  const ext = new Map(insts.map((i) => [i.id, i.externalId]));
  return csvResponse("assets", [
    ["kind", "model", "serial", "manufacturer", "status", "owner", "location", "system", "note"],
    ...rows.map((a) => [a.kind, a.model, a.serial, a.manufacturer, a.status, a.owner, a.location,
      a.instrumentId !== null ? ext.get(a.instrumentId) ?? "" : "", a.note]),
  ]);
}

function csvResponse(name: string, rows: (string | number | null | undefined)[][]) {
  return new NextResponse(toCsv(rows), {
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="${name}-${shopToday()}.csv"`,
    },
  });
}
