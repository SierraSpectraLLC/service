import { redirect } from "next/navigation";
import Link from "next/link";
import { asc, eq } from "drizzle-orm";
import { db } from "@/db";
import { instruments, stageEvents } from "@/db/schema";
import { requireUser } from "@/lib/authz";
import { getStageDefs } from "@/lib/stageDefs";
import { getSystemLabels } from "@/lib/systemLabel";
import { sinceByStage, completedDurations, ageDays } from "@/lib/stageAges";

export const dynamic = "force-dynamic";

export default async function MetricsPage() {
  let user;
  try { user = await requireUser(); } catch { redirect("/login"); }
  if (user.role !== "owner" && user.role !== "staff") redirect("/");

  const [rows, events, defs] = await Promise.all([
    db.select().from(instruments).where(eq(instruments.archived, false)).orderBy(asc(instruments.priority), asc(instruments.externalId)),
    db.select().from(stageEvents).orderBy(asc(stageEvents.at), asc(stageEvents.id)),
    getStageDefs(),
  ]);

  const since = sinceByStage(events);
  const labels = await getSystemLabels(rows);
  const color = (name: string) => defs.find((d) => d.name === name) ?? { bg: "#EEF1F5", fg: "#475569" };

  // Active systems ranked by how long they've been sitting in their oldest stage.
  const active = rows
    .filter((i) => !i.stages.includes("Shipped"))
    .map((i) => {
      const ages = i.stages.map((s) => ({ stage: s, days: ageDays(since.get(i.id)?.get(s) ?? i.createdAt) }));
      const worst = ages.reduce((a, b) => (b.days > a.days ? b : a), { stage: "", days: -1 });
      return { ...i, ages, worst };
    })
    .sort((a, b) => b.worst.days - a.worst.days);

  // Average completed-stage duration across all recorded transitions.
  const durations = completedDurations(events);
  const avgRows = defs
    .map((d) => {
      const list = durations.get(d.name) ?? [];
      if (!list.length) return null;
      return { stage: d.name, avg: list.reduce((a, b) => a + b, 0) / list.length, n: list.length };
    })
    .filter((x): x is { stage: string; avg: number; n: number } => x !== null);

  return (
    <div className="container" style={{ maxWidth: 720 }}>
      <div className="card">
        <div className="card-title" style={{ marginBottom: 4 }}>Time in stage</div>
        <div className="mut" style={{ fontSize: 12, marginBottom: 10 }}>
          Active systems, longest-parked first. Ages count from when the stage was added
          (systems that predate stage tracking count from their creation).
        </div>
        {active.map((i) => (
          <Link key={i.id} href={`/instruments/${i.id}`} className="row-hover"
            style={{ display: "flex", alignItems: "center", gap: 8, padding: "9px 4px", borderTop: "1px solid var(--line)", textDecoration: "none", color: "inherit", flexWrap: "wrap" }}>
            <span className="mono" style={{ fontSize: 12, fontWeight: 700, color: "var(--navy)" }}>{i.externalId}</span>
            <span style={{ fontSize: 13, flex: "1 1 140px", minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{labels.get(i.id) || i.externalId}</span>
            <span style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
              {i.ages.map(({ stage, days }) => (
                <span key={stage} className="pill" style={{ background: color(stage).bg, color: color(stage).fg }}>
                  {stage}{days >= 1 ? ` · ${days}d` : ""}
                </span>
              ))}
            </span>
          </Link>
        ))}
        {active.length === 0 && <div className="mut" style={{ fontSize: 13 }}>No active systems.</div>}
      </div>

      <div className="card">
        <div className="card-title" style={{ marginBottom: 4 }}>Average days per stage</div>
        <div className="mut" style={{ fontSize: 12, marginBottom: 10 }}>
          From completed stage transitions (a stage added and later removed). Builds up as systems move through the shop.
        </div>
        {avgRows.map((r) => (
          <div key={r.stage} style={{ display: "flex", alignItems: "center", gap: 8, padding: "7px 4px", borderTop: "1px solid var(--line)", fontSize: 13 }}>
            <span className="pill" style={{ background: color(r.stage).bg, color: color(r.stage).fg }}>{r.stage}</span>
            <b style={{ marginLeft: "auto" }}>{r.avg < 1 ? "<1" : Math.round(r.avg)} day{Math.round(r.avg) === 1 ? "" : "s"}</b>
            <span className="mut" style={{ fontSize: 11 }}>({r.n} completion{r.n === 1 ? "" : "s"})</span>
          </div>
        ))}
        {avgRows.length === 0 && <div className="mut" style={{ fontSize: 13 }}>No completed stage transitions recorded yet.</div>}
      </div>
    </div>
  );
}
