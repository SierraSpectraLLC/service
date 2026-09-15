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

import { and, eq, inArray, isNull, like } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { db } from "@/db";
import { invoices, orgs, payments, paymentSuggestions, referralFees, stripeEvents } from "@/db/schema";
import { audit } from "@/lib/audit";
import { formatCents } from "@/lib/money";
import { shopToday } from "@/lib/shopday";
import { asStatementRow, creditFor, invoiceById } from "@/lib/invoiceData";
import { invoiceView } from "@/lib/statement";
import { accruedCents } from "@/lib/referral";
import { postInvoicePayment, postInvoiceRefund, postPayout, postProcessingFee, postReferralPaid } from "@/lib/ledger/postings";

/**
 * Claim an event id. True the first time; false when this instance has
 * already acted on it, which is the answer to a redelivery. The caller
 * releases the claim (forgetEvent) if the handling fails, so Stripe's retry
 * after a 500 is handled and its retry after a 200 is not.
 */
export async function claimEvent(input: { eventId: string; type: string; account: string; tenantOrgId: number | null }): Promise<boolean> {
  if (!input.eventId) return false;
  const rows = await db.insert(stripeEvents)
    .values({ eventId: input.eventId, type: input.type, account: input.account, tenantOrgId: input.tenantOrgId })
    .onConflictDoNothing({ target: stripeEvents.eventId })
    .returning({ id: stripeEvents.id });
  return rows.length > 0;
}

export async function forgetEvent(eventId: string): Promise<void> {
  if (!eventId) return;
  await db.delete(stripeEvents).where(eq(stripeEvents.eventId, eventId));
}

/**
 * Whose event this is. The connected account on the event is the operator's
 * own (lib/stripe), kept on their org row; an account nobody here owns gets
 * nothing recorded anywhere rather than landing on whoever is first.
 */
export async function orgForAccount(account: string): Promise<{ id: number; name: string } | null> {
  if (!account) return null;
  const [org] = await db.select({ id: orgs.id, name: orgs.name }).from(orgs).where(eq(orgs.stripeAccountId, account));
  return org ?? null;
}

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
  /** Stripe's cut, when the event carried it. Its own cost row. */
  feeCents?: number;
  /**
   * The workspace the event's account belongs to. An invoice id in metadata
   * is a string somebody could have typed; the money is only recorded on an
   * invoice in the workspace the money actually reached.
   */
  tenantOrgId?: number;
  /** The day it arrived, from the event; today when the event carried none. */
  receivedOn?: string;
}): Promise<{ recorded: boolean; reason?: string }> {
  const [inv] = await db.select().from(invoices).where(eq(invoices.id, input.invoiceId));
  if (!inv) return { recorded: false, reason: "no such invoice" };
  if (input.tenantOrgId !== undefined && inv.tenantOrgId !== input.tenantOrgId) {
    return { recorded: false, reason: "that invoice is not in the workspace the money reached" };
  }
  if (inv.status === "void" || inv.status === "draft") {
    return { recorded: false, reason: `${inv.number} is ${inv.status}` };
  }
  const already = await db.select().from(payments)
    .where(and(eq(payments.invoiceId, input.invoiceId), eq(payments.reference, input.reference)));
  if (already.length) return { recorded: true };   // Stripe retries; a payment is not recorded twice.

  const [row] = await db.insert(payments).values({
    tenantOrgId: inv.tenantOrgId, invoiceId: input.invoiceId,
    method: input.method === "card" ? "card" : "ach",
    amountCents: input.amountCents, reference: input.reference,
    receivedOn: input.receivedOn || shopToday(), recordedBy: "stripe",
  }).returning();
  // The gross lands in the Stripe balance, not the bank - nothing reaches the
  // bank until a payout - and the processing fee is its own cost row.
  await postInvoicePayment({ inv, payment: row });
  if (input.feeCents && input.feeCents > 0) {
    await postProcessingFee({ inv, reference: input.reference, feeCents: input.feeCents, on: row.receivedOn });
  }

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
  return { recorded: true };
}

