import Link from "next/link";
import { redirect } from "next/navigation";
import { asc, inArray, isNotNull, ne, and } from "drizzle-orm";
import { db } from "@/db";
import { assets, instruments, pmSchedules, tasks } from "@/db/schema";
import { requireStaff } from "@/lib/authz";
import { forTenant, readTenant } from "@/lib/tenancy";
import { getSystemLabels } from "@/lib/systemLabel";
import { cadenceLabel } from "@/lib/pm";
import { pmGroups } from "@/lib/pmGroups";
import { shopToday } from "@/lib/shopday";
import { DataTable, Dot, FacetStrip, Id, Legend, PageHead, Pill, Toolbar } from "@/components/ui";
import type { DataRow } from "@/components/ui/DataTable";
import type { Tone } from "@/lib/tones";

export const dynamic = "force-dynamic";

/**
 * The shop's maintenance calendar: every schedule on every system and asset, so
 * the week's PM is planned from one page instead of by opening systems one at a
 * time. What's owed leads; the rest groups into the month it falls in (see
 * lib/pmGroups). Staff view - each schedule is edited on the page of the thing
 * it maintains.
 */
export default async function MaintenancePage({ searchParams }: { searchParams: Promise<{ q?: string; show?: string }> }) {
  let user;
  try { user = await requireStaff(); } catch { redirect("/"); }
  const today = shopToday();
  const { q = "", show = "" } = await searchParams;

  const [schedules, openPm] = await Promise.all([
    // This workspace's schedules. Another operator's PM calendar is not ours to
    // plan, and the two must never appear on one page.
    db.select().from(pmSchedules).where(forTenant(pmSchedules.tenantOrgId, readTenant(user)))
      .orderBy(asc(pmSchedules.paused), asc(pmSchedules.nextDue), asc(pmSchedules.id)),
    db.select({ pmScheduleId: tasks.pmScheduleId }).from(tasks)
      .where(and(isNotNull(tasks.pmScheduleId), ne(tasks.state, "Done"))),
  ]);
  const inFlight = new Set(openPm.map((t) => t.pmScheduleId));

  const instIds = [...new Set(schedules.flatMap((s) => (s.instrumentId !== null ? [s.instrumentId] : [])))];
  const assetIds = [...new Set(schedules.flatMap((s) => (s.assetId !== null ? [s.assetId] : [])))];
  const [instRows, assetRows] = await Promise.all([
    instIds.length ? db.select().from(instruments).where(inArray(instruments.id, instIds)) : [],
    assetIds.length ? db.select().from(assets).where(inArray(assets.id, assetIds)) : [],
  ]);
  const sysLabels = await getSystemLabels(instRows);

  const placeOf = (s: typeof schedules[number]) => {
    if (s.instrumentId !== null) {
      const i = instRows.find((r) => r.id === s.instrumentId);
      const named = i ? sysLabels.get(i.id) ?? "" : "";
      return { href: `/instruments/${s.instrumentId}`, id: i?.externalId ?? "?", label: named };
    }
    const a = assetRows.find((r) => r.id === s.assetId);
    return { href: `/assets/${s.assetId}`, id: a?.kind ?? "?", label: a ? `${a.model}${a.serial ? ` (SN ${a.serial})` : ""}` : "" };
  };

  const mdy = (iso: string) => { const [y, m, d] = iso.split("-"); return `${parseInt(m)}/${parseInt(d)}/${y.slice(2)}`; };

  // Owed now leads, then everything else grouped into the month it falls in.
  const rows = schedules.map((s) => ({ ...s, openTaskId: inFlight.has(s.id) ? s.id : null }));
  const { active, months, paused, next, allClear } = pmGroups(rows, today);

  const needle = q.trim().toLowerCase();
  const hit = (s: typeof rows[number]) => {
    if (!needle) return true;
    const p = placeOf(s);
    return [p.id, p.label, s.title, s.assignee].join(" ").toLowerCase().includes(needle);
  };
  const view = show === "all" ? "all" : show === "paused" ? "paused" : "due";
  const href = (v: string) => {
    const p = new URLSearchParams();
    if (needle) p.set("q", needle);
    if (v !== "due") p.set("show", v);
    return `/maintenance${p.size ? `?${p}` : ""}`;
  };

  const toRow = (s: typeof rows[number], group?: string): DataRow => {
    const place = placeOf(s);
    const overdue = !s.paused && s.nextDue < today;
    const dueToday = !s.paused && s.nextDue === today;
    const tone: Tone = s.paused ? "faint"
      : s.openTaskId !== null ? "info"
      : overdue ? "bad" : dueToday ? "warn" : "neutral";
    return {
      key: s.id,
      href: place.href,
      group,
      cells: {
        dot: <Dot tone={tone} />,
        place: (
          <span style={{ minWidth: 0, display: "block" }}>
            <Id>{place.id}</Id>
            {place.label && (
              <span className="mut" style={{ display: "block", fontSize: 11, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {place.label}
              </span>
            )}
          </span>
        ),
        title: <span style={{ fontWeight: 600 }}>{s.title}</span>,
        cadence: <span className="mut">{cadenceLabel(s.everyDays)}</span>,
        who: <span className="mut">{s.assignee}</span>,
        due: s.paused ? (
          <Pill tone="faint">paused</Pill>
        ) : s.openTaskId !== null ? (
          <Pill tone="info">task open</Pill>
        ) : (
          <Pill tone={overdue ? "bad" : dueToday ? "warn" : "neutral"}>
            {overdue ? `was due ${mdy(s.nextDue)}` : dueToday ? "due today" : `next ${mdy(s.nextDue)}`}
          </Pill>
        ),
      },
    };
  };

  const tableRows: DataRow[] =
    view === "paused" ? paused.filter(hit).map((s) => toRow(s))
    : view === "all" ? [
        ...active.filter(hit).map((s) => toRow(s, "Due now")),
        ...months.flatMap((m) => m.rows.filter(hit).map((s) => toRow(s, m.label))),
      ]
    : active.filter(hit).map((s) => toRow(s));

  const futureCount = months.reduce((n, m) => n + m.rows.length, 0);

  return (
    <div className="container page">
      <PageHead
        crumb={<>Operations › <b>Maintenance</b></>}
        title="Maintenance"
      />
      <Toolbar
        search={
          <form action="/maintenance">
            {view !== "due" && <input type="hidden" name="show" value={view} />}
            <input name="q" defaultValue={q} placeholder="System, job or assignee" aria-label="Search schedules" />
          </form>
        }
        facets={
          <FacetStrip facets={[
            { key: "due", label: "Due now", count: active.length || undefined, on: view === "due", href: href("due") },
            { key: "all", label: "All scheduled", count: active.length + futureCount || undefined, on: view === "all", href: href("all") },
            ...(paused.length ? [{ key: "paused", label: "Paused", count: paused.length, on: view === "paused", href: href("paused") }] : []),
          ]} />
        }
      />

      {/* Nothing owed: the whole shop's upkeep in one line, and when it's back. */}
      {view === "due" && allClear && next && schedules.length > 0 && (
        <div className="card" style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
          <span style={{ fontSize: 13, fontWeight: 700 }}>Nothing due</span>
          <Pill tone="good">next due {next.label}</Pill>
        </div>
      )}

      {(view !== "due" || !allClear || schedules.length === 0) && (
        <DataTable
          cols={[
            { key: "dot", label: "", width: "12px" },
            { key: "place", label: "On", width: "minmax(120px, 1.1fr)" },
            { key: "title", label: "Job", width: "minmax(160px, 1.6fr)" },
            { key: "cadence", label: "Every", width: "90px", hideMobile: true },
            { key: "who", label: "Assignee", width: "90px", hideMobile: true },
            { key: "due", label: "Due", width: "150px" },
          ]}
          rows={tableRows}
          empty={schedules.length === 0 ? "Nothing scheduled yet" : "Nothing matches"}
        />
      )}
      <Legend items={[
        { tone: "bad", label: "overdue" },
        { tone: "warn", label: "due today" },
        { tone: "info", label: "task open" },
        { tone: "neutral", label: "scheduled" },
        { tone: "faint", label: "paused" },
      ]} />

      <div className="mut no-print" style={{ fontSize: 12, padding: "0 4px" }}>
        Define what each model needs - jobs, cadences, part numbers - in{" "}
        <Link href="/settings/procedures" style={{ color: "var(--navy)" }}>Settings → Procedures</Link>.
      </div>
    </div>
  );
}
