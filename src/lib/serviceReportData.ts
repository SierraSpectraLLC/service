// The rows behind a service report.
//
// lib/serviceReportDoc decides what the report says; this fetches what it says
// it about. Nothing here is composed - every figure is read from the same
// place the rest of the app reads it: the priced lines from
// lib/invoiceData.draftSourceFor, which is what composes the invoice, and the
// contract's balances from lib/agreements, which is what the coverage panel
// shows. A report that disagreed with either would be worse than no report.

import { readFile } from "node:fs/promises";
import path from "node:path";
import { desc, eq } from "drizzle-orm";
import { db } from "@/db";
import {
  agreements, assets, instruments, orgs, orgSites, parts, serviceReports, timeEntries, workOrders,
} from "@/db/schema";
import { countsAsVisit, drawdown } from "@/lib/agreements";
import { usageFor } from "@/lib/agreementUsage";
import { brandForTenant, type Brand } from "@/lib/brand";
import { draftSourceFor } from "@/lib/invoiceData";
import { shopToday } from "@/lib/shopday";
import { docContactLine } from "@/lib/xlsxDocData";
import { serviceReportDoc, unbilledTime, usd, type ReportItem } from "@/lib/serviceReportDoc";
import type { ServiceReport } from "@/lib/serviceReport";

export type ReportDraft = {
  report: ServiceReport;
  tenantOrgId: number | null;
  orgId: number | null;
  workOrderId: number;
  /** The job's rows this draft accounts for - stored with it when it is issued. */
  covers: ReportCovers;
  /** True when nothing on the job is left for a report to be about. */
  empty: boolean;
};

/** What one report accounted for. See db/schema.serviceReports.covers. */
export type ReportCovers = { timeIds: number[]; partIds: number[] };

const coversOf = (row: { covers: unknown }): ReportCovers => {
  const c = (row.covers ?? {}) as Partial<ReportCovers>;
  return { timeIds: c.timeIds ?? [], partIds: c.partIds ?? [] };
};

export type DraftOptions = {
  /**
   * Redrawing THIS report rather than composing a new one: its own rows are
   * its to keep, and only the other reports' are already spoken for.
   */
  forReportId?: number;
  /**
   * What the engineer wrote about this visit, where the job is still open and
   * so has no close-out yet. Blank falls back to the close-out.
   */
  visitNotes?: string;
};

/**
 * A count the way the original writes it: 5 is "05", 12 is "12". A client who
 * has used more visits than they bought has none left rather than minus one -
 * the overrun is the shop's to raise, and the balance line is not the place.
 */
const pad2 = (n: number): string => String(Math.max(0, n)).padStart(2, "0");

/**
 * The day the work happened.
 *
 * The last day somebody logged hours to the job, because that is the day the
 * client saw an engineer. Failing that the booking, and failing that the day
 * it was closed - a job with no hours on it was still finished on a date.
 */
export function visitDayOf(input: {
  hourDays: string[]; bookedUntil: string; bookedOn: string; closedOn: string; openedOn: string;
}): string {
  const days = input.hourDays.filter(Boolean).sort();
  return days[days.length - 1]
    || input.bookedUntil || input.bookedOn || input.closedOn || input.openedOn;
}

/**
 * Everything a report for this job would say, without writing anything.
 *
 * Composed fresh every time it is asked for, and frozen only when somebody
 * issues it - the same shape as a draft invoice, for the same reason: what a
 * person looked at and what gets written come from one piece of code.
 */