const shortDate = (s: string) =>
  s ? new Date(`${s}T12:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" }) : "";

/**
 * Money reached Stripe with no invoice named on it. Nothing is recorded: the
 * row says what arrived and, when exactly one open invoice in the workspace
 * has that balance, which one it looks like - and the money overview offers
 * a one-click Record (app/money/actions.recordSuggestedPayment). One row per
 * Stripe reference, so a redelivery cannot suggest the same money twice.
 */
export async function suggestStripePayment(input: {
  tenantOrgId: number; reference: string; amountCents: number; method: string; receivedOn: string;
}): Promise<{ suggested: boolean; id?: number; invoiceNumber?: string }> {
  if (!input.reference || input.amountCents <= 0) return { suggested: false };
  const already = await db.select({ id: paymentSuggestions.id }).from(paymentSuggestions)
    .where(and(eq(paymentSuggestions.provider, "stripe"), eq(paymentSuggestions.reference, input.reference)));
  if (already.length) return { suggested: true, id: already[0].id };
  // Already on an invoice under this reference - recorded by hand, say - so
  // there is nothing to suggest.
  const paid = await db.select({ id: payments.id }).from(payments)
    .where(and(eq(payments.tenantOrgId, input.tenantOrgId), eq(payments.reference, input.reference)));
  if (paid.length) return { suggested: false };

  const open = await db.select({ id: invoices.id, orgId: invoices.orgId, number: invoices.number }).from(invoices)
    .where(and(eq(invoices.tenantOrgId, input.tenantOrgId), inArray(invoices.status, ["sent", "partial"])));
  const today = shopToday();
  const matches: { id: number; number: string; orgId: number }[] = [];
  for (const o of open) {
    const full = await invoiceById(o.id);
    if (!full) continue;
    const view = invoiceView(asStatementRow(full), today);
    if (view.payableCents === input.amountCents || view.balanceCents === input.amountCents) matches.push({ id: o.id, number: o.number, orgId: o.orgId });
  }
  const match = matches.length === 1 ? matches[0] : null;
  const [client] = match ? await db.select({ name: orgs.name }).from(orgs).where(eq(orgs.id, match.orgId)) : [];
  const method = input.method === "card" ? "card" : "ach";
  const description = `Stripe payment ${formatCents(input.amountCents)} on ${shortDate(input.receivedOn)}`
    + (match
      ? ` matches open invoice ${match.number}${client?.name ? ` for ${client.name}` : ""}`
      : matches.length > 1 ? ` - ${matches.length} open invoices have that balance` : " - no open invoice has that balance");

  const [row] = await db.insert(paymentSuggestions).values({
    tenantOrgId: input.tenantOrgId, provider: "stripe", reference: input.reference,
    amountCents: input.amountCents, method, receivedOn: input.receivedOn || today,
    invoiceId: match?.id ?? null, description,
  }).onConflictDoNothing({ target: [paymentSuggestions.provider, paymentSuggestions.reference] }).returning({ id: paymentSuggestions.id });
  if (!row) return { suggested: true };
  await audit({
    actor: "stripe", entityType: "payment_suggestion", entityId: row.id, tenantOrgId: input.tenantOrgId,
    action: `${description} (${input.reference}) - not recorded until somebody says which invoice`,
  });
  revalidatePath("/money");
  return { suggested: true, id: row.id, invoiceNumber: match?.number };
}

/**
 * Stripe sent some of a payment back. The reversal is a second row, never an
 * edit: a negative payment under the charge's reference, and a ledger entry
 * putting the receivable back and the Stripe balance down. Stripe reports
 * the CUMULATIVE amount refunded on the charge, so what is posted is the
 * difference from what this instance already holds - a redelivery posts
 * nothing, a second partial refund posts only its own amount.
 */
export async function recordStripeRefund(input: {
  tenantOrgId: number; paymentIntentId: string; chargeId: string; refundedCents: number; on: string;
}): Promise<{ posted: boolean; reason?: string; cents?: number }> {
  if (!input.chargeId || input.refundedCents <= 0) return { posted: false, reason: "nothing refunded" };
  const refs = [input.paymentIntentId, input.chargeId].filter(Boolean);
  const [paid] = await db.select().from(payments)
    .where(and(eq(payments.tenantOrgId, input.tenantOrgId), inArray(payments.reference, refs), eq(payments.recordedBy, "stripe")));
  if (!paid) return { posted: false, reason: "no recorded payment to refund" };
  const [inv] = await db.select().from(invoices).where(eq(invoices.id, paid.invoiceId));
  if (!inv) return { posted: false, reason: "no invoice" };

  const prefix = `${input.chargeId}:refund:`;
  const prior = await db.select({ cents: payments.amountCents }).from(payments)
    .where(and(eq(payments.invoiceId, inv.id), like(payments.reference, `${prefix}%`)));
  const alreadyCents = prior.reduce((n, p) => n + Math.max(0, -p.cents), 0);
  const cents = input.refundedCents - alreadyCents;
  if (cents <= 0) return { posted: false, reason: "already recorded" };

  const on = /^\d{4}-\d{2}-\d{2}$/.test(input.on) ? input.on : shopToday();
  await db.insert(payments).values({
    tenantOrgId: inv.tenantOrgId, invoiceId: inv.id, method: paid.method,
    amountCents: -cents, reference: `${prefix}${input.refundedCents}`,
    receivedOn: on, recordedBy: "stripe",
  });
  await postInvoiceRefund({ inv, chargeId: input.chargeId, refundedCents: input.refundedCents, cents, on });

  const full = await invoiceById(inv.id);
  const view = full ? invoiceView(asStatementRow(full), shopToday()) : null;
  if (view && inv.status !== "void" && inv.status !== "referred" && inv.status !== "draft") {
    const next = view.balanceCents <= 0 ? "paid" : view.paidCents > 0 ? "partial" : "sent";
    if (next !== inv.status) {
      await db.update(invoices).set({ status: next, updatedAt: new Date() })
        .where(and(eq(invoices.id, inv.id), eq(invoices.tenantOrgId, inv.tenantOrgId as number)));
    }
  }
  await audit({
    actor: "stripe", entityType: "invoice", entityId: inv.id, tenantOrgId: inv.tenantOrgId,
    action: `refunded ${formatCents(cents)} on ${inv.number} (${input.chargeId})`
      + (view ? ` - ${formatCents(view.balanceCents)} now open` : ""),
  });
  revInvoice(inv);
  return { posted: true, cents };
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
  // The payer's books: a fee paid to another shop is a cost of the work.
  await postReferralPaid({
    tenantOrgId: fee.tenantOrgId, feeId: input.feeId, cents: Math.max(0, Math.round(input.amountCents)),
    reference: input.reference, on: shopToday(),
  });
  await audit({
    actor: "stripe", entityType: "referral_fee", entityId: input.feeId, tenantOrgId: fee.tenantOrgId,
    action: `referral fee payment of ${formatCents(input.amountCents)} received (${input.reference})`,
  });
  revalidatePath("/network");
}

/**
 * Stripe paid the operator's balance out to their bank. Called only by the
 * verified webhook, for a connected account's `payout.paid`.
 *
 * The account id on the event is what says WHOSE books this is: it is the
 * operator's own Connect account (lib/stripe), kept on their org row, and a
 * payout for an account nobody here owns is ignored rather than posted to
 * whoever is first. The posting is stripe down, bank down-and-up - the money
 * was already ours; it moved rooms - and it lands with a payout id the Cash
 * page matches the bank line against by amount and date, so a payout is the
 * one bank line that arrives pre-matched.
 */
export async function recordStripePayout(input: {
  account: string; payoutId: string; amountCents: number; arrivalDate: string;
}): Promise<{ posted: boolean; reason?: string }> {
  if (!input.account || !input.payoutId || input.amountCents <= 0) return { posted: false, reason: "nothing to post" };
  const [org] = await db.select({ id: orgs.id }).from(orgs).where(eq(orgs.stripeAccountId, input.account));
  if (!org) return { posted: false, reason: "no workspace owns that account" };
  const on = /^\d{4}-\d{2}-\d{2}$/.test(input.arrivalDate) ? input.arrivalDate : shopToday();
  const res = await postPayout({ tenantOrgId: org.id, payoutId: input.payoutId, cents: input.amountCents, on });
  if (res?.created) {
    await audit({
      actor: "stripe", entityType: "ledger_entry", entityId: res.id, tenantOrgId: org.id,
      action: `Stripe paid out ${formatCents(input.amountCents)} to the bank (${input.payoutId})`,
    });
    revalidatePath("/money/cash");
    revalidatePath("/money");
  }
  return { posted: Boolean(res?.created) };
}
