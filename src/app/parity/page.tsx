import { asc, desc } from "drizzle-orm";
import { redirect } from "next/navigation";
import { db } from "@/db";
import { sheetDiffs } from "@/db/schema";
import { requireStaff } from "@/lib/authz";
import { getModules } from "@/lib/flags";
import ParityList from "@/components/ParityList";
import { FacetStrip, PageHead, Toolbar } from "@/components/ui";

export const dynamic = "force-dynamic";

export default async function ParityPage({ searchParams }: { searchParams: Promise<{ show?: string }> }) {
  try { await requireStaff(); } catch { redirect("/"); }
  const { show = "" } = await searchParams;
  if (!(await getModules()).sheetSync) redirect("/");
  // Open diffs first, newest first within each group.
  const diffs = await db.select().from(sheetDiffs).orderBy(asc(sheetDiffs.resolved), desc(sheetDiffs.runAt)).limit(100);
  const openCount = diffs.filter((d) => !d.resolved).length;
  const resolved = diffs.length - openCount;
  return (
    <div className="container wide">
      <PageHead
        crumb={<>Operations › <b>Sheet parity</b></>}
        title="Google Sheet parity"
        sub="Polled hourly. Nothing is auto-applied - you decide which record wins."
      />
      <Toolbar facets={
        <FacetStrip facets={[
          { key: "open", label: "Open", count: openCount || undefined, on: show !== "history", href: "/parity" },
          { key: "history", label: "History", count: resolved || undefined, on: show === "history", href: "/parity?show=history" },
        ]} />
      } />
      <ParityList diffs={diffs.map((d) => ({ ...d, runAt: d.runAt.toISOString() }))} showHistory={show === "history"} />
    </div>
  );
}
