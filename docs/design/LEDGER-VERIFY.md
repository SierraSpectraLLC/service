# Ledger: what landed, what I changed my mind about, what is still open

Branch `claude/elegant-dijkstra-38y82v` (the brief said `feature/ledger`; the
session was handed this name), seven commits over ten stages, 134 files,
+9,727 / -3,346 (28 of the files are captures). Every stage ended at its gate
and the gate was run, not assumed. This file is the record of that, and of every place I did something
other than what the build brief said.

Read the deviations section first. It is where one-pass drift would show up.

---

## Stage by stage

### Stage 1 - the journal, the chart, the closed-month setting

`ledger_entries` (posted_on, memo, ref_type, ref_id, ref_org_id,
ref_work_order_id, reverses_id, posting_key, posted_by, tenant stamp) and
`ledger_lines` (account, debit_cents, credit_cents, with a CHECK that exactly
one side is positive). `bank_transactions` and `payroll_runs` defined now for
stages 3 and 7. `app_settings.books_closed_through`. Mirrored additively in
`drizzle/schema-sync.sql`, with the one-side CHECK and the unique partial index
on `(tenant_org_id, posting_key)` living there as every constraint does.

`lib/ledger/accounts` is the fixed chart: seventeen keys, a side and a group
each, and no way for a user to add one. `revenueAccountFor(kind)` is the one
place a line kind becomes a revenue account.

**Gate 1**: typecheck clean, `[schema-mirror] OK`, the guard suites green with
the four new stamped tables added to `tests/tenantStamp`'s list.

### Stage 2 - post, reverse, sums, close

`post()` is the one door. Balanced or refused; a closed month or refused; and
**idempotent on a posting key** (`ref_type:ref_id:kind`), which is how the
invariant "never posted twice" holds on the Neon HTTP driver, where there are
no transactions to hold it (deviation 1). `reverse()` is the only correction: a
mirror dated today with the reason on it, refused for an entry the bank has
matched and for an entry that is itself a reversal. `sums` is one query shape
filtered six ways; `positions()` and `periodFlow()` are the two calls every
screen makes. `close` reads and writes the setting and says why a month cannot
close.

**Gate 2**: fifteen DB-backed tests in `tests/ledger.test.ts` against an
in-process Postgres seeded from the real `schema-sync.sql`: an unbalanced entry
refused, a closed month refused, a reversal that balances the original, a
bank-matched entry that refuses reversal, and a random batch of a hundred
entries whose debits equal their credits in every account.

### Stage 3 - every money action posts

`lib/ledger/postings` is the one answer to what each document does to the
money: the send (with tax and deposit lines), the payment, the fee and its
waiver, the credit memo, the receipt, the vendor paid, the bill cycle, the
claim paid, the company-paid receipt, the payroll run, the opening balance,
the Stripe fee, the payout, the tax remittance, the referral fee. The invoice,
collections, deposit, cash, payout and overhead actions moved into
`app/money/actions.ts` with their authorization unchanged and `houseOf()` on
every row; `receivePoLine`, quote approval, job expenses, historical invoices,
the bills cron and the Stripe settle path post in place. `deletePayment` is
now a reversal. New: `payPurchaseOrder`, `runPayroll` (into `payroll_runs`),
`remitTax`, `reverseLedgerEntry`, `closeBooks`.

**Gate 3**: 23 DB-backed tests in `tests/ledgerPostings.test.ts` run the real
actions with only the session faked and assert the accounts and amounts of
every entry in the brief's table. `tests/serverActionShape` and
`tests/tenantWriteScoping` pass over the new file.

### Stage 4 - backfill and parity

`scripts/backfill-ledger` derives the journal from history through the same
posting functions the actions use, keyed so running it twice gives once, with
`--dry-run` routed through a sink in `post()` so what it prints is what it
would write. `dev:local` runs it after the fixture. `lib/ledger/parity`
computes ten figures both ways per workspace; `/api/cron/ledger-parity`
stores each run in `ledger_parity`; `/parity/ledger` shows the live figures
with the reason beside every gap. Unstamped legacy rows map to the operator's
own workspace.

