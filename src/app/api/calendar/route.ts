import { NextResponse } from "next/server";
import { and, eq, ne } from "drizzle-orm";
import { db } from "@/db";
import {
  agreements, appSettings, assets, instruments, invoices, orgs, pmSchedules, quotes, tasks,
} from "@/db/schema";
import { forTenant } from "@/lib/tenancy";
import { assembleEvents, eventsToIcs } from "@/lib/calendar";
import { addDays } from "@/lib/pm";
import { appUrl } from "@/lib/appUrl";
import { getBrand } from "@/lib/brand";
import { shopToday } from "@/lib/shopday";

export const dynamic = "force-dynamic";

/**
 * The company calendar as an iCalendar feed - two weeks back, ninety days
 * ahead, refreshed whenever the phone asks.
 *
 * Token-authed because subscribed calendars cannot sign in: the URL is the
 * credential, minted and rotated by the owner on /calendar. No token on
 * file means no feed at all, and a wrong token gets the same 404 as a
 * missing one - an endpoint that distinguishes "off" from "wrong key" is
 * confirming which guesses are close.
 */
export async function GET(req: Request) {
  const token = new URL(req.url).searchParams.get("token")?.trim() ?? "";
  const [settings] = await db.select().from(appSettings).where(eq(appSettings.id, 1));
  const want = settings?.calendarToken?.trim() ?? "";
  if (!want || !token || token !== want) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const today = shopToday();
  const from = addDays(today, -14);
  const to = addDays(today, 90);

  // Whose calendar this is. The token is one column on app_settings, so there
  // is exactly one feed and it belongs to the operator that runs the instance.
  // Nothing below was scoped before, which made a single URL a standing export
  // of every workspace's schedules, jobs, quotes, invoices, contracts, client
  // names and serials - to anybody the link was ever forwarded to.
  //
  // Null (an instance that has never named an operator) keeps the old
  // unrestricted behavior, which is correct there: one operator, one calendar.
  //
  // KNOWN LIMIT, once the platform operator is not also a service company: this
  // resolves to the PLATFORM's workspace, which has no systems, so the feed is
  // empty. The token is a single column on app_settings and there is nothing on
  // it recording whose calendar it is. Making the feed per-operator - a
  // calendar_token on orgs, minted by each owner for their own workspace - is
  // the fix, and it is a feature change rather than a migration step, so it is
  // deliberately not done here. The feature ships off; turn it on only after
  // that change, or the subscriber gets an empty calendar.
  const feedTenant = settings?.operatorOrgId ?? null;

  const [schedRows, taskRows, quoteRows, invoiceRows, agreementRows, orgRows, instRows, assetRows, brand] =
    await Promise.all([
      db.select().from(pmSchedules).where(forTenant(pmSchedules.tenantOrgId, feedTenant)),
      db.select().from(tasks).where(and(
        forTenant(tasks.tenantOrgId, feedTenant), ne(tasks.state, "Done"), ne(tasks.dueDate, ""))),
      db.select().from(quotes).where(forTenant(quotes.tenantOrgId, feedTenant)),
      db.select().from(invoices).where(forTenant(invoices.tenantOrgId, feedTenant)),
      db.select().from(agreements).where(forTenant(agreements.tenantOrgId, feedTenant)),
      db.select({ id: orgs.id, name: orgs.name }).from(orgs),
      db.select({ id: instruments.id, externalId: instruments.externalId }).from(instruments)
        .where(forTenant(instruments.tenantOrgId, feedTenant)),
      db.select({ id: assets.id, kind: assets.kind, model: assets.model, instrumentId: assets.instrumentId })
        .from(assets).where(forTenant(assets.tenantOrgId, feedTenant)),
      getBrand(),
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

  const name = `${brand.operatorName || brand.name} calendar`;
  return new NextResponse(eventsToIcs(events, name, appUrl()), {
    headers: {
      "Content-Type": "text/calendar; charset=utf-8",
      "Content-Disposition": 'inline; filename="calendar.ics"',
      "Cache-Control": "private, max-age=300",
    },
  });
}
