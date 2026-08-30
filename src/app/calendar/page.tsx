import Link from "next/link";
import { redirect } from "next/navigation";
import { and, asc, eq, inArray, ne } from "drizzle-orm";
import { db } from "@/db";
import {
  agreements, appSettings, assets, calendarNotes, instruments, invoices, orgs, pmSchedules, quotes, tasks,
} from "@/db/schema";
import { requireUser } from "@/lib/authz";
import { isPlatformStaff, isStaffRole, tenantViewer } from "@/lib/tenants";
import { forTenant, maySeeOrgMoney, readTenant, visibleSystemIds } from "@/lib/tenancy";
import { assembleEvents, monthGrid, monthOf, monthTitle, shiftMonth } from "@/lib/calendar";
import { clientCalendarInputs, forClient } from "@/lib/clientCalendarData";
import { shopToday } from "@/lib/shopday";
import CalendarBoard from "@/components/CalendarBoard";
import CalendarFeedCard from "@/components/CalendarFeedCard";
import ClientCalendarActions from "@/components/ClientCalendarActions";
import { PageHead } from "@/components/ui";

export const dynamic = "force-dynamic";

/**
 * The company calendar: every dated fact the app keeps, on one month.
 *
 * Derived at render from the rows that own each date - booked visits and due
 * cycles from pm_schedules, task dates, quote expiries, invoice due days,
 * contract ends, retainer cycles - so it can never disagree with the pages
 * those live on, and closing the work clears the calendar by itself. The one
 * stored thing is a written note; see db/schema.calendarNotes.
 *
 * A CLIENT reads the same page, scoped to their own company: visits booked on
 * their machines, upkeep coming due on them, their open jobs, and their own
 * money if they read it. One URL and one word for one idea, which is the rule
 * lib/nav is built on - the reading is what differs, not the room. Their
 * scoping lives in lib/clientCalendarData, deliberately away from the shop's.
 */
export default async function CalendarPage({ searchParams }: {
  searchParams: Promise<{ m?: string }>;
}) {
  let user;
  try { user = await requireUser(); } catch { redirect("/login"); }
  const staff = isStaffRole(user.role);
  // A signed-in reader with no company has no calendar of their own to read.
  if (!staff && user.orgId === null) redirect("/");
  const t = readTenant(user);
  const today = shopToday();
  const { m } = await searchParams;
  const ym = /^\d{4}-\d{2}$/.test(m ?? "") ? m! : monthOf(today);
  const { weeks, days } = monthGrid(ym);
  const from = days[0], to = days[days.length - 1];

  if (!staff) return clientCalendar({ user, ym, weeks, from, to, today });

  const [schedRows, taskRows, quoteRows, invoiceRows, agreementRows, orgRows, instRows, assetRows, settings, noteRows] =
    await Promise.all([
      db.select().from(pmSchedules).where(forTenant(pmSchedules.tenantOrgId, t)),
      // Dated open tasks; a PM task's schedule already speaks for it.
      db.select().from(tasks)
        .where(and(forTenant(tasks.tenantOrgId, t), ne(tasks.state, "Done"), ne(tasks.dueDate, ""))),
      db.select().from(quotes).where(forTenant(quotes.tenantOrgId, t)),
      db.select().from(invoices).where(forTenant(invoices.tenantOrgId, t)),
      db.select().from(agreements).where(forTenant(agreements.tenantOrgId, t)),
      db.select({ id: orgs.id, name: orgs.name }).from(orgs),
      db.select({ id: instruments.id, externalId: instruments.externalId }).from(instruments)
        .where(forTenant(instruments.tenantOrgId, t)),
      db.select({ id: assets.id, kind: assets.kind, model: assets.model, instrumentId: assets.instrumentId })
        .from(assets).where(forTenant(assets.tenantOrgId, t)),
      db.select().from(appSettings).where(eq(appSettings.id, 1)).then((r) => r[0] ?? null),
      /* Every note in the workspace: the shop's own, and the ones its clients
         wrote on theirs. A client's shutdown week is the whole reason notes
         exist - it is the fact that stops a van being sent to a locked door,
         and it is only useful to the shop if the shop can see it. */
      db.select().from(calendarNotes).where(forTenant(calendarNotes.tenantOrgId, t)),
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
    notes: noteRows.map((x) => ({
      id: x.id, onDate: x.onDate, endsOn: x.endsOn, title: x.title,
      // Whose it is, because on the shop's calendar that is the fact: "shut
      // for stocktake" means nothing without the company in front of it.
      orgName: x.orgId === null ? "" : (orgName.get(x.orgId) ?? ""),
    })),
  }, from, to, today);

  return (
    <div className="container wide">
      <PageHead
        title="Calendar"
        sub="Every dated fact in one place: booked visits, maintenance due, tasks, money, and what clients have told us about their own year."
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

/**
 * The same month, as the client whose machines it is about.
 *
 * A separate function rather than a branch threaded through the one above:
 * the two readings share the month arithmetic and the board, and share
 * nothing else at all - not a query, not a scope, not a link. Interleaving
 * them is how a `forTenant` ends up on one query and not the next.
 */
async function clientCalendar({ user, ym, weeks, from, to, today }: {
  user: Awaited<ReturnType<typeof requireUser>>;
  ym: string; weeks: string[][]; from: string; to: string; today: string;
}) {
  const orgId = user.orgId!;
  const [systemIds, seesMoney, orgRow] = await Promise.all([
    visibleSystemIds(user),
    maySeeOrgMoney(user, orgId),
    db.select({ name: orgs.name }).from(orgs).where(eq(orgs.id, orgId)).then((r) => r[0] ?? null),
  ]);

  const inputs = await clientCalendarInputs({
    orgId, orgName: orgRow?.name ?? "",
    // null is "the house sees everything", which a client never is; treated as
    // nothing rather than as everything, per visibleSystemIds' own contract.
    systemIds: systemIds ?? [],
    seesMoney,
  });
  const events = forClient(assembleEvents(inputs, from, to, today));

  // What they may ask for a visit ON: their own machines, named as they know
  // them. An empty list hides the ask rather than offering an empty picker.
  const systems = (systemIds ?? []).length
    ? await db.select({ id: instruments.id, externalId: instruments.externalId, model: instruments.model })
      .from(instruments)
      .where(and(eq(instruments.archived, false), inArray(instruments.id, systemIds ?? [])))
      .orderBy(asc(instruments.externalId))
    : [];

  return (
    <div className="container wide">
      <PageHead
        title="Calendar"
        sub="When somebody is coming, what is coming due, and anything you want us to know about your year."
        actions={
          <span style={{ display: "flex", gap: 6, alignItems: "center" }}>
            <Link className="btn sm" href={`/calendar?m=${shiftMonth(ym, -1)}`} aria-label="Previous month">←</Link>
            <b className="t-body" style={{ minWidth: 110, textAlign: "center" }}>{monthTitle(ym)}</b>
            <Link className="btn sm" href={`/calendar?m=${shiftMonth(ym, 1)}`} aria-label="Next month">→</Link>
            {ym !== monthOf(today) && <Link className="btn sm" href="/calendar">Today</Link>}
          </span>
        }
      />
      <ClientCalendarActions
        today={today} month={ym}
        systems={systems.map((x) => ({
          id: x.id, label: `${x.externalId}${x.model ? ` · ${x.model}` : ""}`,
        }))}
      />
      <CalendarBoard ym={ym} weeks={weeks} events={events} today={today} />
    </div>
  );
}
