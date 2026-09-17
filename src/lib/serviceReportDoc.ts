// A finished job, as the service report the client is handed.
//
// lib/serviceReport draws the document; this decides what it says. The split is
// the same one lib/proposal and lib/pdfRender make, and for the same reason:
// the wording and the arithmetic are worth arguing about in a test, and a
// renderer with a database behind it cannot be.
//
// What the report IS, in the shop's own words: "what was asked, what was found,
// what was fitted, and what the contract just paid for." It is not an invoice
// and says so on its face - which is why every line prints at its real price
// and the covered ones are taken off again at the bottom, as an adjustment. A
// client reading it can see what the agreement absorbed, which is the whole
// argument for having bought one.
//
// Pure. The loader hands in the rows.

import type { ReportLine, ServiceReport } from "@/lib/serviceReport";

/** The job, as the report needs it. Every field is a column on work_orders. */
export type JobFacts = {
  number: string;
  /** What was done, in the line the shop gave the job: "Repair on Pump B". */
  title: string;
  /** The ask, in the requester's own words. */
  body: string;
  requestedBy: string;
  openedOn: string;
  /** What was done, written to close it - the engineer's notes. */
  closeSummary: string;
  /** The day the job was closed, YYYY-MM-DD. */
  closedOn: string;
  /** Who did the work: the assignee, or whoever closed it. */
  engineer: string;
  /** '' | issue | pm_request | checkout - see work_orders.origin. */
  origin: string;
  severity: string;
  /** A commission or restoration job installs something. */
  install: boolean;
};

/** One priced row, as lib/billing composed it for this job. */
export type ReportItem = {
  /** part | labor | travel | expense - lib/billing.LINE_KINDS. */
  kind: string;
  description: string;
  partNumber: string;
  /** Real units: 4.5 hours is 4.5. */
  qty: number;
  unitCents: number;
  /** The agreement answers for it. It prints at price and comes off below. */
  covered: boolean;
};

export type ReportInput = {
  /** The report's own number - 030182_SR6. */
  number: string;
  /** The day it is issued, YYYY-MM-DD. */
  issuedOn: string;
  /** The day on site, YYYY-MM-DD. */
  visitDay: string;
  job: JobFacts;
  provider: { name: string; address: string; contact: string };
  customer: { name: string; address: string; representative: string };
  instrument: { type: string; model: string; serial: string; module: string };
  items: ReportItem[];
  /**
   * The contract's own figures, already worked out by lib/agreements: which
   * visit of the term this was, and what is left after it. Blank where no
   * agreement covers the work, which prints as a dash.
   */
  contract: { visitNumber: string; visitsRemaining: string; partsRemaining: string };
  /** Whether this site's parts are taxed. Services never are - see taxExempt. */
  partsTaxed: boolean;
  /** The PO the client is paying against, or the agreement's number. */
  poNumber: string;
};

