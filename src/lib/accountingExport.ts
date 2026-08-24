// The rows an accountant's software will accept.
//
// Three files rather than one, because QuickBooks and Xero both import
// invoices, payments and fees as separate objects, and a single wide sheet is
// something a bookkeeper has to take apart by hand before they can use it.
//
// Money is written in DOLLARS here, not cents. It is the one place in the
// codebase that converts, and it converts at the very edge: every accounting
// package expects 1234.56, and handing one 123456 is a silent factor of a
// hundred that surfaces at the end of a quarter.
//
// Pure. Callers hand in the rows.

import { toCsv } from "@/lib/csv";

/** Cents to the string an accounting package expects. Never a float in maths. */
export const dollars = (cents: number): string => (cents / 100).toFixed(2);

export type ExportInvoice = {
  number: string;
  orgName: string;
  status: string;
  issuedOn: string;
  dueOn: string;
  poNumber: string;
  workOrder: string;
  lines: { kind: string; description: string; qty: number; unitCents: number; covered: boolean }[];
};

export type ExportPayment = {
  invoiceNumber: string;
  orgName: string;
  method: string;
  amountCents: number;
  reference: string;
  receivedOn: string;
};

export type ExportFee = {
  invoiceNumber: string;
  orgName: string;
  amountCents: number;
  basis: string;
  postedOn: string;
  waived: boolean;
  waivedReason: string;
};

/**
 * One row per LINE, with the invoice's own fields repeated - which is what
 * both packages' importers actually want, and what lets a bookkeeper map a
 * line kind to an income account.
 *
 * A covered line is exported at zero with its list price in its own column, so
 * the contract's value shows up in the books rather than vanishing.
 */
export function invoicesCsv(rows: ExportInvoice[]): string {
  const out: (string | number)[][] = [[
    "InvoiceNo", "Customer", "Status", "InvoiceDate", "DueDate", "PONumber",
    "WorkOrder", "LineType", "Description", "Quantity", "UnitAmount",
    "LineAmount", "CoveredByAgreement", "ListAmount",
  ]];
  for (const inv of rows) {
    for (const l of inv.lines) {
      const list = Math.round(l.qty * l.unitCents);
      out.push([
        inv.number, inv.orgName, inv.status, inv.issuedOn, inv.dueOn, inv.poNumber,
        inv.workOrder, l.kind, l.description, l.qty, dollars(l.unitCents),
        dollars(l.covered ? 0 : list), l.covered ? "yes" : "no", dollars(list),
      ]);
    }
  }
  return toCsv(out);
}

export function paymentsCsv(rows: ExportPayment[]): string {
  return toCsv([
    ["InvoiceNo", "Customer", "Method", "Amount", "Reference", "ReceivedDate"],
    ...rows.map((p) => [
      p.invoiceNumber, p.orgName, p.method, dollars(p.amountCents), p.reference, p.receivedOn,
    ]),
  ]);
}

/**
 * Waived fees are exported too, marked. A fee that was charged and then
 * forgiven is a real event in the relationship and in the books; dropping the
 * row would leave a bookkeeper reconciling a reminder nobody can explain.
 */
export function feesCsv(rows: ExportFee[]): string {
  return toCsv([
    ["InvoiceNo", "Customer", "Amount", "Basis", "PostedDate", "Waived", "WaivedReason"],
    ...rows.map((f) => [
      f.invoiceNumber, f.orgName, dollars(f.amountCents), f.basis, f.postedOn,
      f.waived ? "yes" : "no", f.waivedReason,
    ]),
  ]);
}

/** "invoices-2026-08.csv" - the name a bookkeeper can file without renaming. */
export const exportFileName = (what: string, month: string): string =>
  `${what}-${month}.csv`;

/** The months there is anything to export for, newest first. */
export function monthsWithActivity(dates: string[]): string[] {
  const months = new Set(dates.filter((d) => /^\d{4}-\d{2}/.test(d)).map((d) => d.slice(0, 7)));
  return [...months].sort().reverse();
}

/** Everything issued, paid or posted inside one YYYY-MM. */
export const inMonth = (date: string, month: string): boolean =>
  !!date && date.slice(0, 7) === month;