export async function serviceReportDraft(
  woId: number, opts: DraftOptions = {},
): Promise<ReportDraft | null> {
  const [wo] = await db.select().from(workOrders).where(eq(workOrders.id, woId));
  if (!wo) return null;

  /*
   * What is left to report on.
   *
   * Everything on the job, less whatever an earlier report already put its
   * name to. A job that takes three visits issues three reports, and each one
   * is about its own visit: repeating the first visit's hours on the second
   * page would tell a client they were worked twice. Redrawing an existing
   * report keeps that report's own rows, because they are the document.
   */
  const issued = await db.select().from(serviceReports).where(eq(serviceReports.workOrderId, woId));
  const spent = issued.filter((r) => r.id !== opts.forReportId).map(coversOf);
  const takenTime = new Set(spent.flatMap((c) => c.timeIds));
  const takenParts = new Set(spent.flatMap((c) => c.partIds));

  const [allHours, allParts] = await Promise.all([
    db.select({
      id: timeEntries.id, date: timeEntries.date, minutes: timeEntries.minutes,
      category: timeEntries.category, person: timeEntries.person, billable: timeEntries.billable,
    }).from(timeEntries).where(eq(timeEntries.workOrderId, woId)),
    db.select({ id: parts.id, name: parts.name, partNumber: parts.partNumber })
      .from(parts).where(eq(parts.workOrderId, woId)),
  ]);
  const hourRows = allHours.filter((h) => !takenTime.has(h.id));
  const mineParts = allParts.filter((p) => !takenParts.has(p.id));
  const covers: ReportCovers = {
    timeIds: hourRows.map((h) => h.id),
    partIds: mineParts.map((p) => p.id),
  };

  const src = await draftSourceFor(woId, { timeIds: covers.timeIds, partIds: covers.partIds });
  if (!src) return null;

  const [inst, asset, brand] = await Promise.all([
    wo.instrumentId === null ? Promise.resolve(null)
      : db.select().from(instruments).where(eq(instruments.id, wo.instrumentId)).then((r) => r[0] ?? null),
    wo.assetId === null ? Promise.resolve(null)
      : db.select().from(assets).where(eq(assets.id, wo.assetId)).then((r) => r[0] ?? null),
    brandForTenant(wo.tenantOrgId),
  ]);

  // Where the work was done, which is the address a service report carries -
  // not the address the invoice goes to. The billing address is the fallback
  // for a client whose site nobody has filled in.
  const [site, operatorOrg] = await Promise.all([
    inst?.siteId
      ? db.select().from(orgSites).where(eq(orgSites.id, inst.siteId)).then((r) => r[0] ?? null)
      : Promise.resolve(null),
    brand.operatorOrgId === null ? Promise.resolve(null)
      : db.select().from(orgs).where(eq(orgs.id, brand.operatorOrgId)).then((r) => r[0] ?? null),
  ]);

  // The agreement's own arithmetic, the same call the coverage panel makes.
  const agreement = src.coverage.agreementId === null ? null
    : await db.select().from(agreements).where(eq(agreements.id, src.coverage.agreementId)).then((r) => r[0] ?? null);
  const used = agreement && agreement.orgId !== null ? await usageFor(agreement, agreement.orgId) : null;
  const left = agreement && used ? drawdown(agreement, used) : null;

  const visits = left?.visits;
  const partsLeft = left?.parts;
  /*
   * This visit, counted.
   *
   * The drawdown counts CLOSED jobs, and the report is usually written from a
   * resolved one - the engineer has finished, the client has not yet agreed.
   * The document says what is left "upon completion of this service visit", so
   * the visit it is about is one of the ones spent, whether or not the job has
   * been closed yet. A question answered from the desk never counts, here or
   * in the drawdown.
   */
  const mine = countsAsVisit(wo) || wo.severity.trim().toLowerCase() === "question" ? 0 : 1;
  const contract = {
    visitNumber: used ? pad2(used.visits + mine) : "",
    visitsRemaining: !visits?.tracked ? "" : visits.unlimited ? "Unlimited" : pad2(visits.remaining - mine),
    partsRemaining: !partsLeft?.tracked ? "" : partsLeft.unlimited ? "Unlimited" : usd(partsLeft.remaining),
  };

  // Part numbers and names come off the parts themselves; the money comes off
  // the draft, so a report and its invoice cannot price the same part twice.
  const byId = new Map(mineParts.map((p) => [p.id, p]));
  const items: ReportItem[] = src.lines
    /*
     * What the visit put into the machine, and what it took to do it.
     *
     * Tax is settled on the invoice, and so are the shop's own costs of
     * getting there: a per diem, parking, a tank of fuel are an engineer's
     * expense claim, not something a client's signature page itemises. Both
     * still reach the invoice; neither reaches this document.
     */
    .filter((l) => !["tax", "fee_ref", "retainer", "expense"].includes(l.kind))
    .map((l) => {
      const part = l.kind === "part" && l.sourceId !== null ? byId.get(l.sourceId) : undefined;
      return {
        kind: l.kind,
        description: part ? part.name || l.description : l.description,
        partNumber: part?.partNumber ?? "",
        qty: l.qty, unitCents: l.unitCents, covered: l.covered,
      };
    });

  /*
   * And the hours nobody is charging for.
   *
   * The draft an invoice is built from carries the billable ones only -
   * rightly, since it is a bill. The report is not a bill: an hour under the
   * contract is the thing the contract bought, and a client who reads "1 h"
   * beside a day on their bench is being told something untrue. They price at
   * nothing and say why. See serviceReportDoc.unbilledTime.
   */
  items.push(...unbilledTime(
    hourRows,
    src.coverage.labor && !src.coverage.exhausted ? src.coverage.agreementNumber : "",
  ));

  const customer = src.org;
  /* The day the client saw an engineer, and the day the job was finished -
     which on an interim report is not a day yet. */
  const visitDay = visitDayOf({
    hourDays: hourRows.map((h) => h.date),
    bookedUntil: wo.bookedUntil, bookedOn: wo.bookedOn,
    closedOn: (wo.closedAt ?? wo.resolvedAt)?.toISOString().slice(0, 10) ?? "",
    openedOn: wo.openedOn,
  });
  const finishedOn = (wo.closedAt ?? wo.resolvedAt)?.toISOString().slice(0, 10) ?? "";

  const report = serviceReportDoc({
    // The number is minted when the report is ISSUED, not here: a draft nobody
    // sends must not burn one. See issueServiceReport.
    number: "",
    issuedOn: shopToday(),
    visitDay,
    job: {
      number: wo.number, title: wo.title, body: wo.body,
      requestedBy: wo.requestedBy, openedOn: wo.openedOn,
      /*
       * What was done, in the engineer's own words.
       *
       * The close-out where there is one, and what was typed for this visit
       * where the job is still open - a machine left running on a temporary
       * fix has a story worth signing for, and it is not the story of a job
       * nobody has finished. Dated to the visit for the same reason: an
       * interim report is about a day, not about a finish that has not
       * happened.
       */
      closeSummary: opts.visitNotes?.trim() || wo.closeSummary,
      closedOn: finishedOn || visitDay || shopToday(),
      engineer: wo.assignee || wo.closedBy,
      origin: wo.origin, severity: wo.severity,
      install: wo.restorationProjectId !== null,
    },
    provider: {
      name: brand.operatorName || brand.name,
      address: operatorOrg?.billingAddress ?? "",
      contact: docContactLine(brand),
    },
    customer: {
      name: customer?.name ?? "",
      address: site?.address || customer?.billingAddress || "",
      // Whoever signs for them: the person named on the job, or the person
      // who asked for it when nobody has named one.
      representative: wo.clientSignatory || wo.requestedBy,
    },
    /*
     * Which machine, and which part of it.
     *
     * A job on one unit of a system names the system as the instrument and the
     * unit as the module - "Thermo UPLC" / "Pump VF-P10" - and carries the
     * unit's own serial, because that is the serial somebody reads off the
     * thing that was worked on. A job on the whole system names its model
     * instead, and a job on a unit that hangs off no system is its own
     * instrument.
     */
    instrument: {
      // "Thermo UPLC", "Agilent 1290 Autosampler" - who made it and what it
      // is, which is how the original names the machine. The model number gets
      // its own row under it.
      type: inst
        ? [inst.manufacturer, inst.name || inst.category || inst.model].filter(Boolean).join(" ")
        : [asset?.manufacturer, asset?.kind].filter(Boolean).join(" "),
      model: (asset && inst ? "" : asset?.model) || inst?.model || "",
      serial: asset?.serial || inst?.serial || "",
      module: asset && inst ? [asset.kind, asset.model].filter(Boolean).join(" ") : "",
    },
    items,
    contract,
    partsTaxed: src.taxRateBps > 0,
    poNumber: src.org?.poNumber || src.coverage.agreementNumber,
  });

  return {
    report, tenantOrgId: wo.tenantOrgId, orgId: wo.orgId, workOrderId: woId, covers,
    /* Nothing new since the last report. A FIRST report with nothing logged is
       still worth issuing - the engineer's account of the visit is the point,
       and hours get logged late - but a second one carrying the same nothing
       is a duplicate of a document the client already has. */
    empty: issued.length > 0 && !covers.timeIds.length && !covers.partIds.length,
  };
}

