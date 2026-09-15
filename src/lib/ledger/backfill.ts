// The ledger, derived from the rows that were there before it existed.
//
// Idempotent, and by the same mechanism every action is: each posting has a
// key, and post() returns the entry that already carries it rather than
// writing a second. So this can run on a fresh instance, again after a
// deploy, again tomorrow, and again after the dual-writing actions have been
// posting for a month - and the ledger reads the same each time. It calls the
// same lib/ledger/postings functions the actions call, so "what does sending
// an invoice post" has one answer whether the invoice was sent yesterday
// through the button or last March before there was a ledger.
//
// What it reads, in the order money happened:
//   opening balance         orgs.cash_opening_*
//   invoices                issued_on, every status but draft and void
//   payments                on received_on; a Stripe-recorded one lands in Stripe
//   fees and waivers        posted_on; waived_on (or the fee's day, for old rows)
//   credits                 resolved disputes' credit memo lines
//   expense reports         paid_on, against the job or the report's client
//   company-paid expenses   incurred_on: overhead, or the job's field cost
//   bills                   each posted cycle, on its day
//   payroll                 one run per ended month since the opening, from the register
//   purchase orders         received lines, to the price agreed; paid ones
//   referral fees           what the payer has paid
//
// Rows with no tenant stamp belong to the instance's operator (the platform's
// own shop wrote them before stamps were everywhere).

import { and, asc, eq, like, sql } from "drizzle-orm";
import { db } from "@/db";
import {
  appSettings, bills, disputes, expenseReports, expenses, invoiceFees, invoiceLines, invoices,
  ledgerEntries, ledgerLines, orgs, payments, payroll, payrollRuns, poLines, purchaseOrders,
  quotes, referralFees, workOrders,
} from "@/db/schema";
import { post, setPostSink, type PostInput } from "@/lib/ledger/post";
import {
  companyPaid, isDepositOffset, postBillCycle, postDisputeCredit, postExpenseLogged, postFeeWaived,
  postInvoiceFee, postInvoicePayment, postInvoiceSent, postOpening, postPayrollRun, postPoPaid,
  postReferralPaid, postReportPaid,
} from "@/lib/ledger/postings";
import { payrollForMonth, type PayRow } from "@/lib/payroll";
import { endOfMonth } from "@/lib/bills";

export type BackfillResult = {
  /** Entries this run wrote (or, dry, would have). */
  created: number;
  /** Postings that were already there. */
  existing: number;
  /** Rows that could not be posted, with why. */
  skipped: { what: string; why: string }[];
  /** In a dry run, everything it would have written. */
  planned: { key: string; on: string; memo: string; lines: PostInput["lines"]; tenantOrgId: number | null }[];
};

type Options = {
  today: string;
  dryRun?: boolean;
  /** Restrict to one workspace; every operator otherwise. */
  tenantOrgId?: number | null;
  log?: (line: string) => void;
};

const YM = (day: string) => day.slice(0, 7);

