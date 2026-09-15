// What each document does to the money.
//
// One function per event, each taking the rows the event is about and
// calling post() with the lines the chart says they mean. The actions call
// these when the event happens; scripts/backfill-ledger calls the same
// functions over history; the seed's history goes through them too. That is
// the whole reason this file exists apart from post(): three writers, one
// answer to "what does sending an invoice post", and the posting key on every
// call means none of the three can post it twice.
//
// Nothing here reads a clock or a session. Dates come from the rows (the day
// the invoice was issued, the day the claim was paid) or from the caller.

import type { invoiceFees, invoiceLines, invoices, payments, purchaseOrders, poLines, bills, expenses, expenseReports } from "@/db/schema";
import { revenueAccountFor, type AccountKey } from "@/lib/ledger/accounts";
import { pair, post, type Db, type PostLine, type Posted } from "@/lib/ledger/post";
import { entries } from "@/lib/ledger/sums";
import { reverse } from "@/lib/ledger/reverse";

type InvoiceRow = typeof invoices.$inferSelect;
type LineRow = typeof invoiceLines.$inferSelect;
type PaymentRow = typeof payments.$inferSelect;
type FeeRow = typeof invoiceFees.$inferSelect;
type PoRow = typeof purchaseOrders.$inferSelect;
type PoLineRow = typeof poLines.$inferSelect;
type BillRow = typeof bills.$inferSelect;
type ExpenseRow = typeof expenses.$inferSelect;
type ReportRow = typeof expenseReports.$inferSelect;

const lineCents = (l: Pick<LineRow, "qty" | "unitCents">): number => Math.round((l.qty / 1000) * l.unitCents);

/** The offset line draftInvoice writes when a quote's deposit was already billed. */
export const isDepositOffset = (l: Pick<LineRow, "kind" | "unitCents" | "description" | "sourceId">): boolean =>
  l.kind === "fee_ref" && l.unitCents < 0 && l.sourceId === null && /^Less deposit invoiced on /.test(l.description);

const invoiceRef = (inv: InvoiceRow) => ({
  type: "invoice" as const, id: inv.id, orgId: inv.orgId, workOrderId: inv.workOrderId,
});

/**
 * The lines an invoice posts when it is sent, from its rows.
 *
 * Receivable takes the net total. Each uncovered line goes to the revenue
 * account its kind names; a tax line is money owed to the state, not
 * revenue; a deposit offset takes the held deposit back down; and every line
 * of a DEPOSIT invoice (one a quote's approval raised) is a liability, because
 * the work has not been done yet. A covered line is worth nothing here - the
 * contract already paid for it, at the installment.
 *
 * Pure, and exported so the send action, the backfill and a test all read
 * the same arithmetic. Null when there is nothing to post (the $0 invoice).
 */
export function invoiceSendLines(lines: LineRow[], opts: { depositInvoice: boolean }): PostLine[] | null {
  const net = new Map<AccountKey, number>();   // positive = credit, negative = debit
  const add = (k: AccountKey, cents: number) => net.set(k, (net.get(k) ?? 0) + cents);
  let receivable = 0;
  for (const l of lines) {
    if (l.covered) continue;
    const cents = lineCents(l);
    if (cents === 0) continue;
    receivable += cents;
    if (opts.depositInvoice) add("deposits_held", cents);
    else if (l.kind === "tax") add("sales_tax_owed", cents);
    else if (isDepositOffset(l)) add("deposits_held", cents);   // negative: a debit to the liability
    else add(revenueAccountFor(l.kind), cents);
  }
  const out: PostLine[] = [];
  if (receivable > 0) out.push({ account: "receivable", debitCents: receivable });
  else if (receivable < 0) out.push({ account: "receivable", creditCents: -receivable });
  for (const [account, cents] of net) {
    if (cents > 0) out.push({ account, creditCents: cents });
    else if (cents < 0) out.push({ account, debitCents: -cents });
  }
  return out.length >= 2 ? out : null;
}

/** Invoice sent: receivable up, revenue (or the liability) up. */
export async function postInvoiceSent(input: {
  inv: InvoiceRow; lines: LineRow[];
  /** The quote this invoice is the deposit for, when it is one. */
  depositFor: string | null;
  by: string; tx?: Db; ignoreClose?: boolean;
}): Promise<Posted | null> {
  const lines = invoiceSendLines(input.lines, { depositInvoice: input.depositFor !== null });
  if (!lines || !input.inv.issuedOn) return null;
  return post({
    on: input.inv.issuedOn,
    memo: input.depositFor
      ? `${input.inv.number} sent - deposit on ${input.depositFor}`
      : `${input.inv.number} sent${input.inv.title ? ` - ${input.inv.title}` : ""}`,
    ref: invoiceRef(input.inv), kind: "send",
    lines, postedBy: input.by, tenantOrgId: input.inv.tenantOrgId, tx: input.tx, ignoreClose: input.ignoreClose,
  });
}

