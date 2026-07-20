import { desc } from "drizzle-orm";
import { redirect } from "next/navigation";
import { db } from "@/db";
import { sheetDiffs } from "@/db/schema";
import { requireStaff } from "@/lib/authz";
import ParityList from "@/components/ParityList";

export const dynamic = "force-dynamic";

export default async function ParityPage() {
  try { await requireStaff(); } catch { redirect("/"); }
  const diffs = await db.select().from(sheetDiffs).orderBy(desc(sheetDiffs.resolved), desc(sheetDiffs.runAt)).limit(100);
  return (
    <div className="container">
      <div className="card">
        <div style={{ fontWeight: 700, fontSize: 15, color: "var(--navy)" }}>Google Sheet parity</div>
        <div className="mut" style={{ fontSize: 13, marginTop: 4 }}>
          Polled hourly, keyed on system ID. Diffs are flagged, never auto-applied - you decide which record wins.
          Accepting a sheet value applies it for notes and priority; stage diffs are resolved by hand on the instrument page.
        </div>
      </div>
      <ParityList diffs={diffs.map((d) => ({ ...d, runAt: d.runAt.toISOString() }))} />
    </div>
  );
}
