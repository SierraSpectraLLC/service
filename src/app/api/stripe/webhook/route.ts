import { NextResponse } from "next/server";
// A plain module, not the server-action surface - see lib/stripeSettle.
import {
  claimEvent, forgetEvent, orgForAccount, recordReferralPayment, recordStripePayment, recordStripePayout,
  recordStripeRefund, suggestStripePayment,
} from "@/lib/stripeSettle";
import { paymentFee, verifyWebhook } from "@/lib/stripeApi";
import { shopToday } from "@/lib/shopday";

export const dynamic = "force-dynamic";

type StripeObject = Record<string, unknown>;
type StripeEvent = {
  id?: string; type?: string; account?: string; created?: number;
  data?: { object?: StripeObject };
};

const str = (v: unknown): string => (typeof v === "string" ? v : "");
const cents = (v: unknown): number => Math.max(0, Math.round(Number(v ?? 0)) || 0);
const dayOf = (unix: unknown): string => {
  const n = Number(unix ?? 0);
  return n > 0 ? new Date(n * 1000).toISOString().slice(0, 10) : shopToday();
};

/**
 * Card or bank transfer, off whatever the object says about how it was paid.
 * A payment intent lists its types; a charge names its method's type; a
 * Stripe Billing invoice says nothing, and defaults to card.
 */
function methodOf(obj: StripeObject): "card" | "ach" {
  const types = Array.isArray(obj.payment_method_types) ? (obj.payment_method_types as unknown[]).map(String) : [];
  const details = (obj.payment_method_details as { type?: string } | undefined)?.type ?? "";
  const kind = types[0] ?? details;
  return /bank|ach|customer_balance/.test(kind) ? "ach" : "card";
}

/** The invoice named on the object, under the name this app writes or the older one. */
function invoiceIdOn(obj: StripeObject): number | null {
  const md = (obj.metadata ?? {}) as Record<string, unknown>;
  const raw = str(md.ridgeline_invoice_id) || str(md.invoiceId);
  const id = parseInt(raw, 10);
  return Number.isInteger(id) && id > 0 ? id : null;
}

/**
 * Stripe telling us money moved.
 *
 * The signature check is the whole security of this endpoint: without it,
 * anybody who knows the URL can mark any invoice paid. It runs before the body
 * is parsed, on the RAW text, because re-serialising JSON changes the bytes
 * the signature was computed over.
 *
 * Unverified requests get a 400 and no explanation. An endpoint that tells an
 * attacker which part of their forgery was wrong is helping them.
 *
 * Then, in order: the event id is claimed, so a redelivery is answered and
 * not re-run; the connected account on the event says WHOSE books this is;
 * and only an invoice in that workspace can be settled by it. Money with no
 * invoice named is never guessed at - it becomes a suggestion somebody
 * confirms on the money overview.
 */