export async function backfillLedger(opts: Options): Promise<BackfillResult> {
  const out: BackfillResult = { created: 0, existing: 0, skipped: [], planned: [] };
  const log = opts.log ?? (() => {});
  const [settings] = await db.select().from(appSettings).where(eq(appSettings.id, 1));
  const fallback = settings?.operatorOrgId ?? null;
  const stamp = <T extends { tenantOrgId: number | null }>(row: T): T =>
    row.tenantOrgId === null && fallback !== null ? { ...row, tenantOrgId: fallback } : row;
  const mine = (t: number | null) =>
    opts.tenantOrgId === undefined || (t ?? fallback) === opts.tenantOrgId;

  if (opts.dryRun) {
    setPostSink((input, key) => out.planned.push({
      key, on: input.on, memo: input.memo, lines: input.lines, tenantOrgId: input.tenantOrgId,
    }));
  }
  const count = (p: { created: boolean } | null) => { if (p) { if (p.created) out.created++; else out.existing++; } };
  const by = "backfill";

  try {
    // ── Opening balances ─────────────────────────────────────────────────
    const operators = await db.select().from(orgs).where(eq(orgs.isOperator, true));
    for (const org of operators) {
      if (!mine(org.id) || !org.cashOpeningOn) continue;
      count(await postOpening({ tenantOrgId: org.id, cents: org.cashOpeningCents, on: org.cashOpeningOn, by, ignoreClose: true }));
    }

    // ── Invoices, payments, fees, credits ────────────────────────────────
    const invRows = (await db.select().from(invoices).orderBy(asc(invoices.id))).map(stamp).filter((i) => mine(i.tenantOrgId));
    const invIds = new Set(invRows.map((i) => i.id));
    const [lineRows, payRows, feeRows, disputeRows, depositQuotes] = await Promise.all([
      db.select().from(invoiceLines).orderBy(asc(invoiceLines.position), asc(invoiceLines.id)),
      db.select().from(payments).orderBy(asc(payments.id)),
      db.select().from(invoiceFees).orderBy(asc(invoiceFees.id)),
      db.select().from(disputes).where(eq(disputes.resolution, "credited")),
      db.select({ number: quotes.number, invoiceId: quotes.depositInvoiceId }).from(quotes).where(sql`${quotes.depositInvoiceId} is not null`),
    ]);
    const depositFor = new Map(depositQuotes.map((q) => [q.invoiceId as number, q.number]));
    const linesOf = new Map<number, typeof lineRows>();
    for (const l of lineRows) { if (invIds.has(l.invoiceId)) (linesOf.get(l.invoiceId) ?? linesOf.set(l.invoiceId, []).get(l.invoiceId)!).push(l); }

    for (const inv of invRows) {
      if (inv.status === "draft" || inv.status === "void") continue;
      if (!inv.issuedOn) { out.skipped.push({ what: inv.number, why: "sent but has no issued_on" }); continue; }
      const lines = linesOf.get(inv.id) ?? [];
      // A credit memo written AFTER the send is its own posting (below); one
      // written while the invoice was still a draft rode in the send, exactly
      // as the live resolveDispute does it.
      const laterCredits = new Set(disputeRows
        .filter((d) => d.invoiceId === inv.id && d.resolvedOn && d.resolvedOn >= inv.issuedOn && d.lineId !== null)
        .map((d) => d.lineId as number));
      const sendLines = lines.filter((l) => !(l.kind === "fee_ref" && l.unitCents < 0 && l.sourceId !== null && laterCredits.has(l.sourceId)));
      count(await postInvoiceSent({ inv, lines: sendLines, depositFor: depositFor.get(inv.id) ?? null, by, ignoreClose: true }));
    }
    for (const p of payRows) {
      const inv = invRows.find((i) => i.id === p.invoiceId);
      if (!inv || inv.status === "void") continue;
      count(await postInvoicePayment({ inv, payment: stamp(p), by: p.recordedBy || by, ignoreClose: true }));
    }
    for (const f of feeRows) {
      const inv = invRows.find((i) => i.id === f.invoiceId);
      if (!inv || inv.status === "void") continue;
      const fee = stamp(f);
      count(await postInvoiceFee({ inv, fee, ignoreClose: true }));
      if (fee.waived) {
        count(await postFeeWaived({ inv, fee, on: fee.waivedOn || fee.postedOn, by: fee.waivedBy || by, ignoreClose: true }));
      }
    }
    for (const d of disputeRows) {
      const inv = invRows.find((i) => i.id === d.invoiceId);
      if (!inv || inv.status === "void" || inv.status === "draft" || d.lineId === null || !d.resolvedOn) continue;
      if (d.resolvedOn < inv.issuedOn) continue;   // rode in the send
      const original = lineRows.find((l) => l.id === d.lineId);
      const credit = lineRows.find((l) => l.invoiceId === inv.id && l.sourceId === d.lineId && l.unitCents < 0 && l.kind === "fee_ref");
      if (!original || !credit) { out.skipped.push({ what: `${inv.number} dispute ${d.id}`, why: "credited, but no credit memo line found" }); continue; }
      count(await postDisputeCredit({
        inv, disputeId: d.id, creditedKind: original.kind,
        cents: -Math.round((credit.qty / 1000) * credit.unitCents), on: d.resolvedOn, by: d.resolvedBy || by, ignoreClose: true,
      }));
    }

    // ── Expense reports, company-paid expenses, bills ────────────────────
    const [reportRows, expenseRows, billRows, woRows] = await Promise.all([
      db.select().from(expenseReports).where(eq(expenseReports.status, "paid")),
      db.select().from(expenses).orderBy(asc(expenses.id)),
      db.select().from(bills),
      db.select({ id: workOrders.id, orgId: workOrders.orgId }).from(workOrders),
    ]);
    const woOrg = new Map(woRows.map((w) => [w.id, w.orgId]));
    for (const r0 of reportRows) {
      const r = stamp(r0);
      if (!mine(r.tenantOrgId)) continue;
      if (!r.paidOn) { out.skipped.push({ what: `report ${r.id}`, why: "paid with no paid_on" }); continue; }
      const cents = expenseRows.filter((e) => e.reportId === r.id).reduce((n, e) => n + e.amountCents, 0);
      count(await postReportPaid({
        report: r, cents, orgId: (r.workOrderId !== null ? woOrg.get(r.workOrderId) : null) ?? r.orgId, by: r.paidBy || by, ignoreClose: true,
      }));
    }
    const billById = new Map(billRows.map((b) => [b.id, stamp(b)]));
    for (const e0 of expenseRows) {
      const e = stamp(e0);
      if (!mine(e.tenantOrgId)) continue;
      if (e.billId !== null) {
        const bill = billById.get(e.billId);
        if (bill) count(await postBillCycle({ bill, on: e.incurredOn, ignoreClose: true }));
        continue;
      }
      if (!companyPaid(e)) continue;
      count(await postExpenseLogged({ expense: e, orgId: e.workOrderId !== null ? woOrg.get(e.workOrderId) ?? null : null, by: e.loggedBy || by, ignoreClose: true }));
    }

    // ── Payroll: one run per ended month since the opening ───────────────
    for (const org of operators) {
      if (!mine(org.id)) continue;
      const rows = (await db.select().from(payroll).where(eq(payroll.orgId, org.id))) as PayRow[];
      if (!rows.length) continue;
      const first = [org.cashOpeningOn, ...rows.map((r) => r.effectiveOn)].filter(Boolean).sort()[0];
      if (!first) continue;
      const from = org.cashOpeningOn ? YM(org.cashOpeningOn) : YM(first);
      for (const ym of monthsBetween(from, YM(opts.today))) {
        const end = endOfMonth(`${ym}-01`);
        if (end > opts.today) break;                       // a month that has not ended has not been paid
        if (org.cashOpeningOn && end < org.cashOpeningOn) continue;   // paid before the balance was taken
        const gross = payrollForMonth(rows, ym).totalCents;
        if (gross <= 0) continue;
        const posted = await postPayrollRun({ tenantOrgId: org.id, ym, grossCents: gross, on: end, by, ignoreClose: true });
        count(posted);
        if (posted?.created && !opts.dryRun) {
          await db.insert(payrollRuns).values({ tenantOrgId: org.id, ym, grossCents: gross, postedOn: end, postedBy: by })
            .onConflictDoNothing();
        }
      }
    }

    // ── Purchase orders: what arrived, what was paid ─────────────────────
    const poRows = (await db.select().from(purchaseOrders)).map(stamp).filter((p) => mine(p.tenantOrgId));
    const poLineRows = await db.select().from(poLines);
    for (const po of poRows) {
      const lines = poLineRows.filter((l) => l.poId === po.id);
      for (const line of lines) {
        if (line.qtyReceived <= 0 || line.unitCents === null) continue;
        const target = line.qtyReceived * line.unitCents;
        // Whatever the live receipts already posted for this line; the
        // remainder is history, keyed on the running count so a later
        // receipt starts a new remainder rather than re-posting this one.
        const already = await postedForLine(po.id, line.id);
        const remainder = target - already;
        if (remainder <= 0) { if (already > 0) out.existing++; continue; }
        count(await post({
          on: po.closedAt ? po.closedAt.toISOString().slice(0, 10) : (po.sentAt ?? po.createdAt).toISOString().slice(0, 10),
          memo: `${po.number} received - ${po.vendor}${line.name ? ` - ${line.name}` : ""}`,
          ref: { type: "po", id: po.id, orgId: po.orgId, workOrderId: po.workOrderId },
          kind: `receive:${line.id}:bf:${line.qtyReceived}`,
          lines: [{ account: "cost_parts", debitCents: remainder }, { account: "payable", creditCents: remainder }],
          postedBy: by, tenantOrgId: po.tenantOrgId, ignoreClose: true,
        }));
      }
      if (po.paidOn) {
        const cents = lines.reduce((n, l) => n + (l.unitCents ?? 0) * l.qtyReceived, 0);
        count(await postPoPaid({ po, cents, on: po.paidOn, by: po.paidBy || by, ignoreClose: true }));
      }
    }

    // ── Referral fees the payer has paid ─────────────────────────────────
    const feePaid = (await db.select().from(referralFees).where(sql`${referralFees.paidCents} > 0`)).map(stamp);
    for (const f of feePaid) {
      if (!mine(f.tenantOrgId)) continue;
      count(await postReferralPaid({
        tenantOrgId: f.tenantOrgId, feeId: f.id, cents: f.paidCents, reference: "history",
        on: f.endsOn && f.endsOn <= opts.today ? f.endsOn : opts.today, ignoreClose: true,
      }));
    }
  } finally {
    setPostSink(null);
  }
  log(`[backfill] ${opts.dryRun ? "would write" : "wrote"} ${out.created} entr${out.created === 1 ? "y" : "ies"}, ${out.existing} already posted, ${out.skipped.length} skipped`);
  return out;
}

