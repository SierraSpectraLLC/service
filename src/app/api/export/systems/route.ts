import { NextResponse } from "next/server";
import { asc, inArray } from "drizzle-orm";
import { db } from "@/db";
import { assets, instruments } from "@/db/schema";
import { currentUser } from "@/lib/authz";
import { visibleSystemIds } from "@/lib/tenancy";
import { composeSystemLabel } from "@/lib/systemLabel";
import { toCsv } from "@/lib/csv";
import { shopToday } from "@/lib/shopday";

export const dynamic = "force-dynamic";

/** The fleet as a spreadsheet, scoped exactly like the dashboard. */
export async function GET() {
  const user = await currentUser();
  if (!user) return new NextResponse(null, { status: 401 });
  const visible = await visibleSystemIds(user);
  const header = ["system id", "system", "client", "category", "location", "stages", "priority", "lead", "archived", "notes"];
  if (visible !== null && visible.length === 0) return csvResponse("systems", [header]);
  const rows = await db.select().from(instruments)
    .where(visible === null ? undefined : inArray(instruments.id, visible))
    .orderBy(asc(instruments.externalId));
  const ids = rows.map((r) => r.id);
  const assetRows = ids.length
    ? await db.select({ instrumentId: assets.instrumentId, kind: assets.kind, model: assets.model, sortOrder: assets.sortOrder })
        .from(assets).where(inArray(assets.instrumentId, ids))
    : [];
  return csvResponse("systems", [
    header,
    ...rows.map((i) => [
      i.externalId,
      composeSystemLabel(assetRows.filter((a) => a.instrumentId === i.id), i.model),
      i.client, i.category, i.location, i.stages.join("; "), i.priority, i.lead,
      i.archived ? "yes" : "", i.notes,
    ]),
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