**Gate 4**: `tests/ledgerBackfill.test.ts` pins idempotence (a second run
writes nothing) and a parity that reads zero on nine figures. The tenth is
`cash`, and it is the one deliberate nonzero: `lib/cash` never counted a
company-paid job expense or a paid purchase order, and the ledger does. That
is the old formula being wrong, written up rather than matched.

### Stage 5 - the reads flip, seven rooms

`lib/money/figures` builds one `MoneyFigures` per request from `SUM()` over
`ledger_lines`: positions, cash, runway, the period's flow, collected,
receivable stages, payables, holds, and the decision list. `lib/finance` names
seven rooms (`/money`, `/money/cash`, `/money/receivables`, `/money/payables`,
`/money/clients`, `/money/ledger`, `/money/reports`); the old paths (quotes,
invoices, collections, contracts, expenses, bills, costing) redirect into them
through `RETIRED_ROUTES`. The rail carries the figures; the digest's money
section is a projection of the same decision sources (`digestInputFrom`).

**Gate 5**: typecheck clean; the finance, books, nav, digest and tenant
isolation suites rewritten against the new shape and green; the nav snapshot
regenerated and read.

### Stage 6 - screens per the prototype

`Figure` is the one component a dollar renders through, and every figure is a
link into the Ledger page filtered to the rows that make it. Home: the cash
line, the three positions, "Needs a decision" with the button beside the row,
money in and money out. Receivables: the four stages. Payables: owed now,
committed, standing bills, overhead. Clients: standing table and the per-client
view with "what they see". Ledger: GET filters, one expandable entry per row,
debits equal credits in the header. Reports: P&L beside cash flow with the gap
between them named, margin by client, close the books, the two exports, job
costing. The prototype is at `docs/design/ridgeline-financial-prototype.html`.

**Gate 6**: 28 captures under `docs/design/screens/money/` at 1280 and 375,
no horizontal scroll at either width on any of the nine staff rooms or the two
portal pages. The three style guards (`spaceScale`, `mobileInput`,
`clientBundle`) green after two corrections they caught (see bugs).

### Stage 7 - bank feed, reconciliation, forecast

`lib/bank/sync` is Plaid Transactions through its sync endpoint, a cursor per
workspace in `bank_connections`, pulled hourly by `/api/cron/bank-sync` and by
hand from the Cash page; with no keys the page says so and takes a pasted
statement instead, idempotent on the line's own content. `lib/ledger/match`
suggests a home for each line in order of confidence (a live cash entry of the
same amount within a week, an open invoice with that balance, or one of four
accounts to post to). `lib/money/forecast` is the eight-week line from
commitments only. The Cash page carries the dashed "Not until Craton" panel
and nothing else about operating accounts, cards, pockets or escrow.

**Gate 7**, in a browser against `dev:local`: pasted three statement lines;
the $738 check matched the payment entry the books already had, the $4,348
ACH was recorded as a payment on INV-0087 and matched in one click, the fuel
line posted to field expenses and matched; "0 bank lines unposted" afterwards.
The reversal dialog took a reason and reversed entry #11 with the mirror dated
today. Closing through August, then logging a company-paid expense dated
2026-08-20, was refused with "2026-08-20 is in a closed month. Post it today
instead - the record keeps both."; the same expense dated 2026-09-10 posted.
Captures: `cash-feed`, `cash-reconciled`, `ledger-reverse-dialog`,
`ledger-reversed`, `reports-closed`, `payables-closed-refusal`.

### Stage 8 - Stripe finished

`/pay/[token]` points at `/share/[token]`, which already was the pay link
(deviation 8). The webhook now reads the fee Stripe kept off the charge's
balance transaction (`stripeApi.paymentFee`) and posts it as its own cost row
beside the payment, and takes `payout.paid` for a connected account: stripe
down, bank up, keyed on the payout id, attributed to the workspace whose org
row holds that account id and ignored otherwise. A quote approved with a
deposit mints the deposit invoice's own pay link and the page they approved on
says "Pay the deposit".

**Gate 8**: `tests/stripeWebhookRoute.test.ts` drives both branches with
correctly signed payloads and fakes only the settle functions. A real $1 test
payment was not made (see open).

### Stage 9 - sales tax

