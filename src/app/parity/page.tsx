import { asc, desc } from "drizzle-orm";
import { redirect } from "next/navigation";
import { db } from "@/db";
import { sheetDiffs } from "@/db/schema";
import { requireStaff } from "@/lib/authz";
import { getModules } from "@/lib/flags";
import ParityList from "@/components/ParityList";

export const dynamic = "force-dynamic";

export default async function ParityPage() {
  try { await requireStaff(); } catch { redirect("/"); }
  if (!(await getModules()).sheetSync) redirect("/");
  // Open diffs first, newest first within each group.
  const diffs = await db.select().from(sheetDiffs).orderBy(asc(sheetDiffs.resolved), desc(sheetDiffs.runAt)).limit(100);
  const openCount = diffs.filter((d) => !d.resolved).length;
  return (
    <div className="container wide">
      <div className="page-head">
        <h1 className="page-title">Google Sheet parity</h1>
        <span className="mut" style={{ fontSize: 12 }}>
          {openCount ? `${openCount} open mismatch${openCount === 1 ? "" : "es"}` : "everything matches"}
        </span>
        <p className="page-sub">Polled hourly. Nothing is auto-applied - you decide which record wins.</p>
      </div>
      <ParityList diffs={diffs.map((d) => ({ ...d, runAt: d.runAt.toISOString() }))} />
    </div>
  );
}
