import { redirect } from "next/navigation";
import Link from "next/link";
import { asc, desc, eq } from "drizzle-orm";
import { db } from "@/db";
import { instruments } from "@/db/schema";
import { requireUser } from "@/lib/authz";
import { getStageDefs } from "@/lib/stageDefs";
import { shopMonthDay } from "@/lib/shopday";

export const dynamic = "force-dynamic";

export default async function ArchivePage() {
  try { await requireUser(); } catch { redirect("/login"); }

  const [rows, defs] = await Promise.all([
    db.select().from(instruments).where(eq(instruments.archived, true))
      .orderBy(desc(instruments.archivedAt), asc(instruments.externalId)),
    getStageDefs(),
  ]);
  const color = (name: string) => defs.find((d) => d.name === name) ?? { bg: "#EEF1F5", fg: "#475569" };

  return (
    <div className="container" style={{ maxWidth: 720 }}>
      <div className="card">
        <div className="card-title" style={{ marginBottom: 4 }}>Archived systems</div>
        <div className="mut" style={{ fontSize: 12, marginBottom: 10 }}>
          Retired from the active fleet, kept in full. Open one to restore it.
        </div>
        {rows.map((i) => (
          <Link key={i.id} href={`/instruments/${i.id}`} className="row-hover"
            style={{ display: "flex", alignItems: "center", gap: 8, padding: "9px 4px", borderTop: "1px solid var(--line)", textDecoration: "none", color: "inherit", flexWrap: "wrap" }}>
            <span className="mono" style={{ fontSize: 12, fontWeight: 700, color: "var(--navy)" }}>{i.externalId}</span>
            <span style={{ fontSize: 13, flex: "1 1 140px", minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{i.model}</span>
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
        {rows.length === 0 && <div className="mut" style={{ fontSize: 13 }}>Nothing archived.</div>}
      </div>
    </div>
  );
}
