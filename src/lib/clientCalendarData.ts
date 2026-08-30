// A client's own calendar: the same assembler, a much narrower reading.
//
// The shop's calendar is every dated fact in the workspace. A client's is the
// subset that is about THEM - visits booked on their machines, upkeep coming
// due on them, the jobs they have open, and their own money - so this file is
// really one thing: the scoping. lib/calendar turns whatever it is handed into
// events, and it must never be handed a row belonging to somebody else.
//
// The money half is gated separately from the rest, on the same rule the
// approvals page runs on: a lab tech reads when somebody is coming without
// reading what it costs.
import { and, eq, inArray, ne, or } from "drizzle-orm";
import { db } from "@/db";
import {
  agreements, assets, calendarNotes, instruments, invoices, pmSchedules, quotes, tasks,
} from "@/db/schema";
import type { CalendarInputs } from "@/lib/calendar";

export type ClientScope = {
  orgId: number;
  orgName: string;
  /** Systems this reader may see. Empty means nothing, never everything. */
  systemIds: number[];
  /** Whether they read their own company's money - see tenancy.maySeeOrgMoney. */
  seesMoney: boolean;
};

/**
 * What goes on one client's month.
 *
 * Every query is bounded by their own system ids or their own org id, and an
 * EMPTY system list short-circuits rather than being passed to a query - an
 * `inArray(x, [])` is a footgun that some drivers read as no predicate at all,
 * which here would be the whole workspace's maintenance on a client's screen.
 */
export async function clientCalendarInputs(scope: ClientScope): Promise<CalendarInputs> {
  const { systemIds, orgId } = scope;
  const none = systemIds.length === 0;

  // Their machines' own units, so a schedule living on a pump still lands on
  // the system it is installed in rather than nowhere.
  const assetRows = none ? [] : await db
    .select({ id: assets.id, kind: assets.kind, model: assets.model, instrumentId: assets.instrumentId })
    .from(assets).where(inArray(assets.instrumentId, systemIds));
  const assetIds = assetRows.map((a) => a.id);

  const [schedRows, taskRows, quoteRows, invoiceRows, agreementRows, noteRows, instRows] = await Promise.all([
    none ? [] : db.select().from(pmSchedules).where(
      assetIds.length
        ? or(inArray(pmSchedules.instrumentId, systemIds), inArray(pmSchedules.assetId, assetIds))
        : inArray(pmSchedules.instrumentId, systemIds),
    ),
    none ? [] : db.select().from(tasks).where(and(
      inArray(tasks.instrumentId, systemIds),
      ne(tasks.state, "Done"),
      ne(tasks.dueDate, ""),
    )),
    /* Their money, and only when they may read it. Quotes and invoices are
       filtered to their org rather than to their systems: a quote for work on
       a machine they no longer own is still addressed to them. */
    scope.seesMoney ? db.select().from(quotes).where(eq(quotes.orgId, orgId)) : [],
    scope.seesMoney ? db.select().from(invoices).where(eq(invoices.orgId, orgId)) : [],
    scope.seesMoney ? db.select().from(agreements).where(eq(agreements.orgId, orgId)) : [],
    // Their own notes and the shop's notes ABOUT them. Not the shop's own
    // internal ones, which are none of a client's business.
    db.select().from(calendarNotes).where(eq(calendarNotes.orgId, orgId)),
    none ? [] : db.select({ id: instruments.id, externalId: instruments.externalId })
      .from(instruments).where(inArray(instruments.id, systemIds)),
  ]);

  const sysLabel = new Map(instRows.map((i) => [i.id, i.externalId]));

  return {
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
    /* A PM task's schedule already speaks for it, same as the shop's own
       calendar - otherwise a booked visit and its task are two pills on one
       day saying the same thing. */
    tasks: taskRows.filter((x) => x.pmScheduleId === null).map((x) => ({
      id: x.id, title: x.title, dueDate: x.dueDate, instrumentId: x.instrumentId,
      // Never the engineer's name: who the shop put on a job is the shop's
      // business, and the client's question is when, not who.
      assignee: "",
    })),
    quotes: quoteRows.map((q) => ({
      id: q.id, number: q.number, title: q.title, status: q.status, expiresOn: q.expiresOn,
    })),
    invoices: invoiceRows.map((i) => ({
      id: i.id, number: i.number, status: i.status, dueOn: i.dueOn,
      // Their own name on their own calendar is noise.
      orgName: "",
    })),
    agreements: agreementRows.map((a) => ({
      id: a.id, number: a.number, title: a.title, orgId: a.orgId, orgName: "",
      status: a.status, startsOn: a.startsOn, endsOn: a.endsOn,
      billEveryMonths: a.billEveryMonths, billAmountCents: a.billAmountCents,
      billDescription: a.billDescription, billDayOfMonth: a.billDayOfMonth,
      billLeadDays: a.billLeadDays, billNextOn: a.billNextOn, billLastOn: a.billLastOn,
    })),
    notes: noteRows.map((n) => ({
      id: n.id, onDate: n.onDate, endsOn: n.endsOn, title: n.title, orgName: "",
    })),
  };
}

/** Their links go to their own rooms; a client has no /money/invoices/12. */
export function clientHref(kind: string, href: string): string {
  if (kind === "quote" || kind === "invoice") return "/orders";
  if (kind === "renewal" || kind === "retainer") return "/owner";
  if (kind === "task") return "/work";
  return href;
}

/**
 * The events, pointed at the rooms a client actually has.
 *
 * lib/calendar writes hrefs for the shop - /money/invoices/12, /work - because
 * that is where those records live for the reader it was written for. A client
 * has their own doors onto the same facts, and a calendar full of links that
 * bounce is worse than one with no links at all.
 */
export function forClient<T extends { kind: string; href: string }>(events: T[]): T[] {
  return events.map((e) => ({ ...e, href: clientHref(e.kind, e.href) }));
}
