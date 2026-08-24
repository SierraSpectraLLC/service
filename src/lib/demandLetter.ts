// The letter, assembled from rows that already exist.
//
// Every sentence in it cites something on the record: the send log, the view
// receipts off the share link, the promise somebody made on the phone, the fee
// and its basis, the signed service report. That is the whole reason it is
// generated rather than typed - a demand letter is a document that may be read
// by somebody's lawyer, and a letter whose claims cannot be traced to rows is
// a letter that should not have been sent.
//
// Pure. The route hands in the rows.

import { formatCents } from "@/lib/money";
import type { BillingPolicy } from "@/lib/billingPolicy";

export type LetterInput = {
  operatorName: string;
  operatorLine: string;          // "Instrument service - Northern California"
  today: string;                 // YYYY-MM-DD
  clientName: string;
  clientPlace: string;
  /** Who it is addressed to - the escalation contact for this rung. */
  toName: string;
  toRole: string;
  invoiceNumber: string;
  workOrderNumber: string;
  workDescription: string;
  issuedOn: string;
  dueOn: string;
  poNumber: string;
  daysLate: number;
  payableCents: number;
  feeCents: number;
  feeBasis: string;
  /** Reminders and statements already sent, from dunning_events. */
  remindersSent: number;
  statementsSent: number;
  /** From the share link's open event - the only view signal there is. */
  firstViewedOn: string;
  promise: { byName: string; promisedOn: string } | null;
  onHold: boolean;
  policy: BillingPolicy;
  /** The day payment is demanded by, and the day it is referred. */
  remitBy: string;
  referOn: string;
  /** Signed sign-off, statement, prior notices - what rides with it. */
  exhibits: string[];
};

/** "August 22, 2026" - a letter dates itself in words. */
export function longDate(iso: string): string {
  const t = Date.parse(`${iso}T12:00:00Z`);
  if (!Number.isFinite(t)) return iso;
  return new Date(t).toLocaleDateString("en-US", {
    month: "long", day: "numeric", year: "numeric", timeZone: "UTC",
  });
}

export type LetterBlock = { kind: "head" | "para" | "list"; text: string; items?: string[] };

/**
 * The letter as blocks, so the print route and any future PDF assembler render
 * the same words. Sentences are dropped rather than fudged when the row behind
 * them is missing: a letter that claims three reminders when two were sent is
 * worse than one that claims two.
 */
export function demandLetter(i: LetterInput): LetterBlock[] {
  const total = i.payableCents + i.feeCents;
  const blocks: LetterBlock[] = [];

  blocks.push({ kind: "head", text: `Final notice - ${formatCents(total)} past due ${i.daysLate} days` });

  const sentence1 = `Invoice ${i.invoiceNumber}`
    + (i.workDescription ? ` for the ${i.workDescription}` : "")
    + (i.issuedOn ? ` was issued ${longDate(i.issuedOn)}` : " was issued")
    + (i.poNumber ? ` under ${i.poNumber}` : "")
    + (i.dueOn ? ` and was due ${longDate(i.dueOn)}.` : ".");
  blocks.push({ kind: "para", text: sentence1 });

  const record: string[] = [];
  if (i.firstViewedOn) record.push(`It was opened ${longDate(i.firstViewedOn)}`);
  if (i.remindersSent > 0) {
    record.push(`we have since sent ${i.remindersSent} reminder${i.remindersSent === 1 ? "" : "s"}`);
  }
  if (i.statementsSent > 0) {
    record.push(`${i.statementsSent} statement${i.statementsSent === 1 ? "" : "s"}`);
  }
  if (i.promise) {
    record.push(`and on ${longDate(i.promise.promisedOn)} ${i.promise.byName} committed to a payment that has not arrived`);
  }
  if (record.length) {
    // The first clause leads the sentence, so it is capitalised wherever it
    // came from: with no view receipt on file the paragraph starts at "We have
    // since sent...", and a letter that starts a sentence in lower case is a
    // letter that reads as generated.
    const joined = record.join(", ");
    blocks.push({ kind: "para", text: `${joined.charAt(0).toUpperCase()}${joined.slice(1)}.` });
  }

  if (i.feeCents > 0) {
    blocks.push({
      kind: "para",
      // The stored basis is a sentence and ends in a full stop; the clause
      // here continues, so the stop comes off rather than doubling up.
      text: `Per the terms on the invoice, ${(i.feeBasis || "a late charge applies").replace(/\.\s*$/, "")}`
        + `; ${formatCents(i.feeCents)} has been assessed.`
        + (i.onHold ? ` New service for ${i.clientName} is on credit hold until the balance clears.` : ""),
    });
  } else if (i.onHold) {
    blocks.push({
      kind: "para",
      text: `New service for ${i.clientName} is on credit hold until the balance clears.`,
    });
  }

  blocks.push({
    kind: "para",
    text: `Please remit ${formatCents(total)} by ${longDate(i.remitBy)} by ACH or by check referencing `
      + `${i.invoiceNumber}. If any line is in dispute, reply and we will pause that line while the rest `
      + `remains due. Absent payment or a reply, we refer the account for collection on ${longDate(i.referOn)}.`,
  });

  if (i.exhibits.length) {
    blocks.push({ kind: "list", text: "Exhibits", items: i.exhibits });
  }
  return blocks;
}

/** What rides with the letter, named from what actually exists. */
export function exhibitsFor(i: {
  invoiceNumber: string;
  workOrderNumber: string;
  signedOff: boolean;
  noticesSent: number;
}): string[] {
  return [
    `invoice ${i.invoiceNumber}`,
    i.signedOff && i.workOrderNumber ? `signed service report ${i.workOrderNumber}` : "",
    "statement of account",
    i.noticesSent > 0 ? `prior notices (${i.noticesSent})` : "",
  ].filter(Boolean);
}