/** Money arrived on an invoice: the bank (or Stripe) up, receivable down. */
export async function postInvoicePayment(input: {
  inv: InvoiceRow; payment: PaymentRow; by?: string; tx?: Db; ignoreClose?: boolean;
}): Promise<Posted | null> {
  const { inv, payment } = input;
  if (payment.amountCents <= 0 || !payment.receivedOn) return null;
  const into: AccountKey = payment.recordedBy === "stripe" ? "stripe" : "bank";
  return post({
    on: payment.receivedOn,
    memo: `Payment on ${inv.number} - ${payment.method}${payment.reference ? ` ${payment.reference}` : ""}`,
    ref: invoiceRef(inv), kind: `payment:${payment.id}`,
    lines: pair(into, "receivable", payment.amountCents),
    postedBy: input.by ?? payment.recordedBy, tenantOrgId: inv.tenantOrgId, tx: input.tx, ignoreClose: input.ignoreClose,
  });
}

/** A late fee posted: receivable up, fee revenue up. */
export async function postInvoiceFee(input: { inv: InvoiceRow; fee: FeeRow; tx?: Db; ignoreClose?: boolean }): Promise<Posted | null> {
  const { inv, fee } = input;
  if (fee.amountCents <= 0 || !fee.postedOn) return null;
  return post({
    on: fee.postedOn, memo: `Late fee posted on ${inv.number}`,
    ref: invoiceRef(inv), kind: `fee:${fee.id}`,
    lines: pair("receivable", "revenue_fees", fee.amountCents),
    postedBy: fee.postedBy, tenantOrgId: inv.tenantOrgId, tx: input.tx, ignoreClose: input.ignoreClose,
  });
}

/** A fee waived: its own entry, the mirror of the fee. The fee row keeps `waived`. */
export async function postFeeWaived(input: { inv: InvoiceRow; fee: FeeRow; on: string; by: string; tx?: Db; ignoreClose?: boolean }): Promise<Posted | null> {
  const { inv, fee } = input;
  if (fee.amountCents <= 0) return null;
  return post({
    on: input.on, memo: `Late fee waived on ${inv.number}`,
    ref: invoiceRef(inv), kind: `waive:${fee.id}`,
    lines: pair("revenue_fees", "receivable", fee.amountCents),
    postedBy: input.by, tenantOrgId: inv.tenantOrgId, tx: input.tx, ignoreClose: input.ignoreClose,
  });
}

/** A dispute credited: the credited line's revenue down, receivable down. */
export async function postDisputeCredit(input: {
  inv: InvoiceRow; disputeId: number; creditedKind: string; cents: number; on: string; by: string; tx?: Db; ignoreClose?: boolean;
}): Promise<Posted | null> {
  if (input.cents <= 0) return null;
  return post({
    on: input.on, memo: `Credit on ${input.inv.number} - dispute resolved`,
    ref: invoiceRef(input.inv), kind: `credit:${input.disputeId}`,
    lines: pair(revenueAccountFor(input.creditedKind), "receivable", input.cents),
    postedBy: input.by, tenantOrgId: input.inv.tenantOrgId, tx: input.tx, ignoreClose: input.ignoreClose,
  });
}

/**
 * Voiding: every live entry the invoice made is reversed, dated today. The
 * send, its fees, its credits. Payments cannot be here - void refuses an
 * invoice with money against it.
 */
export async function reverseInvoicePostings(input: { inv: InvoiceRow; today: string; by: string; reason: string; tx?: Db; ignoreClose?: boolean }): Promise<number> {
  const live = await entries({ tenant: input.inv.tenantOrgId, refType: "invoice", refId: String(input.inv.id), liveOnly: true });
  let n = 0;
  for (const e of live) {
    const r = await reverse({ entryId: e.id, reason: input.reason, postedBy: input.by, today: input.today, tx: input.tx });
    if (r.created) n++;
  }
  return n;
}

/** Parts arrived on a purchase order: parts cost up, payable up, for what arrived. */
export async function postPoReceipt(input: {
  po: PoRow; line: PoLineRow; qty: number;
  /** The line's received count AFTER this receipt - part of the key, so two receipts are two entries. */
  receivedAfter: number; on: string; by: string; tx?: Db; ignoreClose?: boolean;
}): Promise<Posted | null> {
  const { po, line } = input;
  if (line.unitCents === null || input.qty <= 0) return null;
  const cents = line.unitCents * input.qty;
  if (cents <= 0) return null;
  return post({
    on: input.on, memo: `${po.number} received - ${po.vendor}${line.name ? ` - ${line.name}` : ""}`,
    ref: { type: "po", id: po.id, orgId: po.orgId, workOrderId: po.workOrderId },
    kind: `receive:${line.id}:${input.receivedAfter}`,
    lines: pair("cost_parts", "payable", cents),
    postedBy: input.by, tenantOrgId: po.tenantOrgId, tx: input.tx, ignoreClose: input.ignoreClose,
  });
}

