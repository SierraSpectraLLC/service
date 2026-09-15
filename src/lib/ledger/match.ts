// Reconciliation: what a bank line could be.
//
// Reconciled means every bank line has an entry and every cash entry has a
// bank line. The difference between what the books say and what the bank
// says is not a rounding error to absorb; it is the list this file makes.
// Three suggestions, in order of confidence:
//   (a) an unmatched, live cash entry of the same signed amount within a week
//       - the check that finally cleared, the autopay we already posted;
//   (b) a credit equal to an open invoice's balance - the client paid and
//       nobody recorded it;
//   (c) nothing: post it as one of the four cost accounts, or as other income.
// Pure. The loader hands in rows; the actions write.

import type { AccountKey } from "@/lib/ledger/accounts";

export type BankLine = { id: number; on: string; description: string; amountCents: number; matchedEntryId: number | null };
export type CashEntry = { id: number; on: string; memo: string; bankCents: number; matched: boolean; refType: string };
export type OpenInvoice = { id: number; number: string; balanceCents: number; orgId: number };

export type Suggestion =
  | { kind: "entry"; entryId: number; memo: string; on: string }
  | { kind: "invoice"; invoiceId: number; number: string }
  | { kind: "post"; accounts: AccountKey[] }
  | { kind: "income" };

export const MATCH_WINDOW_DAYS = 7;

/** The four places money out can go when nothing on the books explains it. */
export const POST_AS: { account: AccountKey; label: string }[] = [
  { account: "overhead", label: "Overhead" },
  { account: "cost_field_expenses", label: "Field expense" },
  { account: "cost_parts", label: "Parts cost" },
  { account: "cost_processing", label: "Bank or processing fee" },
];

const days = (a: string, b: string) => Math.abs(Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400000));

/** The candidates for one bank line, best first. */
export function suggestFor(line: BankLine, entries: CashEntry[], invoices: OpenInvoice[]): Suggestion[] {
  const out: Suggestion[] = [];
  for (const e of entries) {
    if (e.matched || e.refType === "opening") continue;
    if (e.bankCents !== line.amountCents) continue;
    if (days(e.on, line.on) > MATCH_WINDOW_DAYS) continue;
    out.push({ kind: "entry", entryId: e.id, memo: e.memo, on: e.on });
  }
  if (out.length) return out;
  if (line.amountCents > 0) {
    for (const i of invoices) if (i.balanceCents === line.amountCents) out.push({ kind: "invoice", invoiceId: i.id, number: i.number });
    if (out.length) return out;
    return [{ kind: "income" }];
  }
  return [{ kind: "post", accounts: POST_AS.map((p) => p.account) }];
}

/** A bank description made readable: "SHELL OIL 57210 FRESNO CA" -> "Shell Oil". */
export function memoFromDescription(desc: string): string {
  const words = desc.replace(/\s\d.*$/, "").toLowerCase().split(/\s+/).filter(Boolean);
  return words.map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ") || desc;
}

/** The statement balance is the feed's sum plus what was in the account before the feed began. */
export function bankBalance(lines: { amountCents: number }[], openingCents: number): number {
  return openingCents + lines.reduce((n, l) => n + l.amountCents, 0);
}
