// Taking a card or an ACH debit, without ever touching either.
//
// THE SHAPE OF THIS, and why it is the shape it is:
//
//   Connect Express. The Stripe account belongs to the OPERATOR - the service
//   company - not to Ridgeline. Stripe does the KYB on them, money moves bank
//   to bank from the client to them, and this platform never holds funds. A
//   platform that holds other people's money is a money transmitter, which is
//   a licence, an audit and a different company.
//
//   No card data, ever. The pay page hands off to a Stripe-hosted checkout;
//   no card number reaches this server, this database, or these logs. That is
//   what keeps PCI scope at the level a two-person shop can actually meet.
//
//   TEST MODE ONLY, until somebody deliberately does otherwise. `liveMode`
//   reports what the configured key actually is, and every surface says so,
//   because the failure everybody has seen is a test key quietly left in
//   production - or worse, the reverse.
//
//   No keys, no buttons. Absent configuration is a supported state, not an
//   error: the portal falls back to "here is how to send a check", which is
//   how most of these invoices get paid anyway.
//
// This file is PURE: config reading and arithmetic, no node builtins and no
// network, because the client portal renders the disclosed card surcharge and
// a "use client" module that reaches node:crypto does not build at all. The
// calls that talk to Stripe live in lib/stripeApi, which only the server
// imports. tests/clientBundle.test.ts is what keeps that true.

export type StripeMode = "absent" | "test" | "live";

/** What is actually configured. Read from the key, never from a flag. */
export function stripeMode(key = process.env.STRIPE_SECRET_KEY): StripeMode {
  const k = (key ?? "").trim();
  if (!k) return "absent";
  if (k.startsWith("sk_live_") || k.startsWith("rk_live_")) return "live";
  return "test";
}

export const stripeConfigured = (): boolean => stripeMode() !== "absent";

/**
 * The banner every money surface shows. Empty in live mode - a live payment
 * page that shouts about its own configuration is noise to a client.
 */
export function modeNotice(mode: StripeMode = stripeMode()): string {
  if (mode === "test") return "Stripe is in TEST MODE. No money moves; use a test card.";
  if (mode === "absent") return "";
  return "";
}

export type PayMethod = "ach" | "card";

/**
 * What the client is asked for, including the surcharge on a card if the
 * operator passes one on.
 *
 * The surcharge is DISCLOSED and computed here rather than buried in the
 * total: a card fee a client discovers on their statement is a chargeback, and
 * in several states an undisclosed one is also illegal.
 */
export function payAmount(input: {
  balanceCents: number;
  method: PayMethod;
  cardSurchargeBps: number;
  cardSurchargeFlatCents: number;
}): { amountCents: number; surchargeCents: number; line: string } {
  if (input.method !== "card" || (input.cardSurchargeBps <= 0 && input.cardSurchargeFlatCents <= 0)) {
    return { amountCents: input.balanceCents, surchargeCents: 0, line: "" };
  }
  const surcharge = Math.round((input.balanceCents * input.cardSurchargeBps) / 10000)
    + input.cardSurchargeFlatCents;
  return {
    amountCents: input.balanceCents + surcharge,
    surchargeCents: surcharge,
    line: `Card payments carry a ${(input.cardSurchargeBps / 100).toFixed(2)}% processing fee`
      + `${input.cardSurchargeFlatCents > 0 ? ` plus $${(input.cardSurchargeFlatCents / 100).toFixed(2)}` : ""}`
      + `, shown here before you confirm. Paying by bank transfer avoids it.`,
  };
}

/** The platform's cut, in cents. Zero unless somebody set the bps. */
export const platformFee = (amountCents: number, bps: number): number =>
  bps <= 0 ? 0 : Math.round((amountCents * bps) / 10000);
