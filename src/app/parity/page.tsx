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
      <div className="card">
        <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
          <div style={{ fontWeight: 700, fontSize: 15, color: "var(--navy)" }}>Google Sheet parity</div>
          <span className="mut" style={{ fontSize: 12 }}>
            {openCount ? `${openCount} open mismatch${openCount === 1 ? "" : "es"}` : "everything matches"}
          </span>
        </div>
        <div className="mut" style={{ fontSize: 13, marginTop: 4 }}>
          Polled hourly. Nothing is auto-applied - you decide which record wins.
        </div>
      </div>
      <ParityList diffs={diffs.map((d) => ({ ...d, runAt: d.runAt.toISOString() }))} />
    </div>
  );
}
