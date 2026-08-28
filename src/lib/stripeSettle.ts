// Settling a Stripe payment - and deliberately NOT a server action.
//
// This is the point of the file existing at all. app/actions.ts carries
// "use server", which makes every export in it callable over the network by
// anybody with a session: recordStripePayment lived there, so a signed-in
// client could have marked ANY invoice paid by calling it with an id, an
// amount and a reference of their choosing. The dedupe on `reference` was no
// protection - the caller picks the reference.
//
// The webhook route is a plain route handler and can import a plain module, so
// these live here, where nothing can reach them but code. The authorization for
// both is the Stripe signature check in app/api/stripe/webhook, before the body
// is even parsed; there is no second gate here and there does not need to be,
// as long as the door stays shut.
//
// Found by tests/tenantWriteScoping, which is exactly the shape it was written
// for: a write keyed on a caller-supplied id with a role check and nothing else.

import { and, eq, isNull } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { db } from "@/db";
import { invoices, payments, referralFees } from "@/db/schema";
import { audit } from "@/lib/audit";
import { formatCents } from "@/lib/money";
import { shopToday } from "@/lib/shopday";
import { asStatementRow, creditFor, invoiceById } from "@/lib/invoiceData";
import { invoiceView } from "@/lib/statement";
import { accruedCents } from "@/lib/referral";

/** Both surfaces an invoice shows up on. Mirrors app/actions' revInvoice. */
const revInvoice = (inv: { id: number; orgId: number }) => {
  revalidatePath(`/money/invoices/${inv.id}`);
  revalidatePath("/money/invoices");
  revalidatePath("/money/collections");
};

/**
 * Stripe says the money arrived. Called only by the webhook, which has already
 * verified the signature - this records the payment, lets the credit hold
 * recompute itself, and writes the audit row.
 */
export async function recordStripePayment(input: {
  invoiceId: number; amountCents: number; reference: string; method: string;
}): Promise<void> {
  const [inv] = await db.select().from(invoices).where(eq(invoices.id, input.invoiceId));
  if (!inv) return;
  const already = await db.select().from(payments)
    .where(and(eq(payments.invoiceId, input.invoiceId), eq(payments.reference, input.reference)));
  if (already.length) return;   // Stripe retries; a payment is not recorded twice.

  await db.insert(payments).values({
    tenantOrgId: inv.tenantOrgId, invoiceId: input.invoiceId,
    method: input.method === "card" ? "card" : "ach",
    amountCents: input.amountCents, reference: input.reference,
    receivedOn: shopToday(), recordedBy: "stripe",
  });

  const full = await invoiceById(input.invoiceId);
  const view = full ? invoiceView(asStatementRow(full), shopToday()) : null;
  if (view && inv.status !== "void" && inv.status !== "referred") {
    const next = view.balanceCents <= 0 ? "paid" : "partial";
    if (next !== inv.status) {
      await db.update(invoices).set({ status: next, updatedAt: new Date() }).where(eq(invoices.id, input.invoiceId));
    }
  }
  // The hold is computed, never stored, so paying the balance lifts it by
  // arithmetic the next time anybody looks. Nothing to un-set here.
  const credit = await creditFor(inv.orgId, shopToday()).catch(() => null);
  await audit({
    actor: "stripe", entityType: "invoice", entityId: input.invoiceId, tenantOrgId: inv.tenantOrgId,
    action: `received ${formatCents(input.amountCents)} by ${input.method === "card" ? "card" : "bank transfer"} on ${inv.number}`
      + (view ? ` - ${view.balanceCents <= 0 ? "paid in full" : `${formatCents(view.balanceCents)} still open`}` : "")
      + (credit && !credit.onHold ? "; the credit hold has cleared" : ""),
  });
  revInvoice(inv);
}

/**
 * Stripe says the money moved. Called only by the verified webhook.
 *
 * Additive, like recording a payment on an invoice: the row is never edited
 * down, so a duplicate delivery overpays rather than corrupting - and an
 * overpayment reads as a credit, which outstandingCents already floors at zero.
 */
export async function recordReferralPayment(input: {
  feeId: number; amountCents: number; reference: string;
}): Promise<void> {
  const [fee] = await db.select().from(referralFees).where(eq(referralFees.id, input.feeId));
  if (!fee) throw new Error(`no referral fee ${input.feeId}`);
  const paid = fee.paidCents + Math.max(0, Math.round(input.amountCents));
  const settled = paid >= accruedCents(fee) && fee.kind === "flat";
  await db.update(referralFees).set({
    paidCents: paid,
    // Only a FLAT fee closes on payment. A percent that is square today may
    // accrue again tomorrow, and marking it settled would tell both sides the
    // arrangement was over while its window is still open.
    status: settled ? "settled" : fee.status,
  }).where(and(
    eq(referralFees.id, input.feeId),
    // The row we READ is the row we write. A redundant clause today and the
    // thing that keeps this statement narrow if the lookup above ever grows a
    // second way of finding a fee - see tests/tenantWriteScoping.
    fee.tenantOrgId === null
      ? isNull(referralFees.tenantOrgId)
      : eq(referralFees.tenantOrgId, fee.tenantOrgId),
  ));
  await audit({
    actor: "stripe", entityType: "referral_fee", entityId: input.feeId, tenantOrgId: fee.tenantOrgId,
    action: `referral fee payment of ${formatCents(input.amountCents)} received (${input.reference})`,
  });
  revalidatePath("/network");
}
