import Link from "next/link";
import { redirect } from "next/navigation";
import { and, eq, inArray, ne } from "drizzle-orm";
import { db } from "@/db";
import {
  agreements, appSettings, assets, instruments, invoices, orgs, pmSchedules, quotes, restorationProjects, tasks,
} from "@/db/schema";
import { requireUser } from "@/lib/authz";
import { isPlatformStaff, isStaffRole, tenantViewer } from "@/lib/tenants";
import { forTenant, readTenant } from "@/lib/tenancy";
import { assembleEvents, monthGrid, monthOf, monthTitle, promiseTone, shiftMonth } from "@/lib/calendar";
import { RESTORATION_STAGE_LABEL, type RestorationStage } from "@/lib/restoration";
import { getSystemLabels } from "@/lib/systemLabel";
import { shopToday } from "@/lib/shopday";
import CalendarBoard from "@/components/CalendarBoard";
import CalendarFeedCard from "@/components/CalendarFeedCard";
import TvRefresh from "@/components/TvRefresh";
import { Dot, Id, Legend, PageHead } from "@/components/ui";

export const dynamic = "force-dynamic";

/**
 * The company calendar: every dated fact the app keeps, on one month.
 *
 * Derived at render from the rows that own each date - booked visits and due
 * cycles from pm_schedules, task dates, quote expiries, invoice due days,
 * contract ends, retainer cycles - so it can never disagree with the pages
 * those live on, and closing the work clears the calendar by itself.
 */