export async function POST(req: Request) {
  const secret = (process.env.STRIPE_WEBHOOK_SECRET ?? "").trim();
  if (!secret) {
    // Not configured is not an error state - this instance simply takes no
    // online payments - but it must never fall through to processing.
    return NextResponse.json({ skipped: "no webhook secret configured" }, { status: 200 });
  }
  const raw = await req.text();
  const sig = req.headers.get("stripe-signature") ?? "";
  if (!verifyWebhook(raw, sig, secret)) {
    return NextResponse.json({ error: "bad signature" }, { status: 400 });
  }

  let event: StripeEvent;
  try {
    event = JSON.parse(raw);
  } catch {
    return NextResponse.json({ error: "bad payload" }, { status: 400 });
  }
  const eventId = str(event.id);
  const type = str(event.type);
  const account = str(event.account);
  if (!eventId || !type) return NextResponse.json({ error: "bad payload" }, { status: 400 });

  // Whose books. Resolved before the claim so the event row carries it.
  const org = await orgForAccount(account);

  // Idempotent on the event id: Stripe redelivers, and the answer to a
  // redelivery is "done" without touching a row. The claim is released on a
  // failure below, so Stripe's retry after a 500 does get handled.
  if (!(await claimEvent({ eventId, type, account, tenantOrgId: org?.id ?? null }))) {
    return NextResponse.json({ duplicate: eventId });
  }

  try {
    const out = await handle(event, org);
    return NextResponse.json(out);
  } catch (e) {
    // A 500 makes Stripe retry, which is what we want: the money really did
    // move, and the row has to exist eventually.
    await forgetEvent(eventId).catch(() => {});
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}

async function handle(event: StripeEvent, org: { id: number; name: string } | null): Promise<Record<string, unknown>> {
  const type = str(event.type);
  const account = str(event.account);
  const obj = event.data?.object ?? {};

  // The balance went to the bank. A payout is not a payment - no invoice, no
  // client - so it takes its own branch and its own posting, keyed on the
  // payout id so a redelivery posts nothing.
  if (type === "payout.paid") {
    const r = await recordStripePayout({
      account, payoutId: str(obj.id), amountCents: cents(obj.amount), arrivalDate: dayOf(obj.arrival_date),
    });
    return r.posted ? { posted: str(obj.id) } : { ignored: r.reason ?? "payout" };
  }

  // Money in: the intent that succeeded, or the Stripe Billing invoice that
  // was paid. One branch for both, because they describe the same money;
  // listening to the checkout session as well is how one payment gets
  // recorded twice.
  if (type === "payment_intent.succeeded" || type === "invoice.paid") {
    if (!org) return { ignored: "no workspace owns that account" };
    const isIntent = type === "payment_intent.succeeded";
    const intentId = isIntent ? str(obj.id) : str(obj.payment_intent);
    const reference = intentId || str(obj.id);
    const amountCents = cents(isIntent ? (obj.amount_received ?? obj.amount) : obj.amount_paid);
    const method = methodOf(obj);
    const receivedOn = dayOf(obj.created ?? event.created);
    if (amountCents <= 0 || !reference) return { ignored: "no amount or reference on the payment" };

    // A referral fee between two service companies moves the same way an
    // invoice does and settles a different row. It rides the intent's metadata.
    const md = (obj.metadata ?? {}) as Record<string, unknown>;
    const referralFeeId = parseInt(str(md.referralFeeId), 10);
    if (Number.isInteger(referralFeeId)) {
      await recordReferralPayment({ feeId: referralFeeId, amountCents, reference });
      return { recorded: `referral ${referralFeeId}` };
    }

    const invoiceId = invoiceIdOn(obj);
    if (invoiceId !== null) {
      // Stripe's cut, read off the charge: its own cost row beside the
      // payment. Best effort - a fee that has not settled yet is zero here
      // and a parity finding later, not a 500.
      const feeCents = intentId ? await paymentFee(intentId, account).catch(() => 0) : 0;
      const r = await recordStripePayment({
        invoiceId, amountCents, reference, method, feeCents, tenantOrgId: org.id, receivedOn,
      });
      if (r.recorded) return { recorded: invoiceId };
      // Named an invoice this money cannot settle - another workspace's, a
      // voided one. It still arrived, so it is offered rather than dropped.
      const s = await suggestStripePayment({ tenantOrgId: org.id, reference, amountCents, method, receivedOn });
      return { suggested: s.id ?? null, reason: r.reason };
    }
    const s = await suggestStripePayment({ tenantOrgId: org.id, reference, amountCents, method, receivedOn });
    return s.suggested ? { suggested: s.id ?? null, invoice: s.invoiceNumber ?? null } : { ignored: "nothing to suggest" };
  }

  // Money back. Stripe reports the charge's cumulative refunded amount; the
  // settle step posts only what this instance has not recorded yet.
  if (type === "charge.refunded") {
    if (!org) return { ignored: "no workspace owns that account" };
    const r = await recordStripeRefund({
      tenantOrgId: org.id, paymentIntentId: str(obj.payment_intent), chargeId: str(obj.id),
      refundedCents: cents(obj.amount_refunded), on: dayOf(event.created),
    });
    return r.posted ? { refunded: r.cents } : { ignored: r.reason ?? "refund" };
  }

  return { ignored: type };
}
