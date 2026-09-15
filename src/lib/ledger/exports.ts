// The journal as a file: CSV for a spreadsheet, IIF for QuickBooks. Pure.
//
// Both are the ledger, row for row. A summary would be easier to read and
// impossible to check; the whole point of sending the journal is that every
// line can be traced back to a row on the Ledger page.

import type { LedgerEntry } from "@/lib/ledger/sums";

const csvCell = (s: string) => (/[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
const dollars = (cents: number) => (cents / 100).toFixed(2);

/** entry, date, memo, document, account, debit, credit - one row per posting line. */
export function ledgerCsv(rows: LedgerEntry[], name: (account: string) => string): string {
  const out = ["entry,date,memo,document,account,debit,credit"];
  for (const e of rows) {
    const doc = e.refType ? `${e.refType}:${e.refId}` : "";
    for (const l of e.lines) {
      out.push([String(e.id), e.postedOn, csvCell(e.memo), doc, csvCell(name(l.account)),
        l.debitCents ? dollars(l.debitCents) : "", l.creditCents ? dollars(l.creditCents) : ""].join(","));
    }
  }
  return out.join("\n") + "\n";
}

/** A QuickBooks IIF general journal: one TRNS/SPL block per entry. */
export function ledgerIif(rows: LedgerEntry[], name: (account: string) => string): string {
  const head = ["!TRNS\tTRNSTYPE\tDATE\tACCNT\tAMOUNT\tMEMO", "!SPL\tTRNSTYPE\tDATE\tACCNT\tAMOUNT\tMEMO", "!ENDTRNS"];
  const date = (on: string) => `${on.slice(5, 7)}/${on.slice(8, 10)}/${on.slice(0, 4)}`;
  const memo = (s: string) => s.replace(/[\t\n]/g, " ");
  const blocks = rows.map((e) => [
    ...e.lines.map((l, i) => `${i ? "SPL" : "TRNS"}\tGENERAL JOURNAL\t${date(e.postedOn)}\t${name(l.account)}\t${dollars(l.debitCents - l.creditCents)}\t${memo(e.memo)}`),
    "ENDTRNS",
  ].join("\n"));
  return [...head, ...blocks].join("\n") + "\n";
}
