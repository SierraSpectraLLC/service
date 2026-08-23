# Billing: what landed, what I changed my mind about, what is still open

Branch `feature/billing`, nine commits, 83 files, +10,921 / -59. Every stage
ended at its gate and the gate was run, not assumed. This file is the record of
that, and of every place I did something other than what the build instructions
said.

Read the deviations section first. It is where one-pass drift would show up.

---

## Stage by stage

### Stage 1 - schema, rate cards, the composer

`rate_cards` (three rungs: agreement, org, workspace default), `expenses`
against the work order, `time_entries.billable` and `.category`, billing
columns on `orgs`, `org_sites.tax_rate_bps`.

`lib/rates` resolves which card applies and prices an hour. `lib/billing`
composes the lines an invoice would carry - parts, labour by category, travel
at its own rate, expenses, then tax on the parts that are actually being sold.
`lib/billingPolicy` is one shape with two homes: workspace defaults in
`app_settings`, per-client overrides on `orgs`, resolved by layering.

The hours panel defaults `billable` from the agreement covering the system, so
an hour logged on a contract system arrives unticked with a line saying which
paper covers it. Ticking it is the deliberate act of saying "beyond contract".

**Gate 1**: 1407 tests green, typecheck clean, mirror OK, dev:local booted and
the panel rendered the new fields.

### Stage 2 - the invoice loop, /money, the client portal

`invoices`, `invoice_lines`, `payments`. No balance column between them: what
is owed is lines + fees - payments, summed at render. `status` is a lifecycle
word somebody wrote, and `lib/statement` reconciles it against the rows - a row
reading "sent" that sums to zero has been paid, whatever nobody clicked.

Lines keep `qty` in thousandths so 4.5 hours never becomes a float, and carry
`covered` plus the agreement number that absorbed them. A covered line prints
at $0 with its list price still on the row, which is the whole point of the $0
invoice.

`share_links` learned what is on the other side of them and when they were
opened. That open **is** the Viewed signal on the timeline.

**Gate 2**: draft to send to viewed to record-payment clicked through in a real
browser; the $0 covered invoice rendered with its agreement label; the
printable invoice carried the operator's letterhead; cross-org isolation
written as a DB-backed test.

### Stage 3 - collections

`invoice_fees`, `promises`, `disputes`, `dunning_events`, `credit_overrides`.

`lib/dunning` holds the ladder as **data** - seven rungs, each with an offset,
an action, a channel and which escalation contact it addresses. `nextAction`
returns the furthest rung due, not the earliest missed one. `lib/credit` is a
blunt two-trigger check because the person reading it is about to drive two
hours.

The dunning cron climbs at most one rung per invoice per day, only at that
client's send hour, only when `dunningAuto` is on, and never refers an account
or posts a fee on its own.

**Gate 3**: cron run by hand (advanced, then idempotent); fee posted with its
basis and waived with a required reason; dispute paused one line while the
invoice kept ageing; hold panel and owner override both demanded a reason;
partner-digest leak test green.

### Stage 4 - quotes, approval, renewals

`quotes` and `quote_lines`, composed by the same function that composes an
invoice. Expiry is a date comparison, never a job that rewrites rows overnight.

The client answers on the link. Approve is a signature - they type their name -
and the portal says what pressing it does before they press it. Declining posts
the reason to the job's discussion. Asking a question does **not** close the
quote.

The renewals cron now drafts the renewal as well as announcing it, priced off
the term's actual burn, and leaves it as a draft.

**Gate 4**: approve unblocked WO-0401 and raised the deposit invoice with the
discussion note; decline wrote the reason to the job and closed the quote;
renewal draft prefilled from burn and did not double-draft.

### Stage 5 - settings, exports, Stripe test mode

`/settings/billing` (owner only) and a Billing tab on each organization.
Three CSV exports. Stripe Connect Express in test mode, inert without keys.

**Gate 5**: a policy edit re-priced the fee quote from `1.50%/mo after 3 days`
to `2.00% per month on $4,348 undisputed, 42 days past the 0-day grace period`
while leaving the already-posted $58 row untouched; CSVs opened with the right
columns; the signed webhook recorded a payment, flipped the invoice to paid and
wrote `received $450 by bank transfer on INV-0092 - paid in full; the credit
hold has cleared`; forged, replayed and tampered payloads all got a bare 400;
with no keys, no pay buttons rendered and the portal explained how to send a
check.