/** The vendor paid: payable down, bank down. */
export async function postPoPaid(input: { po: PoRow; cents: number; on: string; by: string; tx?: Db; ignoreClose?: boolean }): Promise<Posted | null> {
  if (input.cents <= 0) return null;
  return post({
    on: input.on, memo: `${input.po.number} paid - ${input.po.vendor}`,
    ref: { type: "po", id: input.po.id, orgId: input.po.orgId, workOrderId: input.po.workOrderId }, kind: "paid",
    lines: pair("payable", "bank", input.cents),
    postedBy: input.by, tenantOrgId: input.po.tenantOrgId, tx: input.tx, ignoreClose: input.ignoreClose,
  });
}

/** A standing bill's cycle: overhead up, bank down. Bills are paid when posted. */
export async function postBillCycle(input: { bill: BillRow; on: string; by?: string; tx?: Db; ignoreClose?: boolean }): Promise<Posted | null> {
  const { bill } = input;
  if (bill.amountCents <= 0) return null;
  return post({
    on: input.on, memo: `${bill.payee || bill.name} - ${bill.kind}`,
    ref: { type: "bill", id: bill.id }, kind: input.on,
    lines: pair("overhead", "bank", bill.amountCents),
    postedBy: input.by ?? "bills", tenantOrgId: bill.tenantOrgId, tx: input.tx, ignoreClose: input.ignoreClose,
  });
}

/**
 * Is this expense row company money that left when it was logged? A row
 * somebody is owed for leaves when their claim is paid; a bill's cycle is
 * posted by the bill; a job's billable receipt bought by the company still
 * cost the company. So: nobody to reimburse, no claim, no bill.
 */
export const companyPaid = (e: Pick<ExpenseRow, "person" | "reportId" | "billId" | "stipendId">): boolean =>
  e.person === "" && e.reportId === null && e.billId === null && e.stipendId === null;

/** A hand-logged, company-paid expense: overhead (or a job's field cost) up, bank down. */
export async function postExpenseLogged(input: {
  expense: ExpenseRow; orgId?: number | null; by: string; tx?: Db; ignoreClose?: boolean;
}): Promise<Posted | null> {
  const e = input.expense;
  if (!companyPaid(e) || e.amountCents <= 0 || !e.incurredOn) return null;
  const account: AccountKey = e.workOrderId === null ? "overhead" : "cost_field_expenses";
  return post({
    on: e.incurredOn, memo: `${e.description || e.kind}${e.workOrderId === null ? "" : " - on the job"}`,
    ref: { type: "expense", id: e.id, orgId: input.orgId ?? null, workOrderId: e.workOrderId }, kind: "logged",
    lines: pair(account, "bank", e.amountCents),
    postedBy: input.by, tenantOrgId: e.tenantOrgId, tx: input.tx, ignoreClose: input.ignoreClose,
  });
}

/** A reimbursement claim paid: field expenses up, bank down. */
export async function postReportPaid(input: {
  report: ReportRow; cents: number;
  /** The client the claim was for: the job's, or the report's own when there is no job. */
  orgId: number | null; by?: string; tx?: Db; ignoreClose?: boolean;
}): Promise<Posted | null> {
  const r = input.report;
  if (input.cents <= 0 || !r.paidOn) return null;
  return post({
    on: r.paidOn, memo: `${r.title || "Expense report"} paid - ${r.person}`,
    ref: { type: "report", id: r.id, orgId: input.orgId, workOrderId: r.workOrderId }, kind: "paid",
    lines: pair("cost_field_expenses", "bank", input.cents),
    postedBy: input.by ?? r.paidBy, tenantOrgId: r.tenantOrgId, tx: input.tx, ignoreClose: input.ignoreClose,
  });
}

/** A month's payroll run: payroll cost up, bank down. */
export async function postPayrollRun(input: {
  tenantOrgId: number | null; ym: string; grossCents: number; on: string; by: string; tx?: Db; ignoreClose?: boolean;
}): Promise<Posted | null> {
  if (input.grossCents <= 0) return null;
  return post({
    on: input.on, memo: `Payroll - ${monthWord(input.ym)}`,
    ref: { type: "payroll", id: input.ym }, kind: "run",
    lines: pair("payroll", "bank", input.grossCents),
    postedBy: input.by, tenantOrgId: input.tenantOrgId, tx: input.tx, ignoreClose: input.ignoreClose,
  });
}

