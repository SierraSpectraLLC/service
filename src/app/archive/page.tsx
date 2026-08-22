import { redirect } from "next/navigation";
import Link from "next/link";
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { db } from "@/db";
import { instruments } from "@/db/schema";
import { requireUser } from "@/lib/authz";
import { viewTenant, visibleSystemIds } from "@/lib/tenancy";
import { getStageDefs } from "@/lib/stageDefs";
import { getSystemLabels } from "@/lib/systemLabel";
import { shopMonthDay } from "@/lib/shopday";

export const dynamic = "force-dynamic";

export default async function ArchivePage() {
  let user;
  try { user = await requireUser(); } catch { redirect("/login"); }
  // This page was reachable by URL for anyone signed in; now it shows only
  // what the viewer may see.
  const visible = await visibleSystemIds(user);

  const [rows, defs] = await Promise.all([
    db.select().from(instruments).where(and(eq(instruments.archived, true),
      visible === null ? undefined : visible.length ? inArray(instruments.id, visible) : sql`false`))
      .orderBy(desc(instruments.archivedAt), asc(instruments.externalId)),
    getStageDefs(await viewTenant(user)),
  ]);
  const labels = await getSystemLabels(rows);
  const color = (name: string) => defs.find((d) => d.name === name) ?? { bg: "#EEF1F5", fg: "#475569" };

  return (
    <div className="container page">
      <div className="crumb">Operations › <b>Archived</b></div>
      <div className="page-head">
        <h1 className="page-title">Archived systems</h1>
        <p className="page-sub">Retired from the active fleet, kept in full. Open one to restore it.</p>
      </div>
      <div className="card">
        {rows.map((i) => (
          <Link key={i.id} href={`/instruments/${i.id}`} className="row-hover"
            style={{ display: "flex", alignItems: "center", gap: 8, padding: "9px 4px", borderTop: "1px solid var(--line)", textDecoration: "none", color: "inherit", flexWrap: "wrap" }}>
            <span className="mono" style={{ fontSize: 12, fontWeight: 700, color: "var(--navy)" }}>{i.externalId}</span>
            <span style={{ fontSize: 13, flex: "1 1 140px", minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{labels.get(i.id) || <span className="mut">No assets listed</span>}</span>
            <span style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
              {i.stages.map((s) => (
                <span key={s} className="pill" style={{ background: color(s).bg, color: color(s).fg }}>{s}</span>
              ))}
            </span>
            <span className="mut" style={{ fontSize: 11 }}>
              {i.client}{i.archivedAt ? ` · archived ${shopMonthDay(i.archivedAt)}` : ""}{i.archivedBy ? ` by ${i.archivedBy}` : ""}
            </span>
          </Link>
        ))}
        {rows.length === 0 && (
          <div className="empty">
            <b>Nothing archived</b>
            Systems retired from the dashboard land here, kept in full.
          </div>
        )}
      </div>
    </div>
  );
}
