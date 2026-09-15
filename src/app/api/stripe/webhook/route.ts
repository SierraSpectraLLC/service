import { NextResponse } from "next/server";
// A plain module, not the server-action surface - see lib/stripeSettle.
import { recordReferralPayment, recordStripePayment, recordStripePayout } from "@/lib/stripeSettle";
import { paymentFee, verifyWebhook } from "@/lib/stripeApi";

export const dynamic = "force-dynamic";

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

  // `account` is whose event this is: a direct charge lives on the operator's
  // connected account, and every read back to Stripe about it has to say so.
  let event: { type?: string; account?: string; data?: { object?: Record<string, unknown> } };
  try {
    event = JSON.parse(raw);
  } catch {
    return NextResponse.json({ error: "bad payload" }, { status: 400 });
  }

  // The other thing Stripe tells us: the balance went to the bank. A payout
  // is not a payment - no invoice, no client - so it takes its own branch and
  // its own posting, keyed on the payout id so a redelivery posts nothing.
  if (event.type === "payout.paid") {
    const payout = event.data?.object ?? {};
    const arrival = Number(payout.arrival_date ?? 0);
    try {
      const r = await recordStripePayout({
        account: String(event.account ?? ""),
        payoutId: String(payout.id ?? ""),
        amountCents: Math.round(Number(payout.amount ?? 0)),
        arrivalDate: arrival > 0 ? new Date(arrival * 1000).toISOString().slice(0, 10) : "",
      });
      return NextResponse.json(r.posted ? { posted: String(payout.id ?? "") } : { ignored: r.reason ?? "payout" });
    } catch (e) {
      return NextResponse.json({ error: (e as Error).message }, { status: 500 });
    }
  }

  // One event type for money in. Payment intents, charges and sessions all
  // describe the same money, and listening to three of them is how one
  // payment gets recorded twice.
  if (event.type !== "checkout.session.completed") {
    return NextResponse.json({ ignored: event.type ?? "unknown" });
  }

  const session = event.data?.object ?? {};
  const metadata = (session.metadata ?? {}) as Record<string, string>;
  const invoiceId = parseInt(metadata.invoiceId ?? "", 10);
  const referralFeeId = parseInt(metadata.referralFeeId ?? "", 10);
  const amount = Number(session.amount_total ?? 0);
  const reference = String(session.payment_intent ?? session.id ?? "");
  const method = Array.isArray(session.payment_method_types)
    ? String((session.payment_method_types as string[])[0] ?? "")
    : "";

  if (amount <= 0 || !reference) {
    return NextResponse.json({ ignored: "no amount or reference on the session" });
  }

  try {
    /* Two things this app takes money for, told apart by which key the
       session carries. A referral fee between two service companies moves the
       same way an invoice does and settles a different row. */
    if (Number.isInteger(referralFeeId)) {
      await recordReferralPayment({
        feeId: referralFeeId, amountCents: Math.round(amount), reference,
      });
      return NextResponse.json({ recorded: `referral ${referralFeeId}` });
    }
    if (!Number.isInteger(invoiceId)) {
      return NextResponse.json({ ignored: "nothing on the session to settle" });
    }
    // Stripe's cut, read off the charge: its own cost row beside the
    // payment, so the gross in the Stripe balance and the net that will
    // reach the bank are both on the books. Best effort - a fee that has not
    // settled yet is zero here and a parity finding later, not a 500.
    const feeCents = await paymentFee(String(session.payment_intent ?? ""), String(event.account ?? "")).catch(() => 0);
    await recordStripePayment({
      invoiceId, amountCents: Math.round(amount), reference,
      method: method === "card" ? "card" : "ach", feeCents,
    });
    return NextResponse.json({ recorded: invoiceId });
  } catch (e) {
    // A 500 makes Stripe retry, which is what we want: the money really did
    // move, and the row has to exist eventually.
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
