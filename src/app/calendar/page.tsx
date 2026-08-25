import Link from "next/link";
import { redirect } from "next/navigation";
import { and, eq, ne } from "drizzle-orm";
import { db } from "@/db";
import {
  agreements, appSettings, assets, instruments, invoices, orgs, pmSchedules, quotes, tasks,
} from "@/db/schema";
import { requireUser } from "@/lib/authz";
import { isStaffRole } from "@/lib/tenants";
import { forTenant, readTenant } from "@/lib/tenancy";
import { assembleEvents, monthGrid, monthOf, monthTitle, shiftMonth } from "@/lib/calendar";
import { shopToday } from "@/lib/shopday";
import CalendarBoard from "@/components/CalendarBoard";
import CalendarFeedCard from "@/components/CalendarFeedCard";
import { PageHead } from "@/components/ui";

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
  searchParams: Promise<{ m?: string }>;
}) {
  let user;
  try { user = await requireUser(); } catch { redirect("/login"); }
  if (!isStaffRole(user.role)) redirect("/");
  const t = readTenant(user);
  const today = shopToday();
  const { m } = await searchParams;
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
      db.select({ id: instruments.id, externalId: instruments.externalId }).from(instruments),
      db.select({ id: assets.id, kind: assets.kind, model: assets.model, instrumentId: assets.instrumentId })
        .from(assets),
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

  return (
    <div className="container wide">
      <PageHead
        title="Calendar"
        sub="Every dated fact in one place: booked visits, maintenance due, tasks, money. Each entry links to the record that owns it."
        actions={
          <span style={{ display: "flex", gap: 6, alignItems: "center" }}>
            <Link className="btn sm" href={`/calendar?m=${shiftMonth(ym, -1)}`} aria-label="Previous month">←</Link>
            <b className="t-body" style={{ minWidth: 110, textAlign: "center" }}>{monthTitle(ym)}</b>
            <Link className="btn sm" href={`/calendar?m=${shiftMonth(ym, 1)}`} aria-label="Next month">→</Link>
            {ym !== monthOf(today) && <Link className="btn sm" href="/calendar">Today</Link>}
          </span>
        }
      />
      <CalendarBoard ym={ym} weeks={weeks} events={events} today={today} />
      {user.role === "owner" && (
        <CalendarFeedCard token={settings?.calendarToken ?? ""} />
      )}
    </div>
  );
}
