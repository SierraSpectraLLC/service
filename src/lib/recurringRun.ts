// The retainer pass.
//
// Once a day it asks every active agreement whether a cycle has come due, and
// raises a DRAFT for each one that has. Three disciplines, two of them
// borrowed from the dunning pass because they were learned the same way:
//
//   IT NEVER SENDS. Drafting is the automation. A $20,000 invoice leaving for
//   a client because a job fired overnight is a decision nobody made, so the
//   draft waits in /money for somebody to read and press send.
//
//   IT NEVER DOUBLE-BILLS. Every raise writes bill_last_on in the same breath
//   as the invoice, and raiseRetainerCycle refuses a cycle at or before it. A
//   pass that runs twice raises nothing the second time - by construction, not
//   by luck.
//
//   IT CATCHES UP. A pass that did not run for a week raises the cycles it
//   missed, oldest first, capped so a misconfigured contract cannot raise two
//   hundred drafts at once.
//
// A run that raises nothing is the normal outcome and is a success.

import { db } from "@/db";
import { agreements, orgs } from "@/db/schema";
import { shopDay } from "@/lib/shopday";
import { dueCycles, recurring } from "@/lib/recurring";
import { raiseRetainerCycle } from "@/app/actions";

export type RecurringResult = {
  raised: { agreement: string; org: string; on: string; invoice: string }[];
  failed: { agreement: string; on: string; error: string }[];
  /** Agreements that bill on a schedule but had nothing due today. */
  quiet: number;
};

export async function runRecurring(now = new Date()): Promise<RecurringResult> {
  const today = shopDay(now);
  const [rows, allOrgs] = await Promise.all([
    db.select().from(agreements),
    db.select({ id: orgs.id, name: orgs.name }).from(orgs),
  ]);
  const nameOf = new Map(allOrgs.map((o) => [o.id, o.name]));

  const out: RecurringResult = { raised: [], failed: [], quiet: 0 };
  for (const ag of rows) {
    if (!recurring(ag)) continue;
    const due = dueCycles(ag, today);
    if (!due.length) { out.quiet++; continue; }
    const label = ag.number || ag.title || `agreement ${ag.id}`;
    for (const on of due) {
      // Sequential on purpose: each raise moves the cursor the next one reads,
      // and the invoice numbers come from a scan of what already exists.
      const res = await raiseRetainerCycle(ag.id, on, "recurring billing");
      if (res.error) {
        out.failed.push({ agreement: label, on, error: res.error });
        // One bad cycle should not silently swallow the rest of the contract,
        // but a contract that is refusing is not one to keep hammering.
        break;
      }
      out.raised.push({ agreement: label, org: nameOf.get(ag.orgId) ?? "", on, invoice: res.number ?? "" });
    }
  }
  return out;
}