/** The reports issued for one job, newest first. */
export async function reportsForJob(woId: number) {
  return db.select().from(serviceReports)
    .where(eq(serviceReports.workOrderId, woId))
    .orderBy(desc(serviceReports.id));
}

/** One issued report, as it was issued. */
export async function issuedReport(id: number): Promise<
  { row: typeof serviceReports.$inferSelect; report: ServiceReport } | null
> {
  const [row] = await db.select().from(serviceReports).where(eq(serviceReports.id, id));
  if (!row) return null;
  return { row, report: row.data as ServiceReport };
}

/**
 * The mark for page one.
 *
 * templates/ServiceReportLogo.png first - it sits beside the invoice and
 * quote workbooks because it is the same kind of thing, the shop's own
 * artwork on the shop's own paperwork, made for this page at this size. A
 * deployment without one falls back to the logo uploaded under the
 * operator's appearance, which was drawn for a 30px email header and may
 * not suit; and one with neither gets its name typed. Never another
 * company's mark.
 */
export async function reportLogo(brand: Pick<Brand, "operatorLogoUrl">): Promise<Uint8Array | undefined> {
  try {
    return new Uint8Array(await readFile(path.join(process.cwd(), "templates", "ServiceReportLogo.png")));
  } catch { /* no file shipped */ }
  if (brand.operatorLogoUrl) {
    try {
      const res = await fetch(brand.operatorLogoUrl);
      if (res.ok) return new Uint8Array(await res.arrayBuffer());
    } catch { /* an unreachable blob costs the mark, not the report */ }
  }
  return undefined;
}