Already true at stage 3 and confirmed: `buildInvoiceLines` prices tax on the
parts not covered at the invoiced site's `tax_rate_bps`, as its own line of
kind `tax`, which the composer shows on a draft, the letter prints, and
`invoiceSendLines` posts to `sales_tax_owed`. `remitTax(period)` posts
`sales_tax_owed` down, bank down with `ref: tax`. The Payables room shows tax
owed as one of the three things owed now.

### Stage 10 - close, exports, portal

Close: Reports > Close the books; `post()` refuses; reversals date today.
Exports: `ledgerCsv` (entry, date, memo, document, account, debit, credit) and
`ledgerIif` (a TRNS/SPL block per entry), owner only, as downloads from
`/money/reports/export`. Portal: `/orders` carries the statement (open,
payable now, under question) and what is left on each live agreement we hold;
each open order's lines carry "Ask about this", which opens the same
`disputes` row the shop's `openDispute` writes, from the client's side.

**Gate 10**: the exports under test row for row; in the browser as the client
(Maria at Lab Zen) the statement and allowances rendered, the question on
INV-0092 was sent and came back as "asked · waiting on the shop" on reload.

---

## Schema-sync diff

+167 lines, -0. **Six new tables** (`ledger_entries`, `ledger_lines`,
`bank_transactions`, `bank_connections`, `payroll_runs`, `ledger_parity`) and
columns added to three existing ones: `app_settings` (1),
`invoice_fees` (1), `purchase_orders` (3).

No `DROP`, no `RENAME`, no `ALTER COLUMN`, no type change to anything that
existed. The mirror check reports 1635 columns all mirrored.

`db:push` against Neon was **not** run from this session: there are no
database credentials here, and the README's deploy path applies
`schema-sync.sql`, which carries every change additively.

## Every dollar is a SUM

`grep "balanceCents|outstandingCents|remainingCents|balance_cents"` over
`src/db/schema.ts` and `drizzle/schema-sync.sql` still returns exactly one
hit, `orgs.po_balance_cents`, which is the client's number and not ours. The
ledger tables hold lines; every figure on the seven rooms, the rail, the owner
view and the digest is `SUM()` over `ledger_lines` through `lib/ledger/sums`.
The one thing that still projects is the forecast, and it says so on the page.

## Invariants

- **Append-only.** No update or delete of `ledger_entries` or `ledger_lines`
  exists in `src/`; corrections are `reverse()`.
- **Balanced.** Refused in `post()` before any write; a random batch of a
  hundred entries is under test.
- **Closed periods refuse postings.** Refused in `post()` unless the caller is
  the backfill; exercised in a browser at stage 7.
- **Bank-matched entries cannot be reversed.** Refused in `reverse()`; under
  test.
- **Tenant-stamped.** Every entry takes the stamp of the document that caused
  it; `tests/tenantStamp` scans every insert.
- **Never posted twice.** The unique partial index on the posting key, and
  `post()` returning the existing entry rather than writing another.

## Cross-org isolation

`tests/moneyTenantIsolation.test.ts` seeds two operators on one instance and
asserts each money reader (invoices, quotes, unbilled jobs, the collections
board, the digest) returns only the asking workspace's rows, and that the
platform's own staff still read the whole instance; every ledger read takes
`tenant` in its filter and `sumsByOrg` groups inside a tenant. The client
portal reaches money only through `invoiceForOrg`, `invoicesForOrg` and the
org id on the login, and `askAboutLine` re-reads the invoice with
`orgId = user.orgId` in the WHERE clause.

## Audit rows

Confirmed present, by reading each function body: every action in
`app/money/actions.ts` (send, payment, reversal, void, fee, waiver, promise,
dispute open and resolve, deposit request, cash opening, claim paid, overhead
logged, purchase order paid, payroll run, tax remitted, entry reversed, books
closed and reopened, parity run, bank connect, sync, opening, import, match,
record, post, unmatch, ask about a line), the Stripe-recorded payment, the
Stripe fee, the payout, and the referral payment.

## Tests