/** "$3,831.95". The report prints money to the cent, always. */
export const usd = (cents: number): string =>
  `$${(cents / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/**
 * What kind of visit this was, in the three words the shop's own dropdown
 * offers plus the one it needs for work nobody drove to.
 *
 * Read off the job rather than typed again: a PM was asked for as a PM, an
 * install is a commission, and a question answered from the desk was not a
 * repair. Anything else is a repair, which is what most jobs are.
 */
export function serviceTypeOf(job: Pick<JobFacts, "origin" | "severity" | "install">): string {
  if (job.install) return "Install";
  if (job.origin === "pm_request") return "PM";
  if (job.severity.trim().toLowerCase() === "question") return "Support";
  return "Repair";
}

/**
 * An address as the block prints it: up to four lines, blank ones dropped.
 * Typed with newlines usually, commas sometimes; both are honoured so a shop
 * that keeps one-line addresses still gets a readable block.
 */
export function addressLines(address: string, max = 4): string[] {
  const raw = address.includes("\n") ? address.split("\n") : address.split(/,(?=[^,]*$)/);
  return raw.map((l) => l.trim()).filter(Boolean).slice(0, max);
}

/** "Monday, October 13, 2025" - the long form the visit line is written in. */
export function longVisitDate(day: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day.trim());
  if (!m) return day.trim();
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  return d.toLocaleDateString("en-US", {
    weekday: "long", month: "long", day: "numeric", year: "numeric", timeZone: "UTC",
  });
}

/**
 * A priced row as a table row.
 *
 * Tax exempt is the column the original carries and it means what it says: the
 * line was not taxed. Labour and travel never are here - the app taxes parts
 * only, at the site's rate (lib/billing.buildInvoiceLines) - so the mark is
 * true for every service line and for parts wherever that site has no tax.
 */
const asLine = (it: ReportItem, taxed: boolean): ReportLine => ({
  description: it.description,
  partNumber: it.partNumber,
  quantity: it.qty,
  unitCents: it.unitCents,
  taxExempt: !taxed,
});

const sum = (items: ReportItem[]): number =>
  items.reduce((n, it) => n + Math.round(it.qty * it.unitCents), 0);

/**
 * The report, assembled.
 *
 * The money rule, stated once: every line prints at its real price, and what
 * the agreement covers is subtracted at the bottom as an Adjustment. So a
 * contract visit shows three thousand dollars of parts, three thousand dollars
 * of adjustment, and nothing due - which is the sentence the client's
 * purchasing desk needs to read, and the reason the original prints a total
 * column on a document that bills nobody.
 */
export function serviceReportDoc(input: ReportInput): ServiceReport {
  const parts = input.items.filter((it) => it.kind === "part");
  // Travel and the expenses of travelling sit with labour, the way the
  // original's second table is titled.
  const labor = input.items.filter((it) => ["labor", "travel", "expense"].includes(it.kind));
  const covered = input.items.filter((it) => it.covered);

  return {
    reportNumber: input.number,
    date: input.issuedOn,
    visitDate: longVisitDate(input.visitDay),
    serviceType: serviceTypeOf(input.job),
    visitNumber: input.contract.visitNumber,
    engineer: input.job.engineer,
    provider: { name: input.provider.name, lines: addressLines(input.provider.address) },
    customer: { name: input.customer.name, lines: addressLines(input.customer.address) },
    instrument: {
      type: input.instrument.type, model: input.instrument.model,
      serial: input.instrument.serial, module: input.instrument.module,
    },
    workCompleted: input.job.title,
    poNumber: input.poNumber,
    request: {
      date: input.job.openedOn,
      from: input.job.requestedBy,
      text: input.job.body,
    },
    // What was done, as it was written to close the job. A report with nothing
    // in this block is the one thing this document must never be, which is why
    // the action refuses to issue one - see issueServiceReport.
    notes: { date: input.job.closedOn, body: input.job.closeSummary },
    // Nothing in the app records a calibrated tool against a visit yet, so the
    // table prints its empty rows and somebody writes in them. It is in the
    // type because the original has the block, and the day tools are tracked
    // the loader fills it rather than the layout changing.
    calibration: [],
    parts: parts.map((it) => asLine(it, input.partsTaxed)),
    labor: labor.map((it) => asLine(it, false)),
    balances: {
      visitsRemaining: input.contract.visitsRemaining,
      partsRemaining: input.contract.partsRemaining,
      // Page one's figure is this visit's parts, which is what the shop's own
      // sheet computes there. Tax is not on it: the report is not an invoice
      // and settles nothing, and the invoice is where a tax line is drawn.
      partsTotal: usd(sum(parts)),
    },
    // Nothing covered is zero, not minus zero: the figure is stored with the
    // report and read back by the renderer, and "-$0.00" is not a thing.
    adjustmentCents: covered.length ? -sum(covered) : 0,
    signatures: {
      providerName: input.job.engineer,
      customerName: input.customer.representative,
      customerOrg: input.customer.name,
      providerOrg: input.provider.name,
    },
    contact: input.provider.contact,
  };
}
