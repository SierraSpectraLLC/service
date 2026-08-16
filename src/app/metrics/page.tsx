import { redirect } from "next/navigation";
import Link from "next/link";
import { and, asc, eq, gte } from "drizzle-orm";
import { db } from "@/db";
import { instruments, stageEvents, tasks, timeEntries, parts, queueEvents } from "@/db/schema";
import { requireUser } from "@/lib/authz";
import { getStageDefs } from "@/lib/stageDefs";
import { getSystemLabels } from "@/lib/systemLabel";
import { sinceByStage, completedDurations, ageDays } from "@/lib/stageAges";
import { pmCompliance, shippedTurnaround, minutesBy, spendBy } from "@/lib/reports";
import { formatHours } from "@/lib/hours";
import { formatCents } from "@/lib/money";
import { addDays } from "@/lib/pm";
import { shopToday } from "@/lib/shopday";
import { forTenant, readTenant, viewTenant } from "@/lib/tenancy";

export const dynamic = "force-dynamic";

const WINDOWS = [30, 90] as const;

export default async function MetricsPage({ searchParams }: { searchParams: Promise<{ days?: string }> }) {
  let user;
  try { user = await requireUser(); } catch { redirect("/login"); }
  if (user.role !== "owner" && user.role !== "staff") redirect("/");
  const { days: daysParam } = await searchParams;
  const days = daysParam === "90" ? 90 : 30;
  const today = shopToday();
  const windowStartIso = addDays(today, -days);
  const windowStart = new Date(`${windowStartIso}T00:00:00`);
  const tz = process.env.SHOP_TZ || "America/Los_Angeles";
  const dayOf = (d: Date) => d.toLocaleDateString("en-CA", { timeZone: tz });

  const [rows, events, defs, allInsts, pmTasks, timeRows, partRows] = await Promise.all([
    db.select().from(instruments)
      .where(and(eq(instruments.archived, false), forTenant(instruments.tenantOrgId, readTenant(user))))
      .orderBy(asc(instruments.priority), asc(instruments.externalId)),
    db.select().from(stageEvents).orderBy(asc(stageEvents.at), asc(stageEvents.id)),
    getStageDefs(await viewTenant(user)),
    // Archived systems included: shipped and retired work still counts in a window.
    db.select({ id: instruments.id, externalId: instruments.externalId, client: instruments.client, createdAt: instruments.createdAt })
      .from(instruments).where(forTenant(instruments.tenantOrgId, readTenant(user))),
    db.select({ origin: tasks.origin, dueDate: tasks.dueDate, completedAt: tasks.completedAt, state: tasks.state })
      .from(tasks).where(and(eq(tasks.origin, "pm"), forTenant(tasks.tenantOrgId, readTenant(user)))),
    db.select().from(timeEntries)
      .where(and(gte(timeEntries.date, windowStartIso), forTenant(timeEntries.tenantOrgId, readTenant(user)))),
    db.select({ instrumentId: parts.instrumentId, costCents: parts.costCents, createdAt: parts.createdAt })
      .from(parts).where(gte(parts.createdAt, windowStart)),
  ]);

  // ---- window reports (pure math in lib/reports) ----
  const pm = pmCompliance(pmTasks, windowStartIso, today, dayOf);
  const pmTotal = pm.onTime + pm.late + pm.openOverdue + pm.openNotDue;
  // Queue moves, so turnaround can separate the days we could have shortened
  // from the days a system sat in someone else's queue.
  const queueLegs = new Map<number, { toOrgId: number | null; at: Date }[]>();
  for (const q of await db.select({ instrumentId: queueEvents.instrumentId, toOrgId: queueEvents.toOrgId, at: queueEvents.at }).from(queueEvents)) {
    const list = queueLegs.get(q.instrumentId);
    if (list) list.push(q); else queueLegs.set(q.instrumentId, [q]);
  }
  const turnaround = shippedTurnaround(allInsts, events, windowStart, queueLegs);
  const avg = (ns: number[]) => (ns.length ? Math.round(ns.reduce((a, b) => a + b, 0) / ns.length) : 0);
  const avgTurn = avg(turnaround.map((t) => t.gross));
  const avgNet = avg(turnaround.map((t) => t.net));
  const parkedTotal = turnaround.reduce((n, t) => n + t.parked, 0);
  const clientOf = new Map(allInsts.map((i) => [i.id, i.client || "(no client)"]));
  const hoursByClient = [...minutesBy(
    timeRows.map((t) => ({ minutes: t.minutes, date: t.date, key: t.instrumentId !== null ? clientOf.get(t.instrumentId) ?? "(no client)" : "Shelf work" })),
    windowStartIso,
  ).entries()].sort((a, b) => b[1] - a[1]);
  const hoursByPerson = [...minutesBy(
    timeRows.map((t) => ({ minutes: t.minutes, date: t.date, key: t.person || "(unnamed)" })),
    windowStartIso,
  ).entries()].sort((a, b) => b[1] - a[1]);
  const spend = [...spendBy(
    partRows.map((p) => ({ costCents: p.costCents, createdAt: p.createdAt, key: p.instrumentId !== null ? clientOf.get(p.instrumentId) ?? "(no client)" : "Shelf stock" })),
    windowStart,
  ).entries()].sort((a, b) => b[1].cents - a[1].cents);

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
    <div className="container page">
      <div className="page-head">
        <h1 className="page-title">Metrics</h1>
        <span className="page-actions">
          <span className="mut" style={{ fontSize: 12 }}>Last</span>
          <div className="seg" role="group" aria-label="Report window">
            {WINDOWS.map((w) => (
              <Link key={w} href={w === 30 ? "/metrics" : `/metrics?days=${w}`} aria-pressed={days === w}
                className={days === w ? "btn sm accent" : "btn sm"} style={{ textDecoration: "none", border: "none" }}>
                {w} days
              </Link>
            ))}
          </div>
        </span>
      </div>

      <div className="card">
        <div className="card-title" style={{ marginBottom: 4 }}>PM compliance</div>
        <div className="mut" style={{ fontSize: 12, marginBottom: 10 }}>
          Scheduled maintenance that fell due in the window. A task reopened after being done counts as open -
          the work is not done.
        </div>
        {pmTotal === 0 ? (
          <div className="mut" style={{ fontSize: 13 }}>No scheduled maintenance fell due in this window.</div>
        ) : (
          <>
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 8 }}>
              <span className="pill" style={{ background: "#E5F3E5", color: "#2E6B2E" }}>{pm.onTime} on time</span>
              <span className="pill" style={{ background: "#FAF0DC", color: "#8A5410" }}>{pm.late} done late</span>
              <span className="pill" style={{ background: "#FBE9E9", color: "#A32D2D" }}>{pm.openOverdue} overdue, open</span>
              <span className="pill" style={{ background: "#EEF1F5", color: "#475569" }}>{pm.openNotDue} due soon</span>
            </div>
            <div style={{ fontSize: 13 }}>
              <b>{Math.round((pm.onTime / Math.max(1, pm.onTime + pm.late + pm.openOverdue)) * 100)}%</b>
              <span className="mut"> of due maintenance was done on time.</span>
            </div>
          </>
        )}
      </div>

      <div className="card">
        <div className="card-title" style={{ marginBottom: 4 }}>Turnaround</div>
        <div className="mut" style={{ fontSize: 12, marginBottom: 10 }}>
          Days from a system entering the shop to its first Shipped. Days it spent in
          another organization&apos;s queue are shown separately - the client waited for
          them, but nobody here could have shortened them.
        </div>
        {turnaround.length === 0 ? (
          <div className="mut" style={{ fontSize: 13 }}>Nothing shipped in this window.</div>
        ) : (
          <div style={{ fontSize: 13 }}>
            <b>{avgTurn} day{avgTurn === 1 ? "" : "s"}</b>
            <span className="mut"> average across {turnaround.length} system{turnaround.length === 1 ? "" : "s"} · </span>
            <span className="mut">
              fastest {Math.min(...turnaround.map((t) => t.gross))}d · slowest {Math.max(...turnaround.map((t) => t.gross))}d
            </span>
            {parkedTotal > 0 && (
              <div style={{ marginTop: 6 }}>
                <b style={{ color: "#085041" }}>{avgNet} day{avgNet === 1 ? "" : "s"}</b>
                <span className="mut"> average on our side · {parkedTotal} day{parkedTotal === 1 ? "" : "s"} total
                  spent in someone else&apos;s queue</span>
              </div>
            )}
          </div>
        )}
      </div>

      <div className="card">
        <div className="card-title" style={{ marginBottom: 4 }}>Hours</div>
        <div className="mut" style={{ fontSize: 12, marginBottom: 10 }}>
          Logged labor, by client and by person. Unlogged work is invisible here - log hours on the system or
          unit where they happened.
        </div>
        {hoursByClient.length === 0 ? (
          <div className="mut" style={{ fontSize: 13 }}>No hours logged in this window.</div>
        ) : (
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
            <div>
              <div className="eyebrow" style={{ marginBottom: 4 }}>By client</div>
              {hoursByClient.map(([k, min]) => (
                <div key={k} style={{ display: "flex", gap: 8, padding: "4px 0", borderTop: "1px solid var(--line)", fontSize: 13 }}>
                  <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis" }}>{k}</span>
                  <b>{formatHours(min)}</b>
                </div>
              ))}
            </div>
            <div>
              <div className="eyebrow" style={{ marginBottom: 4 }}>By person</div>
              {hoursByPerson.map(([k, min]) => (
                <div key={k} style={{ display: "flex", gap: 8, padding: "4px 0", borderTop: "1px solid var(--line)", fontSize: 13 }}>
                  <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis" }}>{k}</span>
                  <b>{formatHours(min)}</b>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      <div className="card">
        <div className="card-title" style={{ marginBottom: 4 }}>Parts spend</div>
        <div className="mut" style={{ fontSize: 12, marginBottom: 10 }}>
          By client, from parts recorded in the window whose cost parsed as money. Free-text costs
          (&quot;call for quote&quot;) are counted but not summed, so this is a floor.
        </div>
        {spend.length === 0 ? (
          <div className="mut" style={{ fontSize: 13 }}>No parts recorded in this window.</div>
        ) : (
          spend.map(([k, v]) => (
            <div key={k} style={{ display: "flex", gap: 8, padding: "5px 0", borderTop: "1px solid var(--line)", fontSize: 13, flexWrap: "wrap" }}>
              <span style={{ flex: 1, minWidth: 0 }}>{k}</span>
              <b>{formatCents(v.cents)}</b>
              <span className="mut" style={{ fontSize: 11 }}>
                {v.counted} priced{v.unpriced ? ` · ${v.unpriced} unpriced` : ""}
              </span>
            </div>
          ))
        )}
      </div>

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