4225 passing across 302 files, up from 4172 across 296. `next build` compiles
and generates every route, the seven rooms, `/pay/[token]`,
`/money/reports/export` and `/parity/ledger` among them (with a placeholder
`DATABASE_URL`, because `src/db` opens the Neon client at import and this
container has none). The one failure is a pre-existing environment failure:
`tests/stripe.test.ts > stripeMode > reads the key rather than a flag`
expects `stripeMode(undefined)` to be `"absent"` and this container sets
`STRIPE_SECRET_KEY`; it passes with the variable unset and is not a code
change. New files: `ledger` (DB), `ledgerPostings` (DB), `ledgerBackfill`
(DB), `ledgerMatch`, `ledgerExports`, `moneyDecisions`, `moneyForecast`,
`stripeWebhookRoute`. Rewritten: `finance`, `books`, `nav` (snapshot),
`moneyTenantIsolation`, `overheadExpense`, `expenseRowOpen`. Removed:
`paidOut` (its subject, the paid-out summary, is now `periodFlow`).

---

## Deviations from the build brief

Each of these is a place I did something other than what the document said,
and why. The rule was that the code wins over the brief and the deviation is
written up.

**1. No transactions.** The brief's `post()` "wraps in a transaction". The
Neon HTTP driver has no `db.transaction`, and nothing in this codebase uses
one. The invariant the transaction was for - never posted twice - is held by
the posting key instead: `ref_type:ref_id:kind`, unique per tenant, with
`post()` returning the existing entry on a retry. The entry and its lines are
two inserts; an entry whose lines failed to insert would be unbalanced, and
`checkLines` runs before either.

**2. `hold_after_days` was not added.** `billingPolicy.holdDays` already
exists on the policy JSON; a second column would be a second answer.

**3. An `expense` ref type.** Not in the brief's vocabulary. A hand-logged,
company-paid receipt (an overhead bill, a crane on a job) is neither a bill
cycle nor a claim, and the code has always had it as its own row.

**4. The payroll register stays at `/money/payroll`.** It is not one of the
seven rooms and it is not redirected: whoever may read it reaches it from the
rail's Payroll entry and from Payables; a client manager with the payroll flag
reaches it from their own portal, which a redirect into `/money/payables`
would have broken. The register gains the monthly run.

**5. Two kinds of deposit post to two accounts.** A quote's deposit invoice
posts to `deposits_held` (a liability; the work is not done) and the final
invoice's "Less deposit invoiced on Q-..." line debits it. The
"deposit to clear" a credit hold demands posts to `revenue_fees`: it is a
charge for reopening the account, not money held against a job, and the
invoice that raises it says so.

**6. Parity re-implements the legacy formulas per tenant.** `financeFigures`
scopes by `readTenant()`, which is null for the platform's own operator and
therefore reads the whole instance. Parity has to compare one workspace with
one workspace, so each legacy formula is repeated with an explicit tenant and
a comment naming the page it came from.

**7. The seed derives its ledger through the backfill** rather than posting
in the seed: same posting functions, one code path, and the seed cannot drift
from the actions.

**8. The pay link is `/share/[token]`, and `/pay/[token]` is a redirect to
it.** The share link already was the credential and the org on its row the
authorization, with card and ACH on the hosted page; a second room with its
own lock would have been two ways to pay one bill.

**9. One webhook event for money in.** The brief names
`payment_intent.succeeded`; the code listens to `checkout.session.completed`
and says why in the route: sessions, intents and charges all describe the same
money, and listening to more than one is how a payment is recorded twice. The
fee is read off the intent's charge when the session settles. `payout.paid`
is new and is its own branch.

**10. The deposit at approval is an invoice, not a payment intent.**
`applyQuoteApproval` already raised a deposit invoice due on approval, posted
as a liability; it now mints that invoice's pay link so the client pays it on
the same visit, through the same hosted page as any invoice. A payment intent
created at approval would have been money asked for with no document behind
it.

**11. A read-only client cannot "Ask about this line".** The brief names
`client_viewer`. The code's rule, in `lib/authz`, is that a viewer is
read-only, and a question here pauses collection on the line, which is a
change to the books. `client_editor` and the client's owner can; the viewer
reads the state of a question someone else asked.

**12. Allowance remaining is on `/orders`, and says when it cannot read.**
`ClientCoverage` on the landing page deliberately shows entitlements and not
usage, because the usage library folded a failed read into a zero. The
portal's statement page now shows the drawdown, with a failed read rendered
as "Usage could not be read just now" rather than "0 of 8 visits used".

