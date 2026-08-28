// An expense report, as the thing you send an accountant.
//
// What a bookkeeper needs from a reimbursement is not what the desk shows. The
// desk answers "where is my money"; the bookkeeper answers "what account does
// this go to, was it substantiated, and can I see the paper". So the export is
// ONE ROW PER EXPENSE with the claim's own fields repeated on each - the same
// shape lib/accountingExport uses for invoice lines, and for the same reason:
// a sheet where the identifying columns only appear on the first row of each
// group is a sheet somebody has to take apart by hand before they can sort it.
//
// Money is written in DOLLARS. Same rule and same edge as accountingExport:
// every accounting package expects 1234.56, and handing one 123456 is a silent
// factor of a hundred that surfaces at the end of a quarter.
//
// Pure. Callers hand in the rows.

import { toCsv } from "@/lib/csv";
import { dollars } from "@/lib/accountingExport";

export type ExportExpense = {
  incurredOn: string;
  kind: string;
  description: string;
  amountCents: number;
  billable: boolean;
  workOrderNumber: string;
  siteName: string;
  receiptName: string;
  /** What the travel rulebook made of it, and who signed a flagged one. */
  allowanceState: string;
  allowanceNote: string;
  allowanceBy: string;
};

export type ExportReport = {
  id: number;
  title: string;
  person: string;
  purpose: string;
  status: string;
  workOrderNumber: string;
  openedBy: string;
  submittedOn: string;
  paidOn: string;
  paidRef: string;
  expenses: ExportExpense[];
};

const HEADERS = [
  "Report", "Report ID", "Person", "Status", "Job", "Purpose",
  "Opened by", "Submitted on", "Paid on", "Paid reference",
  "Expense date", "Category", "Description", "Amount", "Rebillable",
  "Expense job", "Site", "Receipt file", "Policy", "Policy note", "Approved by",
];

/**
 * Whether a claim carries paper, in the word a reviewer uses.
 *
 * "Missing" rather than an empty cell, because an empty cell in a spreadsheet
 * reads as "nobody filled this column in" and this one means "there is no
 * receipt for this money" - which is the single thing an auditor sorts on.
 */
export const receiptCell = (name: string): string => name.trim() || "MISSING";

/** The rules column, collapsed to something sortable. */
export const policyCell = (state: string): string =>
  state === "flagged" ? "Needs approval"
    : state === "approved" ? "Approved"
    : "Within policy";

/** One row per expense, the claim's fields repeated on each. */
export function reportRows(reports: ExportReport[]): (string | number)[][] {
  const rows: (string | number)[][] = [HEADERS];
  for (const r of reports) {
    // A claim with no rows still gets a line. An empty report is a fact - it
    // is how a draft that was never filled shows up in a month's export -
    // and dropping it makes the export disagree with the desk about how many
    // claims exist.
    const list: (ExportExpense | null)[] = r.expenses.length ? r.expenses : [null];
    for (const e of list) {
      rows.push([
        r.title, r.id, r.person, r.status, r.workOrderNumber, r.purpose,
        r.openedBy, r.submittedOn, r.paidOn, r.paidRef,
        e?.incurredOn ?? "", e?.kind ?? "", e?.description ?? "",
        e ? dollars(e.amountCents) : "",
        e ? (e.billable ? "yes" : "no") : "",
        e?.workOrderNumber ?? "", e?.siteName ?? "",
        e ? receiptCell(e.receiptName) : "",
        e ? policyCell(e.allowanceState) : "",
        e?.allowanceNote ?? "", e?.allowanceBy ?? "",
      ]);
    }
  }
  return rows;
}

export const reportsCsv = (reports: ExportReport[]): string => toCsv(reportRows(reports));

/** What a report comes to, for the summary line and the PDF total. */
export const reportCents = (r: ExportReport): number =>
  r.expenses.reduce((n, e) => n + e.amountCents, 0);

/**
 * The name a receipt gets inside the packet.
 *
 * Numbered in the report's own row order and prefixed with the date, so the
 * archive sorts the way the sheet reads and the "Receipt file" column can be
 * matched by eye. Everything else is squeezed out: an accountant unzipping
 * forty receipts should not meet `IMG_0421 (2).HEIC` twice.
 */
export function packetName(index: number, e: ExportExpense): string {
  const n = String(index + 1).padStart(2, "0");
  const ext = (/\.([a-z0-9]{1,5})$/i.exec(e.receiptName)?.[1] ?? "jpg").toLowerCase();
  const stem = `${e.kind}-${e.description}`
    .toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40)
    || "receipt";
  return `${n}-${e.incurredOn || "undated"}-${stem}.${ext}`;
}

/** `reimbursements-2026-08.csv`, `expense-report-14.csv`. */
export const exportName = (what: string, ext: string): string =>
  `${what.replace(/[^A-Za-z0-9-]+/g, "-").replace(/^-|-$/g, "").toLowerCase() || "export"}.${ext}`;

/**
 * A short line for the top of the PDF and the packet's README.
 *
 * Deliberately not the status word on its own: "paid" without the date and the
 * check number is the half of the answer that prompts the phone call.
 */
export function reportStanding(r: ExportReport): string {
  if (r.status === "paid") {
    return `Paid ${r.paidOn}${r.paidRef ? ` (${r.paidRef})` : ""}`;
  }
  if (r.status === "submitted") return `Awaiting payout${r.submittedOn ? `, submitted ${r.submittedOn}` : ""}`;
  if (r.status === "returned") return "Returned to the claimant";
  return "Draft - not yet submitted";
}
