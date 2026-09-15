// Cash on hand: the one number the owner actually asked for.
//
// "I would like there to be a nice great big number that says how much I have
// remaining." Every figure on the money side is a sum over rows the app
// wrote - what is owed, what was collected, what it cost - and not one of
// them is what is in the bank, because the app is not a bank feed. It cannot
// derive the balance. It CAN carry one forward: given what was in the account
// on a day, add what the app saw arrive since and subtract what it saw leave,
// and the answer is the balance to within whatever the app never sees.
//
// What it counts, and on what day:
//
//   + payments, on the day they were received (the same cash-basis rule
//     "Paid this period" uses);
//   - reimbursement claims, on the day they were marked paid;
//   - company-paid overhead - the standing bills, the hand-logged running
//     costs - on the day incurred. NOT a row somebody is to be reimbursed
//     for: that money leaves when the claim is paid, and counting it here
//     as well would take it out twice;
//   - payroll, at each month's end, from the register's in-force figure.
//     The register knows what a month costs, not the day the money moved,
//     so month end is the rule and the sub-line says so. A month whose end
//     has not come has not been paid.
//
// What it does not count, said out loud rather than hidden: purchase orders,
// which have no paid date in this app; anything paid outside it - a loan
// payment, the owner's draw, the bank's own fees. The figure is what the app
// knows, and the way to correct drift is to type today's balance in again -
// the older flows simply stop counting. Pure. Callers hand in the rows.

import { endOfMonth } from "@/lib/bills";
import { isDay } from "@/lib/recurring";

export type Flow = { on: string; cents: number };

export type CashInputs = {
  openingCents: number;
  /** Blank = never set; the answer is then absent, not zero. */
  openingOn: string;
  today: string;
  received: Flow[];
  reimbursed: Flow[];
  /** Company-paid overhead rows only - see the file note. */
  overhead: Flow[];
  /** "YYYY-MM" -> what the register says that month costs. */
  payrollByMonth: Record<string, number>;
};

export type CashOnHand = {
  cents: number;
  openingCents: number;
  openingOn: string;
  receivedCents: number;
  reimbursedCents: number;
  overheadCents: number;
  payrollCents: number;
  /** The months of payroll counted, oldest first. */
  payrollMonths: string[];
};

/** Rows on or after the opening day and on or before today. */
const inWindow = (f: Flow, from: string, to: string): boolean =>
  isDay(f.on) && f.on >= from && f.on <= to;

const sum = (rows: Flow[]) => rows.reduce((n, r) => n + r.cents, 0);

/**
 * Null when no opening balance has been set - the page then asks for one
 * rather than showing a zero that would read as "broke".
 */
export function cashOnHand(i: CashInputs): CashOnHand | null {
  if (!isDay(i.openingOn) || !isDay(i.today)) return null;
  const from = i.openingOn, to = i.today;
  const received = sum(i.received.filter((f) => inWindow(f, from, to)));
  const reimbursed = sum(i.reimbursed.filter((f) => inWindow(f, from, to)));
  const overhead = sum(i.overhead.filter((f) => inWindow(f, from, to)));

  // A month's wages leave at its end: counted once the month has ended, and
  // only if that end falls inside the window. The opening month is counted
  // if the balance was taken before its end, because the wages had not yet
  // gone out of the figure the owner typed.
  const payrollMonths = Object.keys(i.payrollByMonth)
    .filter((ym) => /^\d{4}-\d{2}$/.test(ym))
    .filter((ym) => {
      const end = endOfMonth(`${ym}-01`);
      return end >= from && end <= to && i.payrollByMonth[ym] > 0;
    })
    .sort();
  const payroll = payrollMonths.reduce((n, ym) => n + i.payrollByMonth[ym], 0);

  return {
    cents: i.openingCents + received - reimbursed - overhead - payroll,
    openingCents: i.openingCents, openingOn: i.openingOn,
    receivedCents: received, reimbursedCents: reimbursed, overheadCents: overhead,
    payrollCents: payroll, payrollMonths,
  };
}