**13. The working rooms (Purchasing, Reimbursements) live under Operations
for everyone.** The brief's Financial section is the seven rooms over the
journal and neither of these is one of them; `lib/finance.WORKING_ROOMS` no
longer puts them in the Financial menu for readers who have one. The nav test
that pinned the old rule was rewritten to pin this one.

**14. The platform operator's own books scope by `myTenantOrgId`.**
`readTenant()` is null for the platform's own operator; every ledger read and
write uses `myTenantOrgId(u)` so the operator's own rows are stamped and
found. `logOverheadExpense` was the one that got this wrong first (see bugs).

**15. `paidOut.test.ts` was deleted, not rewritten.** Its subject
(`lib/financeData.paidOut`) no longer exists; the figures it summed are
`periodFlow`'s cost side, covered by the ledger suites.

**16. The Plaid client is hand-rolled** (four `fetch` calls) rather than the
SDK, for the same reason `stripeApi` is: it is a page of code, and the SDK's
dependency tree is not.

---

## Bugs the gates caught

Worth recording, because each one was invisible until something was run.

**Every confirm dialog in the new components hung the page.** `confirmDialog`
was awaited *inside* `startTransition(async () => ...)`. In React 19 an
update made inside an async transition commits when the action settles, and
the action was waiting on the dialog it had not yet shown. The button said
"Reversing…" forever. Found in the browser at stage 7, when the reversal
never asked for its reason; the dialog is now asked before the transition in
all five places, which is the pattern every older component already used.

**`logOverheadExpense` stamped the platform operator's rows with null.** It
used `readTenant(u)`; the operator's ledger could not see its own overhead.
Caught by `tests/ledgerPostings` on the first run.

**Two bank inserts and one cron read failed the tenant guards.** The stamp
was in a spread object rather than the literal `tenantStamp` scans for, and
`syncAllBanks` reads every connection by design. Both inlined or justified;
the guards are what say every row is somebody's.

**The ledger filters stacked full-width at 1280.** The global `input, select`
rule sets a width; the row needed `width: auto` on its own controls. Seen in
the first capture.

**Two of my CSS rules sized a field under 16px after the mobile block**, and
five inline spacings were off the 4px grid. `tests/mobileInput` and
`tests/spaceScale` caught both; fields inherit now and the spacings are on
`--sp` steps.

**The backfill test's expected parity was wrong about a credit memo.** The
legacy revenue formula attributes a credit to the month the dispute was
resolved, the ledger to the day it was posted; the test now scopes each side
to the same day and the difference reads zero.

**The order of entries in a test is not their id.** A send dated today sorts
after a backdated payment; two assertions that indexed by position were
rewritten to pick the entry by memo.

---

## Open, and deliberately not done

**A real Stripe round trip was not performed.** Gate 8 asks for a $1 invoice
paid by card and by ACH in test mode. Creating a Checkout Session and
receiving `payout.paid` need live test credentials, which this environment
does not have. Everything on our side of the boundary is under test with
signed payloads; the one untested link is Stripe's own delivery. Run it once
on a preview with test keys, and check the fee row lands beside the payment
and the payout row lands pre-matched.

**A real Plaid pull was not performed**, for the same reason. The sync loop
is written against Plaid's documented page shape and `syncConnection` takes
the page fetcher as a parameter so it can be tested without the network;
pasted statements are the path that was exercised end to end.

**`db:push` was not run** (above). Nothing here presumes it; the mirror is the
deploy path.

**dev:local restarts itself under the production build's memory.** Next's
dev server restarted once "approaching the used memory threshold" during the
browser gates, and the in-process PGlite aborted on the second restart; a
fresh data directory recovered it. Not a product bug and not new, but worth
knowing before running the gates on a small machine.

**The Stripe balance in the parity view** is the ledger's alone; there is no
legacy figure for it, so the row reads the ledger on both sides. It becomes a
real comparison once a Stripe balance can be read from the API.

**Not built, and drawn as the line:** operating account, cards, funded
pockets, escrow. The Cash page carries one dashed panel that says so, as the
prototype does.
