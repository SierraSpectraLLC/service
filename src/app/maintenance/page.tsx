import Link from "next/link";
import { redirect } from "next/navigation";
import { asc, inArray, isNotNull, ne, and } from "drizzle-orm";
import { db } from "@/db";
import { assets, instruments, pmSchedules, tasks } from "@/db/schema";
import { requireStaff } from "@/lib/authz";
import { getSystemLabels } from "@/lib/systemLabel";
import { cadenceLabel } from "@/lib/pm";
import { shopToday } from "@/lib/shopday";

export const dynamic = "force-dynamic";

/**
 * The shop's maintenance calendar: every schedule on every system and asset,
 * soonest first, so the week's PM is planned from one page instead of by
 * opening systems one at a time. Staff view - each schedule is edited on the
 * page of the thing it maintains.
 */
export default async function MaintenancePage() {
  try { await requireStaff(); } catch { redirect("/"); }
  const today = shopToday();

  const [schedules, openPm] = await Promise.all([
    db.select().from(pmSchedules).orderBy(asc(pmSchedules.paused), asc(pmSchedules.nextDue), asc(pmSchedules.id)),
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

  return (
    <div className="container" style={{ maxWidth: 760 }}>
      <div className="card">
        <div className="card-title" style={{ marginBottom: 4 }}>Maintenance calendar</div>
        <div className="mut" style={{ fontSize: 12, marginBottom: 10 }}>
          Every recurring schedule in the shop, soonest first. Due ones become tasks automatically each
          morning; add or change a schedule on its system&apos;s or asset&apos;s page.
        </div>
        {schedules.map((s) => {
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
                ) : inFlight.has(s.id) ? (
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
        })}
        {schedules.length === 0 && (
          <div className="mut" style={{ fontSize: 13 }}>
            Nothing scheduled yet. Open a system or asset and add its recurring upkeep under Maintenance.
          </div>
        )}
      </div>
    </div>
  );
}
