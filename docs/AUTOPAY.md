# Autopay — charging a card on file for recurring work

*Design note, August 2026. Nothing here is built. Written after asking whether an operator
could reproduce, inside Ridgeline, the monthly card billing they used to run directly in
Stripe. The answer was "three of the four steps," and this records which step is missing,
what it would take, and the decisions that are not a developer's to make.*

---

## 1. What already runs

Three quarters of the loop exists and is solid.

**The standing instruction** lives on the agreement: `bill_every_months`,
`bill_amount_cents`, `bill_description`, `bill_day_of_month`, `bill_lead_days`, plus the
cursor pair `bill_next_on` / `bill_last_on` (`src/db/schema.ts:2487`).

**The cycle maths** is pure and tested — `dueCycles` and `missedCycles`
(`src/lib/recurring.ts:174`, `:145`), both capped so a misconfigured contract cannot
raise two hundred cycles at once.

**The pass** is `runRecurring` (`src/lib/recurringRun.ts`), fired daily by
`/api/cron/recurring` at `0 13 * * *`. It catches up on cycles it missed and cannot
double-bill: `raiseRetainerCycle` (`src/app/actions.ts:15807`) writes `bill_last_on` in
the same breath as the invoice and refuses a cycle at or before it.

**It raises a DRAFT and never sends.** This is deliberate and should survive anything
below — the comment at the top of `recurringRun.ts` puts it plainly: *a $20,000 invoice
leaving for a client because a job fired overnight is a decision nobody made*.

**Payment is a link the client taps.** `sendInvoice` (`src/app/actions.ts:14406`) mints a
share token, flips the invoice to `sent` and mails it; the client opens `/share/<token>`
and `startPayment` (`:15570`) builds a Stripe-hosted checkout.

## 2. What is missing

One Stripe concept: **a saved payment method**. There is no `setup_intent`, no `customer`,
no `payment_method` and no `off_session` anywhere in the codebase. `checkoutSession`
(`src/lib/stripeApi.ts:89`) is `mode: "payment"` — a one-off PaymentIntent with
`on_behalf_of` and `transfer_data.destination` aimed at the operator's Connect account.

So today the honest description is *"an invoice appears in your client's inbox every month
and they tap Pay,"* not *"the card gets charged."*

## 3. A premise worth correcting before anyone plans around it

**Stripe does auto-generate invoices.** Stripe Billing runs subscriptions, generates the
invoice on schedule, emails it, and charges a saved card automatically
(`collection_method: charge_automatically`). Anyone who has billed a retainer monthly in
Stripe has used it.

That matters here for a reason specific to this architecture: Connect Express means the
Stripe account belongs to the **operator**, not to Ridgeline (`src/lib/stripe.ts:5`). Every
service company on this platform can already go and run Stripe Billing themselves,
today, without us. "We do recurring billing" is therefore not a reason for anybody to
move, and a pitch built on it will not survive the first prospect who knows Stripe.

## 4. Where the argument actually is

The invoice comes out of the **service record**. Stripe Billing knows an amount and a
date. It does not know that July's invoice should carry two out-of-contract visits, a
filter kit drawn against a $2,000 parts allowance, and 3.5 hours over the included labour
— which is what `coverageFor` and `buildInvoiceLines` (`src/lib/billing.ts`) already
compute from the agreement's entitlements and the work that was actually done.

So the line to a service provider is not *move your billing to us*. It is **stop typing
your invoices twice**: the retainer, the overage and the parts draw-down are all in the
record of the work already, and the bill should fall out of it.

Autopay is what makes them **willing** to move. It is not the thing worth moving for.
Building it as a headline feature gets the positioning backwards.

## 5. Sketch

All of it on the operator's connected account (`Stripe-Account` header), never the
platform's — the card belongs to their customer relationship, and it keeps PCI scope where
`lib/stripe.ts` already argues it belongs.

1. **Authorize once.** A hosted Checkout in `mode: "setup"` against a Stripe `customer`
   stored on the client org. Reached from the client portal, so the client does it
   themselves and no card number touches this server, exactly as now.
2. **Charge at SEND, not at raise.** A PaymentIntent with `customer`, `payment_method`,
   `off_session: true`, `confirm: true`, hung off `sendInvoice`. A human still approves the
   invoice — the never-sends discipline is untouched — and the client does nothing at all.
3. **Reconcile through the existing webhook.** `api/stripe/webhook` already matches a
   payment back to an invoice by `metadata[invoiceId]`; an off-session charge carries the
   same reference and needs no second path.

## 6. The harder half, which is policy

Not developer decisions. Listed because building the mechanism without settling these
would be worse than not building it.

- **A per-charge cap, per client.** Auto-charging whatever the invoice happens to say is
  how a $22,000 emergency repair lands on a lab manager's corporate card overnight. Above
  the ceiling it falls back to a pay link. This is the single most important guardrail and
  the one a competitor's version usually lacks.
- **A stored mandate.** Who authorized, when, from what address — in the audit trail, like
  everything else here. "They said we could" is not a defence against a chargeback.
- **Failed charges join the dunning ladder** (`src/lib/dunning.ts`) rather than retrying
  silently. A card that declines is a collections event, not a transient error.
- **Push ACH over cards.** 0.8% capped against 2.9% + 30¢ on a $4,000 monthly retainer is
  roughly $115 a month back to the shop. `billingPolicy` already carries a card surcharge
  (`cardSurchargeBps`, default 290) which makes card autopay awkward for the client anyway
  — saved `us_bank_account` mandates are the better rail and the better story.
- **Cancellation has to be one click, from the client's side.** A saved mandate a client
  cannot revoke themselves is the thing that generates the complaint.

## 7. Monetization, noted and not decided

`app_settings.platform_fee_bps` (`src/db/schema.ts:3701`) is already wired as a Stripe
application fee on every charge. It is 0, and its comment says it must stay 0 until
somebody deliberately decides otherwise.

Autopay volume is the obvious place a few basis points would be worth something. It is
also the fastest way to lose an operator: a platform that quietly starts taking a
percentage of their revenue is a platform they leave. If it is ever turned on it should be
a term somebody agreed to, not a default they discover.

## 8. Related, still open

The referral fee on a handed-over client accrues from the recipient's invoices **inside**
Ridgeline (`src/lib/referralData.ts:25`). A percentage fee therefore gives the recipient a
standing reason to bill that client somewhere else — which costs the sender their fee and
us the conversion signal at once. A flat placement fee does not have that problem. Worth
settling before there are many of these in the wild.