/** Parts cost already posted for one PO line, by any receipt or earlier backfill. */
async function postedForLine(poId: number, lineId: number): Promise<number> {
  const [row] = await db.select({ cents: sql<number>`coalesce(sum(${ledgerLines.debitCents}), 0)` })
    .from(ledgerLines).innerJoin(ledgerEntries, eq(ledgerLines.entryId, ledgerEntries.id))
    .where(and(
      eq(ledgerLines.account, "cost_parts"),
      eq(ledgerEntries.refType, "po"), eq(ledgerEntries.refId, String(poId)),
      like(ledgerEntries.postingKey, `po:${poId}:receive:${lineId}:%`),
    ));
  return Number(row?.cents ?? 0);
}

/** Every "YYYY-MM" from one month to another, inclusive. */
export function monthsBetween(from: string, to: string): string[] {
  const out: string[] = [];
  let y = Number(from.slice(0, 4)), m = Number(from.slice(5, 7));
  const endY = Number(to.slice(0, 4)), endM = Number(to.slice(5, 7));
  for (let i = 0; i < 600 && (y < endY || (y === endY && m <= endM)); i++) {
    out.push(`${y}-${String(m).padStart(2, "0")}`);
    m += 1;
    if (m > 12) { m = 1; y += 1; }
  }
  return out;
}

/** Re-exported so the seed and the test can tell an offset line from a credit. */
export { isDepositOffset };