### Stage 6 - fixtures, captures, this file

34 captures at 1280 and 375 under `docs/design/screens/billing/`, no horizontal
scroll at either width.

---

## Schema-sync diff

+398 lines, -1 (the diff header). **Twelve new tables**, and columns added to
five existing ones: `app_settings` (4), `orgs` (7), `share_links` (7),
`time_entries` (2), `org_sites` (1).

No `DROP`, no `RENAME`, no `ALTER COLUMN`, no type change to anything that
existed. The mirror check reports 950 columns all mirrored.

## No stored balances

`grep "balanceCents|outstandingCents|remainingCents"` over `src/db/schema.ts`
and `drizzle/schema-sync.sql` returns exactly one hit:

    orgs.po_balance_cents

That is **not** one of ours. It is how much room is left on the CLIENT'S
purchase order - a number their AP department tells us, which we cannot derive
from any row we hold. It is an input, like their address. Every figure this
application computes about its own money is summed at render.

`balanceCents` appears in eighteen source files as a **computed return field**
and in no table anywhere.

## Cross-org isolation

`tests/invoiceIsolation.test.ts` runs an in-process Postgres seeded from the
real `schema-sync.sql` and asserts `invoiceForOrg(1, 2) === null` - decided in
the WHERE clause, not by a redaction somewhere a future page could forget.

The share viewer reaches money only through `invoiceForOrg`, `invoicesForOrg`
and `quoteForOrg`, all of which take the org id off the link's own row. Its
other queries are scoped to the token, to that link's file rows, or to that org
id. The client components hold no database access at all.

## Audit rows

Confirmed present, by reading each function body:

invoice create, invoice send, payment record, fee post, fee waive, promise log,
dispute open, dispute resolve, hold override, policy edit (workspace and per
client), quote send, quote approve, quote decline, dunning rung, refer, and the
Stripe-recorded payment.

## Tests

1545 passing across 115 files, up from 1407. New: `rates`, `billing`,
`statement`, `invoiceIsolation` (DB-backed), `dunning`, `credit`, `quotes`,
`digestMoney`, `stripe`, `accountingExport`.

---

## Deviations from the build instructions

Each of these is a place I did something other than what the document said, and
why.

**1. "Nav word Billing after Purchasing in `navLinks`."** Purchasing lives in
the Operations *group*, not in `navLinks`, and the prototype's nav bar shows
Billing at top level. The prototype is named as the visual spec, so Billing is
a top-level link, staff only.

**2. "Number from the app_settings sequence."** Numbers are allocated by
scanning the highest one in use and retrying against a unique index - the same
read-max-and-retry `fileWorkOrder` has always used - with the prefix
configurable in `app_settings`. A stored counter would have been a second
mechanism for the same job.

**3. Rate multipliers are integer percentages** (`afterHoursPct`, `travelPct`)
rather than float multipliers, to keep money in integer arithmetic.

**4. Parts markup lives on `BillingPolicy`** (jsonb, per-org overridable)
rather than in a settings column. A client on a retainer is usually the client
who negotiated the markup down; that is a per-client fact.

**5. "The share viewer's existing open event IS the Viewed signal - do not
build a second tracking mechanism."** `share_links` had no open event at all.
Rather than adding a parallel tracker, the open is now recorded **on
`share_links` itself** inside the existing viewer, which honours the intent as
closely as the codebase allowed.

**6. "Approval moves the WO to Ready."** There is no Ready state here. A job
waiting on the client's answer sits in `waiting`; approval moves it to
`active`, which is what Ready meant.

**7. GATE 3 says "hold blocks a WO open"; the prototype says "New work opens on
hold."** I followed the prototype on *filing*: the job is created, visibly
held, because a client's instrument is down either way and refusing to record
that is a worse failure than the debt.

But the hold now REFUSES the two moves that commit somebody to a drive -
putting a named engineer on the job, and starting it - in the actions
themselves. See `lib/credit.holdRefusal` and `creditRefusal` in `app/actions`,
enforced from `openWorkOrder`, `updateWorkOrder` and `setWorkOrderState`.
Filing, notes, parts, hours, resolving and closing all stay open on a held
account: a job that cannot be recorded is a down instrument nobody knows
about, and one that cannot be closed is work that really happened with no
close-out.

