import { redirect } from "next/navigation";
import Link from "next/link";
import { and, asc, eq, gte, or } from "drizzle-orm";
import { db } from "@/db";
import { assets, instruments, stageEvents, tasks, timeEntries, parts, queueEvents } from "@/db/schema";
import { requireUser } from "@/lib/authz";
import { getStageDefs } from "@/lib/stageDefs";
import { getSystemLabels } from "@/lib/systemLabel";
import { sinceByStage, completedDurations, ageDays } from "@/lib/stageAges";
import { pmCompliance, shippedTurnaround, minutesBy, spendBy } from "@/lib/reports";
import { formatHours } from "@/lib/hours";
import { formatCents } from "@/lib/money";
import { costingBoard } from "@/lib/invoiceData";
import { SLOW_PAY_DAYS } from "@/lib/costing";
import { addDays } from "@/lib/pm";
import { shopToday } from "@/lib/shopday";
import { forTenant, readTenant, viewTenant } from "@/lib/tenancy";
import { Panel, Pill } from "@/components/ui";

export const dynamic = "force-dynamic";

/** A quiet horizontal bar: the value against the column's maximum, in a tone. */
function Bar({ value, max, tone = "info" }: { value: number; max: number; tone?: string }) {
  const pct = max > 0 ? Math.max(2, Math.round((value / max) * 100)) : 0;
  return (
    <div aria-hidden style={{ height: 5, borderRadius: 999, background: "var(--t-neutral-bg)", overflow: "hidden", marginTop: 3 }}>
      <div style={{ width: `${pct}%`, height: "100%", background: `var(--t-${tone}-fg)`, opacity: 0.75 }} />
    </div>
  );
}

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
    // Parts carry no stamp of their own - a part belongs to whatever record it
    // sits on - so the scope comes from that record. Unscoped, every other
    // workspace's part cost landed in the "(no client)" bucket below (its
    // instrument is not in clientOf, which is built from THIS workspace's
    // systems) and was summed into the parts-spend figure.
    db.select({ instrumentId: parts.instrumentId, costCents: parts.costCents, createdAt: parts.createdAt })
      .from(parts)
      .leftJoin(instruments, eq(instruments.id, parts.instrumentId))
      .leftJoin(assets, eq(assets.id, parts.assetId))
      .where(and(
        gte(parts.createdAt, windowStart),
        readTenant(user) === null ? undefined : or(
          eq(instruments.tenantOrgId, readTenant(user)!),
          eq(assets.tenantOrgId, readTenant(user)!),
        ),
      )),
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

  // The window at a glance, before any panel.
  const pmPct = Math.round((pm.onTime / Math.max(1, pm.onTime + pm.late + pm.openOverdue)) * 100);
  const totalMinutes = hoursByClient.reduce((n, [, min]) => n + min, 0);
  const totalSpend = spend.reduce((n, [, v]) => n + v.cents, 0);
  const tiles: [string, string, string | undefined][] = [
    ["PM on time", pmTotal === 0 ? "-" : `${pmPct}%`,
      pmTotal === 0 ? undefined : pmPct >= 80 ? "good" : pmPct >= 50 ? "warn" : "bad"],
    ["Avg turnaround", turnaround.length ? `${avgTurn}d` : "-", undefined],
    ["Hours logged", totalMinutes ? formatHours(totalMinutes) : "-", undefined],
    ["Parts spend", totalSpend ? formatCents(totalSpend) : "-", undefined],
    ["Active systems", String(active.length), undefined],
  ];

  const maxClientMin = Math.max(0, ...hoursByClient.map(([, m]) => m));
  const maxPersonMin = Math.max(0, ...hoursByPerson.map(([, m]) => m));
  const maxSpend = Math.max(0, ...spend.map(([, v]) => v.cents));
  const maxAvgStage = Math.max(0, ...avgRows.map((r) => r.avg));

  // What it costs to be owed the money, per client. Same loader Costing uses,
  // so the two pages cannot disagree about it.
  const payDays = (await costingBoard(shopToday(), days, readTenant(user)).catch(() => ({ clients: [] })))
    .clients.filter((c) => c.daysToPay !== null);

  return (
    <div className="container wide">
      <div className="crumb">Operations › <b>Metrics</b></div>
      <div className="page-head">
        <h1 className="page-title">Metrics</h1>
        <span className="page-actions">
          <span className="mut t-small">Last</span>
          <div className="seg" role="group" aria-label="Report window">
            {WINDOWS.map((w) => (
              <Link key={w} href={w === 30 ? "/metrics" : `/metrics?days=${w}`}
                aria-current={days === w ? "true" : undefined}>
                {w} days
              </Link>
            ))}
          </div>
        </span>
      </div>

      <div className="metric-grid" style={{ marginBottom: 12 }}>
        {tiles.map(([label, n, tone]) => (
          <div key={label} className="card" style={{ padding: "12px 14px", marginBottom: 0 }}>
            <div className="mut t-small">{label}</div>
            <div className="t-page" style={{ fontWeight: 700, color: tone ? `var(--t-${tone}-fg)` : "var(--navy)" }}>{n}</div>
          </div>
        ))}
      </div>

      {/* Two independent stacks from 1200px up - six stacked cards made a
          short report read as a long page. Stacks flatten in DOM order on
          narrow screens. */}
      <div className="panel-cols">
        <div>
      <Panel title="PM compliance"
        hint="Maintenance due in the window">
        {pmTotal === 0 ? (
          <div className="mut t-body">No scheduled maintenance fell due in this window.</div>
        ) : (
          <>
            {/* The distribution as one bar, in the same tones as the pills. */}
            <div aria-hidden style={{ display: "flex", height: 8, borderRadius: 999, overflow: "hidden", marginBottom: 8, background: "var(--t-neutral-bg)" }}>
              {([["good", pm.onTime], ["warn", pm.late], ["bad", pm.openOverdue], ["neutral", pm.openNotDue]] as const)
                .filter(([, n]) => n > 0)
                .map(([tone, n]) => (
                  <div key={tone} style={{ width: `${(n / pmTotal) * 100}%`, background: `var(--t-${tone}-fg)`, opacity: 0.8 }} />
                ))}
            </div>
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 8 }}>
              <span className="pill good">{pm.onTime} on time</span>
              <span className="pill warn">{pm.late} done late</span>
              <span className="pill bad">{pm.openOverdue} overdue, open</span>
              <span className="pill neutral">{pm.openNotDue} due soon</span>
            </div>
            <div className="t-body">
              <b>{pmPct}%</b>
              <span className="mut"> of due maintenance was done on time.</span>
            </div>
          </>
        )}
      </Panel>
      <Panel title="Hours"
        hint="Logged labor">
        {hoursByClient.length === 0 ? (
          <div className="mut t-body">No hours logged in this window.</div>
        ) : (
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
            <div>
              <div className="eyebrow" style={{ marginBottom: 4 }}>By client</div>
              {hoursByClient.map(([k, min]) => (
                <div key={k} style={{ padding: "4px 0", borderTop: "1px solid var(--line)" }}>
                  <div className="t-body" style={{ display: "flex", gap: 8 }}>
                    <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis" }}>{k}</span>
                    <b>{formatHours(min)}</b>
                  </div>
                  <Bar value={min} max={maxClientMin} />
                </div>
              ))}
            </div>
            <div>
              <div className="eyebrow" style={{ marginBottom: 4 }}>By person</div>
              {hoursByPerson.map(([k, min]) => (
                <div key={k} style={{ padding: "4px 0", borderTop: "1px solid var(--line)" }}>
                  <div className="t-body" style={{ display: "flex", gap: 8 }}>
                    <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis" }}>{k}</span>
                    <b>{formatHours(min)}</b>
                  </div>
                  <Bar value={min} max={maxPersonMin} />
                </div>
              ))}
            </div>
          </div>
        )}
      </Panel>
      {/* Days-to-pay, beside the work. A client's margin lives in Billing;
          what it costs to be owed the money belongs next to how much of the
          shop's time they take. */}
      {payDays.length > 0 && (
        <Panel
          title="Days to pay"
          count={payDays.length}
          hint="Weighted by amount, over settled invoices"
        >
          {payDays.map((c) => (
            <div key={c.orgId} className="row-2" style={{ alignItems: "baseline", padding: "6px 0", borderTop: "1px solid var(--line)" }}>
              <span className="t-body" style={{ flex: 1, minWidth: 0 }}>{c.orgName}</span>
              <span className="mut t-small">{c.terms}</span>
              <Pill tone={c.daysToPay! >= SLOW_PAY_DAYS ? "bad" : c.daysToPay! > 20 ? "warn" : "good"}>
                {c.daysToPay} d
              </Pill>
            </div>
          ))}
          <div className="mut t-small" style={{ marginTop: 8 }}>
            <Link href="/money/costing">Costing →</Link>
          </div>
        </Panel>
      )}

      <Panel title="Time in stage" count={active.length}
        hint="Active systems, longest-parked first"
        empty="No active systems">
        {active.length === 0 ? null : <>{active.map((i) => (
          <Link key={i.id} href={`/instruments/${i.id}`} className="row-hover"
            style={{ display: "flex", alignItems: "center", gap: 8, padding: "9px 4px", borderTop: "1px solid var(--line)", textDecoration: "none", color: "inherit", flexWrap: "wrap" }}>
            <span className="mono t-small" style={{ fontWeight: 700, color: "var(--navy)" }}>{i.externalId}</span>
            <span className="t-body" style={{ flex: "1 1 140px", minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{labels.get(i.id) || i.externalId}</span>
            <span style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
              {i.ages.map(({ stage, days }) => (
                <span key={stage} className="pill" style={{ background: color(stage).bg, color: color(stage).fg }}>
                  {stage}{days >= 1 ? ` · ${days}d` : ""}
                </span>
              ))}
            </span>
          </Link>
        ))}</>}
      </Panel>
        </div>
        <div>
      <Panel title="Turnaround"
        hint="Intake to first Shipped">
        {turnaround.length === 0 ? (
          <div className="mut t-body">Nothing shipped in this window.</div>
        ) : (
          <div className="t-body">
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
      </Panel>
      <Panel title="Parts spend"
        hint={<>By client, from parts recorded in the window whose cost parsed as money. Free-text costs
          (&quot;call for quote&quot;) are counted but not summed, so this is a floor.</>}>
        {spend.length === 0 ? (
          <div className="mut t-body">No parts recorded in this window.</div>
        ) : (
          spend.map(([k, v]) => (
            <div key={k} style={{ padding: "5px 0", borderTop: "1px solid var(--line)" }}>
              <div className="t-body" style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                <span style={{ flex: 1, minWidth: 0 }}>{k}</span>
                <b>{formatCents(v.cents)}</b>
                <span className="mut t-meta">
                  {v.counted} priced{v.unpriced ? ` · ${v.unpriced} unpriced` : ""}
                </span>
              </div>
              <Bar value={v.cents} max={maxSpend} tone="accent" />
            </div>
          ))
        )}
      </Panel>
      <Panel title="Average days per stage"
        hint="From completed stage transitions">
        {avgRows.map((r) => (
          <div key={r.stage} style={{ padding: "7px 4px", borderTop: "1px solid var(--line)" }}>
            <div className="t-body" style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <span className="pill" style={{ background: color(r.stage).bg, color: color(r.stage).fg }}>{r.stage}</span>
              <b style={{ marginLeft: "auto" }}>{r.avg < 1 ? "<1" : Math.round(r.avg)} day{Math.round(r.avg) === 1 ? "" : "s"}</b>
              <span className="mut t-meta">({r.n} completion{r.n === 1 ? "" : "s"})</span>
            </div>
            <Bar value={r.avg} max={maxAvgStage} tone="neutral" />
          </div>
        ))}
        {avgRows.length === 0 && <div className="mut t-body">No completed stage transitions recorded yet.</div>}
      </Panel>
        </div>
      </div>
    </div>
  );
}