/** The opening balance: bank up against equity, on the day it was taken. */
export async function postOpening(input: {
  tenantOrgId: number; cents: number; on: string; by: string; tx?: Db; ignoreClose?: boolean;
}): Promise<Posted | null> {
  if (input.cents === 0) return null;
  const lines = input.cents > 0
    ? pair("bank", "opening_balance", input.cents)
    : pair("opening_balance", "bank", -input.cents);
  return post({
    on: input.on, memo: "Opening cash balance",
    ref: { type: "opening", id: input.tenantOrgId }, kind: `${input.on}:${input.cents}`,
    lines, postedBy: input.by, tenantOrgId: input.tenantOrgId, tx: input.tx, ignoreClose: input.ignoreClose,
  });
}

/** Stripe's cut of a pay-link payment: a cost, taken out of the Stripe balance. */
export async function postProcessingFee(input: {
  inv: InvoiceRow; reference: string; feeCents: number; on: string; tx?: Db; ignoreClose?: boolean;
}): Promise<Posted | null> {
  if (input.feeCents <= 0) return null;
  return post({
    on: input.on, memo: `Stripe fee on ${input.inv.number}`,
    ref: invoiceRef(input.inv), kind: `stripefee:${input.reference}`,
    lines: pair("cost_processing", "stripe", input.feeCents),
    postedBy: "stripe", tenantOrgId: input.inv.tenantOrgId, tx: input.tx, ignoreClose: input.ignoreClose,
  });
}

/**
 * Money sent back to the client from the Stripe balance: receivable up again,
 * Stripe down. Keyed on the charge and the cumulative amount refunded, which
 * is what Stripe reports - so a redelivered event with the same total posts
 * nothing, and a second partial refund posts only its own delta.
 */
export async function postInvoiceRefund(input: {
  inv: InvoiceRow; chargeId: string; refundedCents: number; cents: number; on: string; tx?: Db; ignoreClose?: boolean;
}): Promise<Posted | null> {
  if (input.cents <= 0) return null;
  return post({
    on: input.on, memo: `Refund on ${input.inv.number} - ${input.chargeId}`,
    ref: invoiceRef(input.inv), kind: `refund:${input.chargeId}:${input.refundedCents}`,
    lines: pair("receivable", "stripe", input.cents),
    postedBy: "stripe", tenantOrgId: input.inv.tenantOrgId, tx: input.tx, ignoreClose: input.ignoreClose,
  });
}

/** A Stripe payout landing in the bank. */
export async function postPayout(input: {
  tenantOrgId: number | null; payoutId: string; cents: number; on: string; tx?: Db; ignoreClose?: boolean;
}): Promise<Posted | null> {
  if (input.cents <= 0) return null;
  return post({
    on: input.on, memo: "Stripe payout to bank",
    ref: { type: "payout", id: input.payoutId }, kind: "paid",
    lines: pair("bank", "stripe", input.cents),
    postedBy: "stripe", tenantOrgId: input.tenantOrgId, tx: input.tx, ignoreClose: input.ignoreClose,
  });
}

/** Sales tax remitted for a period: the liability down, bank down. */
export async function postTaxRemit(input: {
  tenantOrgId: number | null; period: string; cents: number; on: string; by: string; tx?: Db; ignoreClose?: boolean;
}): Promise<Posted | null> {
  if (input.cents <= 0) return null;
  return post({
    on: input.on, memo: `Sales tax remitted - ${input.period}`,
    ref: { type: "tax", id: input.period }, kind: "remit",
    lines: pair("sales_tax_owed", "bank", input.cents),
    postedBy: input.by, tenantOrgId: input.tenantOrgId, tx: input.tx, ignoreClose: input.ignoreClose,
  });
}

/**
 * A referral fee the shop paid another shop: a cost of getting the work.
 * The other side's receivable is an ordinary invoice, posted by its send.
 */
export async function postReferralPaid(input: {
  tenantOrgId: number | null; feeId: number; cents: number; reference: string; on: string; tx?: Db; ignoreClose?: boolean;
}): Promise<Posted | null> {
  if (input.cents <= 0) return null;
  return post({
    on: input.on, memo: "Referral fee paid",
    ref: { type: "referral", id: input.feeId }, kind: `paid:${input.reference}`,
    lines: pair("overhead", "bank", input.cents),
    postedBy: "stripe", tenantOrgId: input.tenantOrgId, tx: input.tx, ignoreClose: input.ignoreClose,
  });
}

const MONTHS = ["January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December"];
export const monthWord = (ym: string): string =>
  /^\d{4}-\d{2}$/.test(ym) ? `${MONTHS[Number(ym.slice(5, 7)) - 1] ?? ym} ${ym.slice(0, 4)}` : ym;