This was corrected after the fact. In the first pass every read of `onHold`
was display: the panel said "On hold", the queue showed a column, the owner
override demanded a written reason and wrote an audited row - and nothing read
any of it to refuse anything. The engineer still got assigned and still drove.
The override gated a banner. Three test files now cover it: the rule
(`credit.test.ts`), the wiring (`creditEnforcement.test.ts`, a source scan in
the style of `tenantStamp.test.ts`, because the failure it catches compiles and
renders perfectly), and the data path against a real Postgres
(`creditHoldDb.test.ts`).

**8. The renewal quote's bundled line uses kind `fee_ref`, not `labor`.**
Rendering a year of scheduled service as labour printed "1 h" beside it. The
`fee_ref` label reads "Charge".

**9. The dunning cron never climbs the final rung.** Referring an account is a
decision; a decision that happens because a job fired at seven in the morning
is a decision nobody made. It is reported as waiting instead.

**10. `playwright` added as a devDependency.** Stage 6 requires captures.

---

## Bugs the gates caught

Worth recording, because each one was invisible until something was actually
run.

**The dunning cron sent the owner letter every hour.** A broken promise
promoted the next rung without checking whether it had already been climbed.
The skip now escalates by exactly one rung, onto an unclimbed one, and waits
for the calendar otherwise. `tests/dunning.test.ts` covers the shape.

**dev:local silently dropped every mutation.** Two PGlite handles on one data
directory are two databases sharing a folder. Next's dev server loads the db
module once for the RSC graph and again for server actions, so the action wrote
into one copy and the page read the other. One handle per process now.

**`lib/stripe` dragged `node:crypto` into the browser bundle** and the dev
build died. Split into `lib/stripe` (pure) and `lib/stripeApi` (server). The
guard that exists to catch exactly this - `tests/clientBundle.test.ts` - was
blind to `await import("node:crypto")` because it only matched static imports;
it now matches dynamic and `require` forms, and I verified it fails on the
shape that got past it.

**A failed payment showed the client Stripe's own error**, which named the
instance's key configuration. They now get a sentence they can act on; the real
reason goes to the audit log.

**The fee panel did not say what it was about to charge.** An operator about to
charge a client interest should see the amount before pressing, not discover it
in the row afterwards. The button now reads "Post $86.96" with the basis beside
it - which is also what made deviation-free verification of the policy re-price
possible.

**Fixtures had no `owner_org_id` on instruments or parts**, so
`lib/agreementUsage` counted nothing and the entire entitlement half of the app
read empty. Not a product bug, but it had been hiding one from view.

**The credit hold enforced nothing.** Every consumption of `onHold` was
display. `credit_overrides` rows were written, audited and read by no
enforcement path, so the reason the override demanded was protecting a pill.
Now refused at dispatch and at start, in the action rather than the form -
verified live: starting a held client's job was refused and the state stayed
`Waiting`; the override demanded a reason; the same start then went through and
was audited.

---

## Open, and deliberately not done

**A real Stripe round trip was not performed.** Creating a Checkout Session
requires a live call to Stripe with real test credentials, which this
environment does not have. Everything on our side of that boundary was verified
against a fake key: the mode banner, the button gating, the disclosed
surcharge, the graceful failure, and the full webhook path driven with
correctly-signed, forged, replayed and tampered payloads. **The one untested
link is Stripe's hosted page itself.** Run it once on a Vercel preview with
real test keys before trusting it.

**Live Stripe keys, real tax rates, and QBO account mapping are launch tasks**,
as the instructions said. Nothing here presumes them.

**The partner digest's handed-back rule changed** during this branch, on a
question you asked separately: it now lists only what came back since the last
edition and summarises the standing rest in one line. Six tests cover it.

**Deliberate omissions from the prototype**, all in the same category - screens
that describe work later stages own, or figures no row supports yet:

- The Collections ladder shows rung state and contacts but not the mockup's
  full seven-row timeline widget; the rungs and their dates are all present as
  data.
- "Request deposit to clear" on the hold panel is not wired; the amount that
  would clear it is computed and shown.
- The agency-packet export marks an invoice referred but does not zip the
  exhibits.
- Job costing appears on the invoice draft; there is no separate costing
  sub-tab under /money Overview.
- Metrics has no days-to-pay column yet.
