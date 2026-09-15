// The bills pass.
//
// Once a day it asks every live standing bill whether a cycle has come due,
// and writes an overhead expense for each one that has. The three disciplines
// are lib/stipendRun's, learned there:
//
//   IT NEVER POSTS TWICE. Every post writes bills.last_on in the same breath
//   as the expense row, and dueBillCycles refuses a cycle at or before it. A
//   pass that runs twice writes nothing the second time - by construction.
//   bill_id on the row is the second belt.
//
//   IT CATCHES UP. A pass that missed a week posts what it missed, oldest
//   first, capped - a ledger should not read low because a cron had a bad
//   Tuesday, and a bill misconfigured to start in 2014 should not write a
//   hundred rows overnight.
//
//   A RUN THAT POSTS NOTHING IS THE NORMAL OUTCOME and is a success.
//
// WHERE IT DIFFERS FROM THE STIPEND PASS. A stipend lands on a person's claim
// and waits for an owner to pay it, because it is money moving TOWARDS a
// person. A bill posts straight to the ledger as a fact: the money left, or
// is about to, whether or not anybody clicks anything - the owner's own call,
// because half of these are autopay and a ledger that waited for a click
// would read low every month by exactly the bills nobody clicked. What the
// pass writes is the row "Log an overhead expense" would have written by
// hand: no work order, not billable, dated the cycle day.
//
// postBill is exported on its own so setting a bill up can post what is
// already due in the same action - "starting this month" should show on the
// ledger now, not at one o'clock tomorrow.

import { eq } from "drizzle-orm";
import { db } from "@/db";
import { bills, expenses } from "@/db/schema";
import { shopDay } from "@/lib/shopday";
import { billDescription, billLive, dueBillCycles } from "@/lib/bills";

export type BillResult = {
  posted: { bill: number; name: string; on: string; amountCents: number }[];
  failed: { bill: number; name: string; on: string; error: string }[];
  /** Bills that are live but had nothing due today. */
  quiet: number;
};

type BillRow = typeof bills.$inferSelect;

/** Post every cycle this one bill owes up to `today`. */
export async function postBill(b: BillRow, today: string, out: BillResult): Promise<void> {
  if (!billLive(b)) return;
  const due = dueBillCycles(b, today);
  if (!due.length) { out.quiet++; return; }
  for (const on of due) {
    try {
      await db.insert(expenses).values({
        tenantOrgId: b.tenantOrgId,
        workOrderId: null,
        kind: b.kind,
        description: billDescription(b.name, on, b.cadence),
        amountCents: b.amountCents,
        incurredOn: on,
        // Nobody's client pays for our liability policy.
        billable: false,
        // A benefit is somebody's, on the record, but nobody is reimbursed for
        // it: the carrier was paid. So the name is not on the row - that
        // column means "who gets the money back", and here nobody does.
        person: "",
        loggedBy: "",
        billId: b.id,
      });
      /* The cursor moves in the same breath as the row - see stipendRun. */
      await db.update(bills).set({ lastOn: on }).where(eq(bills.id, b.id));
      out.posted.push({ bill: b.id, name: b.name, on, amountCents: b.amountCents });
    } catch (e) {
      out.failed.push({ bill: b.id, name: b.name, on, error: (e as Error).message });
      break;
    }
  }
}

export async function runBills(now = new Date()): Promise<BillResult> {
  const today = shopDay(now);
  const rows = await db.select().from(bills);
  const out: BillResult = { posted: [], failed: [], quiet: 0 };
  for (const b of rows) await postBill(b, today, out);
  return out;
}
