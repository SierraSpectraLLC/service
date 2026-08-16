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

export const dynamic = "force-dynamic";

/**
 * The shop's maintenance calendar: every schedule on every system and asset, so
 * the week's PM is planned from one page instead of by opening systems one at a
 * time. What's owed is listed; the rest folds into the month it falls in, so a
 * shop that is up to date reads as one line and a date (see lib/pmGroups). Staff
 * view - each schedule is edited on the page of the thing it maintains.
 */
export default async function MaintenancePage() {
  let user;
  try { user = await requireStaff(); } catch { redirect("/"); }
  const today = shopToday();

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
      return { href: `/instruments/${s.instrumentId}`, label: i ? (named ? `${i.externalId} - ${named}` : i.externalId) : "?" };
    }
    const a = assetRows.find((r) => r.id === s.assetId);
    return { href: `/assets/${s.assetId}`, label: a ? `${a.kind}${a.model ? ` — ${a.model}` : ""}${a.serial ? ` (SN ${a.serial})` : ""}` : "?" };
  };

  const mdy = (iso: string) => { const [y, m, d] = iso.split("-"); return `${parseInt(m)}/${parseInt(d)}/${y.slice(2)}`; };

  // Owed now, then everything else folded into the month it falls in. Planning the
  // week means reading the top of this page, not scrolling past two years of
  // yearly PMs that are all in hand.
  const rows = schedules.map((s) => ({ ...s, openTaskId: inFlight.has(s.id) ? s.id : null }));
  const { active, months, paused, next, allClear } = pmGroups(rows, today);
  const count = (n: number) => `${n} schedule${n === 1 ? "" : "s"}`;

  const row = (s: typeof rows[number]) => {
    const place = placeOf(s);
    const overdue = !s.paused && s.nextDue < today;
    const dueToday = !s.paused && s.nextDue === today;
    return (
      <Link key={s.id} href={place.href} className="row-hover"
        style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", padding: "8px 4px", borderTop: "1px solid var(--line)", textDecoration: "none", color: "inherit", opacity: s.paused ? 0.55 : 1 }}>
        <span className="mono" style={{ fontWeight: 700, fontSize: 12, color: "var(--navy)" }}>{place.label}</span>
        <span style={{ fontSize: 13 }}>{s.title}</span>
        <span className="pill" style={{ background: "#EDEBFA", color: "#4F45A3" }}>{cadenceLabel(s.everyDays)}</span>
        {s.assignee && <span className="mut" style={{ fontSize: 11 }}>{s.assignee}</span>}
        <span style={{ marginLeft: "auto" }}>
          {s.paused ? (
            <span className="pill" style={{ background: "#EEF1F5", color: "#475569" }}>paused</span>
          ) : s.openTaskId !== null ? (
            <span className="pill" style={{ background: "#E7F2FA", color: "#1D6396" }}>task open</span>
          ) : (
            <span className="pill" style={{
              background: overdue ? "#FBE9E9" : dueToday ? "#FAF0DC" : "#EEF1F5",
              color: overdue ? "#A32D2D" : dueToday ? "#8A5410" : "#475569",
            }}>
              {overdue ? `overdue - was due ${mdy(s.nextDue)}` : dueToday ? "due today" : `next ${mdy(s.nextDue)}`}
            </span>
          )}
        </span>
      </Link>
    );
  };

  return (
    <div className="container page">
      <div className="page-head">
        <h1 className="page-title">Maintenance</h1>
      </div>
      <div className="card">
        {active.map(row)}

        {/* Nothing owed: the whole shop's upkeep in one line, and when it's back. */}
        {allClear && next && schedules.length > 0 && (
          <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", padding: "8px 4px", borderTop: "1px solid var(--line)" }}>
            <span style={{ fontSize: 13, fontWeight: 700 }}>Nothing due</span>
            <span className="pill" style={{ background: "#E5F3E5", color: "#2E6B2E" }}>next due {next.label}</span>
          </div>
        )}

        {months.map((m) => (
          <details key={m.key} style={{ borderTop: "1px solid var(--line)" }}>
            <summary style={{ cursor: "pointer", padding: "8px 4px", fontSize: 12.5 }}>
              <b>{m.label}</b> <span className="mut">· {count(m.rows.length)}</span>
            </summary>
            {m.rows.map(row)}
          </details>
        ))}
        {paused.length > 0 && (
          <details style={{ borderTop: "1px solid var(--line)" }}>
            <summary style={{ cursor: "pointer", padding: "8px 4px", fontSize: 12.5 }}>
              <b>Paused</b> <span className="mut">· {count(paused.length)}</span>
            </summary>
            {paused.map(row)}
          </details>
        )}

        {schedules.length === 0 && (
          <div className="empty">
            <b>Nothing scheduled yet</b>
            Define a template in Settings → Procedures to cover a whole model, or open a system
            or asset and add its recurring upkeep under Maintenance.
          </div>
        )}
      </div>

      <div className="mut no-print" style={{ fontSize: 12, padding: "0 4px" }}>
        Define what each model needs - jobs, cadences, part numbers - in{" "}
        <Link href="/settings/procedures" style={{ color: "var(--navy)" }}>Settings → Procedures</Link>.
      </div>
    </div>
  );
}