export default async function CalendarPage({ searchParams }: {
  searchParams: Promise<{ m?: string; view?: string }>;
}) {
  let user;
  try { user = await requireUser(); } catch { redirect("/login"); }
  if (!isStaffRole(user.role)) redirect("/");
  const t = readTenant(user);
  const today = shopToday();
  const { m, view } = await searchParams;
  const tv = view === "tv";
  const ym = /^\d{4}-\d{2}$/.test(m ?? "") ? m! : monthOf(today);
  const { weeks, days } = monthGrid(ym);
  const from = days[0], to = days[days.length - 1];

  const [schedRows, taskRows, quoteRows, invoiceRows, agreementRows, orgRows, instRows, assetRows, settings] =
    await Promise.all([
      db.select().from(pmSchedules).where(forTenant(pmSchedules.tenantOrgId, t)),
      // Dated open tasks; a PM task's schedule already speaks for it.
      db.select().from(tasks)
        .where(and(forTenant(tasks.tenantOrgId, t), ne(tasks.state, "Done"), ne(tasks.dueDate, ""))),
      db.select().from(quotes).where(forTenant(quotes.tenantOrgId, t)),
      db.select().from(invoices).where(forTenant(invoices.tenantOrgId, t)),
      db.select().from(agreements).where(forTenant(agreements.tenantOrgId, t)),
      db.select({ id: orgs.id, name: orgs.name }).from(orgs),
      db.select({
        id: instruments.id, externalId: instruments.externalId, dueOn: instruments.dueOn,
        archived: instruments.archived, name: instruments.name, model: instruments.model,
        location: instruments.location, client: instruments.client,
      }).from(instruments)
        .where(forTenant(instruments.tenantOrgId, t)),
      db.select({ id: assets.id, kind: assets.kind, model: assets.model, instrumentId: assets.instrumentId })
        .from(assets).where(forTenant(assets.tenantOrgId, t)),
      db.select().from(appSettings).where(eq(appSettings.id, 1)).then((r) => r[0] ?? null),
    ]);
  const orgName = new Map(orgRows.map((o) => [o.id, o.name]));
  const sysLabel = new Map(instRows.map((i) => [i.id, i.externalId]));

  const events = assembleEvents({
    schedules: schedRows.map((s) => {
      const viaAsset = s.assetId !== null ? assetRows.find((a) => a.id === s.assetId) : undefined;
      const instrumentId = s.instrumentId ?? viaAsset?.instrumentId ?? null;
      return {
        id: s.id, title: s.title, paused: s.paused, nextDue: s.nextDue,
        bookedOn: s.bookedOn, instrumentId, assetId: s.assetId,
        systemLabel: instrumentId !== null
          ? (sysLabel.get(instrumentId) ?? "")
          : viaAsset ? `${viaAsset.kind} ${viaAsset.model}`.trim() : "",
      };
    }),
    tasks: taskRows.filter((x) => x.pmScheduleId === null).map((x) => ({
      id: x.id, title: x.title, dueDate: x.dueDate, instrumentId: x.instrumentId, assignee: x.assignee,
    })),
    // An archived system's promise died with the record.
    systems: instRows.filter((i) => !i.archived && i.dueOn)
      .map((i) => ({ id: i.id, externalId: i.externalId, dueOn: i.dueOn })),
    quotes: quoteRows.map((q) => ({
      id: q.id, number: q.number, title: q.title, status: q.status, expiresOn: q.expiresOn,
    })),
    invoices: invoiceRows.map((i) => ({
      id: i.id, number: i.number, status: i.status, dueOn: i.dueOn, orgName: orgName.get(i.orgId) ?? "",
    })),
    agreements: agreementRows.map((a) => ({
      id: a.id, number: a.number, title: a.title, orgId: a.orgId, orgName: orgName.get(a.orgId) ?? "",
      status: a.status, startsOn: a.startsOn, endsOn: a.endsOn,
      billEveryMonths: a.billEveryMonths, billAmountCents: a.billAmountCents,
      billDescription: a.billDescription, billDayOfMonth: a.billDayOfMonth,
      billLeadDays: a.billLeadDays, billNextOn: a.billNextOn, billLastOn: a.billLastOn,
    })),
  }, from, to, today);

  /*
   * The wall's right-hand rail: EVERY promised system, not just this month's -
   * a TV in a lab answers "what is due and where is it", and a promise sitting
   * in October must not vanish because the screen shows September. "Where" is
   * the best answer each system can give: its restoration stage while it is in
   * the pipeline, else the bench it sits on, else whose it is.
   */
  const promised = instRows.filter((i) => !i.archived && i.dueOn)
    .sort((a, b) => a.dueOn.localeCompare(b.dueOn));
  const promLabels = await getSystemLabels(promised);
  const inFlight = promised.length
    ? await db.select({ instrumentId: restorationProjects.instrumentId, stage: restorationProjects.stage })
        .from(restorationProjects)
        .where(and(inArray(restorationProjects.instrumentId, promised.map((p) => p.id)), ne(restorationProjects.stage, "complete")))
    : [];
  const whereOf = (i: (typeof promised)[number]) => {
    const stage = inFlight.find((r) => r.instrumentId === i.id)?.stage;
    if (stage) return RESTORATION_STAGE_LABEL[stage as RestorationStage] ?? stage;
    return i.location || i.client || "—";
  };

  const rail = (
    <aside>
      <section className="card">
        <h2 className="card-title">Promised</h2>
        {promised.map((i) => (
          <Link key={i.id} href={`/instruments/${i.id}`} className="prom-row" style={{ textDecoration: "none", color: "inherit" }}>
            <Dot tone={promiseTone(i.dueOn, today)} />
            <div className="pbody">
              <div className="t-body" style={{ fontWeight: 600 }}>
                <Id>{i.externalId}</Id>{" "}
                {promLabels.get(i.id) || i.model}
              </div>
              <div className="mut t-small">{whereOf(i)}</div>
            </div>
            <span className="pwhen">{i.dueOn}</span>
          </Link>
        ))}
        {promised.length === 0 && (
          <div className="empty"><b>Nothing promised</b>Set a due date on a system and it lines up here.</div>
        )}
      </section>
      <Legend items={[
        { tone: "bad", label: "past its day" },
        { tone: "warn", label: "due within a week" },
        { tone: "info", label: "further out" },
      ]} />
    </aside>
  );

  const monthNav = (
    <span style={{ display: "flex", gap: 6, alignItems: "center" }}>
      <Link className="btn sm" href={`/calendar?m=${shiftMonth(ym, -1)}${tv ? "&view=tv" : ""}`} aria-label="Previous month">←</Link>
      <b className="t-body" style={{ minWidth: 110, textAlign: "center" }}>{monthTitle(ym)}</b>
      <Link className="btn sm" href={`/calendar?m=${shiftMonth(ym, 1)}${tv ? "&view=tv" : ""}`} aria-label="Next month">→</Link>
      {ym !== monthOf(today) && <Link className="btn sm" href={tv ? "/calendar?view=tv" : "/calendar"}>Today</Link>}
      <Link className="btn sm" href={tv ? `/calendar?m=${ym}` : `/calendar?m=${ym}&view=tv`}>
        {tv ? "Exit TV mode" : "TV mode"}
      </Link>
    </span>
  );

  if (tv) {
    return (
      <div className="container fluid">
        <TvRefresh />
        <PageHead title="Calendar" actions={monthNav} />
        <div className="cal-tv">
          <div><CalendarBoard ym={ym} weeks={weeks} events={events} today={today} /></div>
          {rail}
        </div>
      </div>
    );
  }

  return (
    <div className="container wide">
      <PageHead
        title="Calendar"
        sub="Every dated fact in one place: booked visits, maintenance due, tasks, money. Each entry links to the record that owns it."
        actions={monthNav}
      />
      <CalendarBoard ym={ym} weeks={weeks} events={events} today={today} />
      {/* The feed's secret lives on app_settings, one row for the whole
          instance, and the feed it opens is the instance operator's calendar.
          `role === "owner"` is true for EVERY workspace's owner, so this card
          used to print one company's live token onto another's page. */}
      {isPlatformStaff(tenantViewer(user)) && (
        <CalendarFeedCard token={settings?.calendarToken ?? ""} />
      )}
    </div>
  );
}
