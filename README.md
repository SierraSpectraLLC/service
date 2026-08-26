# Ridgeline - Instrument Management

Replaces the client's Google Sheet with a real system: instrument tracking with
multi-stage tags, rich tasks (checklists, threaded notes, assignment), parts
orders with carrier tracking links, file attachments on Vercel Blob, an
append-only audit log, role-based client access, and an hourly parity check
against the old Google Sheet.

Stack: Next.js (App Router) · Neon Postgres · Drizzle ORM · Auth.js (magic
links via Resend) · Vercel Blob · Vercel Cron.

## Two names, and they are not the same name

**Ridgeline** is the PLATFORM - the product, its wordmark, its page titles, the
domain it is served from. It lives in `app_settings.platform_name` and is
edited in Settings > Configuration; no deploy renames it, and nothing in the
code hardcodes it (`lib/brand.DEFAULT_BRAND` is only the fallback for an
instance that has never been named).

**Sierra Spectra** is an OPERATOR - a service company running a workspace on
Ridgeline. Operators are ordinary `orgs` rows, and the operator is who *signs*:
service reports, sign-off packets, QR labels and both editions of the daily
digest carry the operator's name and logo, never the platform's
(`lib/brand.brandForTenant`). That is deliberate - a report about another
operator's work carrying the platform's name would be a false statement about
who did the work - and it means renaming the platform does not, and should not,
change what a client sees at the top of their report.

## Setup

### 1. Push to GitHub
```bash
cd sierra-spectra
git init && git add -A && git commit -m "Initial commit"
gh repo create sierra-spectra --private --source=. --push   # or push manually
```

### 2. Neon
Create a project at neon.tech. Copy the **pooled** connection string into
`DATABASE_URL`.

### 3. Resend (magic-link email)
Create a free account at resend.com, add an API key to `AUTH_RESEND_KEY`.
Verify your sending domain and set `EMAIL_FROM`, or use
`onboarding@resend.dev` while testing (it can only send to your own account
email).

### 4. Local env + database
```bash
cp .env.example .env
# fill in DATABASE_URL, AUTH_SECRET (openssl rand -base64 32),
# AUTH_RESEND_KEY, EMAIL_FROM, STAFF_EMAILS, CRON_SECRET
npm install
npm run db:push      # create tables in Neon
npm run db:seed      # load the sheet snapshot (11 instruments, tasks, parts)
npm run dev
```

`STAFF_EMAILS` is comma-separated; the **first** address becomes the owner
(sees Settings), the rest are staff. `CLIENT_EMAILS` lists Lab Zen accounts;
they can only sign in when the owner enables client access in Settings.

### No credentials? `npm run dev:local`

For UI work and screenshots there is a zero-setup path that needs no Neon, no
Resend and no env file:

```bash
npm install
npm run dev:local    # http://localhost:3100
```

It boots `next dev` against an in-process PGlite Postgres (a throwaway file
under `node_modules/.cache/ridgeline-pglite`), applies the same
`drizzle/schema-sync.sql` DDL every deploy runs, and seeds a small fixture -
two client orgs, six systems, ten assets, five work orders across the states,
one purchase order, one stockroom with a reorder list, one agreement - so
every list page has rows. There is no email sign-in; the seed forges an owner
session, and you enter with a cookie:

```
authjs.session-token=devtoken
```

The database swap lives in `src/db/index.ts`, gated on `NODE_ENV=development`
plus `LOCAL_DB=1` (which only `scripts/dev-local.ts` sets), so production code
paths are untouched. Delete the data dir to wipe and reseed. This harness is
what the per-page 375/1280 captures under `docs/design/screens/` are taken
from.

### 5. Vercel
Import the repo in Vercel. Add all env vars from `.env`. Then:
- **Region**: page speed is dominated by the latency between the Vercel
  function and Neon, multiplied by several queries per page. Make sure the
  project's function region (Vercel > Settings > Functions) matches the Neon
  project's region (shown in the Neon console) - a cross-country mismatch adds
  hundreds of ms per page load that no code change can recover.
- **Storage > Blob**: create a store; `BLOB_READ_WRITE_TOKEN` is injected
  automatically.
- **Payments**: Stripe Connect Express, TEST MODE until launch. Set
  `STRIPE_SECRET_KEY` and `STRIPE_WEBHOOK_SECRET` (see `.env.example`); leave
  them blank and the pay buttons do not render, which is a supported state -
  the portal tells clients how to send a check. The connected account belongs
  to the operator, not the platform: money moves bank to bank, no card number
  reaches this server, and Ridgeline never holds funds. The webhook at
  `/api/stripe/webhook` verifies signatures before parsing anything.
- **Cron**: `vercel.json` schedules `GET /api/cron/sheet-sync` and
  `GET /api/cron/daily-digest` hourly. Set `CRON_SECRET` in project env; Vercel
  sends it as the bearer token.
- **Daily digest**: built per engagement - one section per organization whose
  systems are in work. Each section carries what's blocked and whose move it is
  (theirs, ours, or a supplier's, with a part stuck without tracking or
  backordered stated as plain fact in the court of whoever ordered it), an
  internal follow-up list (see below), systems
  handed off to the partner's queue (out of our hands, never counted as
  blocked), what happened since yesterday, and a status board of stages, gases
  and open parts. The internal edition stitches every section together for
  staff; an organization opted in under Settings > Organizations receives its
  own section as a partner edition, worded from their side and never merged
  with anyone else's systems.
- **Blocked systems**: marking a system "Waiting / blocked" requires a written
  reason - what it is waiting on and what would clear it - enforced in
  `toggleStage`, not just in the panel that asks. The reason shows under the
  system's stages (editable without unblocking, which preserves how long it has
  been stuck) and leads that system's digest lines, aged from when it was
  blocked. Unblocking clears it. The digest's follow-up list asks after systems
  blocked before this was required, by lead name, every morning until somebody
  writes one.
- **Digest sender** (optional): set `DIGEST_EMAIL_FROM` to give the digest its
  own address (e.g. `Ridgeline <dailydigest@mail.ridgelinefield.com>`)
  instead of sharing `EMAIL_FROM` with sign-in links. The domain must be
  verified in Resend, and a subdomain is verified in its own right - which is
  the reason to use one: it carries its own sending reputation, so a bounce on
  a report never touches deliverability of the emails people log in with. Add
  `DIGEST_REPLY_TO` when that address is not an inbox anybody reads. Note the
  thread anchor follows this address, so changing it starts one fresh chain.
- **One conversation**: a digest is a single email with every recipient in the
  `To:` field - not a copy each - so recipients can see one another and a
  reply-all reaches the whole list. Consecutive editions also thread together
  via `In-Reply-To`/`References` pointing at a stable per-engagement id
  (`lib/emailThread`), which is why the subject line is constant and the day's
  counts ride in the preheader: Gmail re-splits a conversation whenever the
  subject changes, so a dated subject and a single chain cannot both be had.
- **Digest scheduling**: the hourly cron sends only what is due. Every
  organization keeps its own send hour and days of the week in shop time
  (Settings > Organizations; Settings > Configuration for the internal
  edition) and a per-organization stamp of the day it last went, so an hourly
  cron still delivers one email a day and a missed hour catches up rather than
  skipping. Both screens also carry **Preview** (renders today's edition with
  real data, sends nothing) and **Send now** (delivers immediately and counts
  as today's).
- **Rested days lose nothing**: an edition's window is "since the last
  edition", not "the last 24 hours" (`lib/digestDays`). A weekday-only digest
  therefore covers Friday-to-Monday when it returns - the work section is
  titled "Over the weekend", each line carries its day ("Sat · Completed:
  ..."), and if the weekend was quiet the partner edition simply says nothing
  extra. The same mechanism covers a skipped holiday ("Since Thursday") and a
  dormant digest coming back (capped at a week of catch-up).

### 6. Google Sheet parity (service account)
The sync reads the client's sheet through the Sheets API with a service
account, so the sheet stays private - nothing is published to the web.

1. Go to [console.cloud.google.com](https://console.cloud.google.com), create
   a project (any name, e.g. `sierra-spectra-sync`).
2. **APIs & Services > Library** > enable **Google Sheets API**.
3. **IAM & Admin > Service Accounts** > Create service account. No roles
   needed - it only reads a sheet shared with it.
4. Open the account > **Keys > Add key > JSON**. From the downloaded file,
   copy `client_email` into `GOOGLE_SERVICE_ACCOUNT_EMAIL` and `private_key`
   into `GOOGLE_PRIVATE_KEY` (paste as-is; `\n` escapes are handled).
5. In the client's Google Sheet: **Share** > add the service account email as
   **Viewer**. To the client this just looks like adding another viewer.
6. Set `SHEET_ID` from the sheet URL
   (`docs.google.com/spreadsheets/d/<SHEET_ID>/edit`). If their tab is named
   something other than `Refurbishment Tracker`, adjust `SHEET_RANGE`.

Test manually:
```bash
curl -H "Authorization: Bearer $CRON_SECRET" https://your-app.vercel.app/api/cron/sheet-sync
```
Diffs land in the **Sheet parity** view. Nothing is ever auto-applied; you
choose "Keep ours" or "Accept sheet" per diff. Stage diffs are informational
only (resolve by hand on the instrument page); notes and priority can be
applied mechanically when you accept the sheet value.

If you ever need a zero-setup fallback, setting `SHEET_CSV_URL` (File >
Share > Publish to web > CSV) works when the service account vars are unset.

## Roles

| Role          | How assigned                          | Can do                                   |
| ------------- | ------------------------------------- | ---------------------------------------- |
| owner         | first email in `STAFF_EMAILS`         | everything, incl. Settings               |
| staff         | other `STAFF_EMAILS`                  | everything except Settings               |
| client_viewer | `CLIENT_EMAILS` + view toggle on      | read-only dashboard + instrument pages   |
| client_editor | `CLIENT_EMAILS` + edit toggle on      | edit stages/tasks/parts/notes (audited)  |

All authorization is enforced server-side in the actions
(`src/app/actions.ts`), not just hidden in the UI.

## The demo workspace

`scripts/seed-demo.ts` opens a second operator on the instance - an invented
service company with a year of work behind it - so somebody evaluating the
product can be handed a login instead of a slide deck.

```bash
DATABASE_URL=... npm run db:seed:demo -- --dry-run  # writes nothing, reports what it would change
DATABASE_URL=... npm run db:seed:demo               # open it
DATABASE_URL=... npm run db:seed:demo -- --reset    # rebuild from scratch
DATABASE_URL=... npm run db:seed:demo -- --wipe     # take it back out
```

**Start with `--dry-run`.** Everything before the first write is a `SELECT`, so
a dry run can prove the names are free and then report the instance-wide
changes - which are the only ones anybody outside the demo can see - without
touching anything. It is the honest answer to "what will this do to *my*
instance", as opposed to instances in general.

**No terminal?** `.github/workflows/demo-workspace.yml` is the same four
actions behind a button: Actions > Demo workspace > Run workflow, pick
`check` / `seed` / `reset` / `wipe`. It reads `DATABASE_URL`, `DEMO_PASSWORD`
and `BLOB_READ_WRITE_TOKEN` from a `demo` **environment** rather than from
repository secrets, so ordinary CI cannot see the production connection string,
and the environment can carry an approval rule. The output lands in the job
summary, which is what GitHub's mobile app shows without making anybody scroll
a log. `DEMO_PASSWORD` is required for `seed` and `reset` on purpose: a
generated password would have to be printed to be useful, and a printed
password is a credential in a log.

It prints the sign-in at the end: `demo@ridgelinefield.com` and a password -
supplied via `--password=` or `DEMO_PASSWORD`, generated and printed only when
neither is given. A six-digit code by mail reaches the same account. The owner
email and the company name are `--owner=` and `--name=`, or `DEMO_OWNER_EMAIL` /
`DEMO_ORG_NAME`.

**Every client shape, on purpose.** Five organizations, because "does it handle
a reseller" is the second thing anybody asks: a regulated lab under
full-service contract (multi-site, GxP paperwork, its own stockroom, remote
access), a time-and-materials lab paying late and three rungs up the dunning
ladder, a **reseller** whose units are stock and whose landing is a pipeline,
another **service company** sharing one system with us, and a client with
nothing of theirs on the bench at all - the one that proves a day whose only
work was a phone call still reaches a report. Their nine logins differ on all
four allowlist flags, so "what can this person see" is answerable by clicking
rather than by argument.

Behind them: fourteen live systems covering every stage in the vocabulary plus
one archived, jobs in all six states and all four severities, parts in all ten
statuses across both lanes, quotes and invoices in every status, contracts
drawing down against allowances, a retainer with a cycle ready to raise, three
stockrooms, six purchase orders, a validation document set with signatures
(one of them revoked), release sign-offs, share links with view receipts, and
generated PDFs behind every download.

**What it will not touch.** Everything it writes is stamped with the demo
tenant, hangs off a row that is, or is keyed to a demo email address; it never
edits another tenant's rows. `--wipe` empties every stamped table by tenant
*explicitly* rather than trusting the cascade - five stamped tables carry
`tenant_org_id` with no foreign key behind it in the deployed DDL, and
`audit_log`'s is `SET NULL`, so a cascade alone would leave rows pointing at an
organization that no longer exists.

Three things are deliberately left alone, and all three for the same reason -
they are instance-wide with no tenant column, so a demo row would show up in
somebody's real workspace: the Google-sheet parity queue (`sheet_diffs`, and
the module stays off - it polls a real spreadsheet on a cron), the shop's
default expense policy, and the loaded labor rate.

**What it does change, and says so.** Client sign-in and four optional modules
live in `app_settings`, which is one row for the whole instance; the demo
cannot show a client portal, an EOD report or a remote session without them, so
any that are off get turned on and the change is printed. `--no-modules` leaves
that row exactly as found - and costs less than it sounds, because "view as"
never consults the client-access flag (`src/auth.ts` reads it on the sign-in
path and nowhere else), so the owner can still walk the client and reseller
portals; what is lost is handing a separate client login to somebody else.

Two other instance-wide numbers - the travel/expense policy and the loaded
labor rate - are **opt-in**, behind `--defaults`, even though the demo's travel
strip and job-cost margin read empty without them. A nav entry appearing is a
change somebody notices and ignores; a loaded labor rate is the number the
existing operator's own job costing computes margins *from*, so filling it in
unasked would make their real jobs show invented profit. That is not a demo
touching a demo.

`--wipe` does not turn the modules back off: by then they may be load-bearing
for another workspace, and the script cannot know which were on before.

**No Stripe account is invented.** A made-up connected account renders pay
buttons that fail the moment anybody presses them; without one the portal takes
the supported path and tells the client how to send a check. Pass
`--stripe-account=acct_...` (Connect Express, test mode) to demo the card and
ACH flows for real.

**Mail is not wired up, and that is enforced rather than hoped.** Digest and
EOD recipient lists are left blank, automatic dunning is off on every demo
client, and every invented address sits on a reserved `.example` domain that
cannot resolve. But two crons notify without anybody pressing anything - the
weekly usage report and the weekly renewal warning, and the seed deliberately
plants a contract inside its notice window so the second one fires. Both reach
the workspace's own staff, so every message would hard-bounce against the
operator's real sending reputation for as long as the demo exists.

So the seed writes an `emailOn: false` row for every notification kind against
every address it invents. That is the product's own opt-out table, and
`lib/notify` writes the in-app row *first* and filters recipients afterwards -
so the bell still lights up, the inbox still fills, the feature still
demonstrates, and only the envelope is dropped. Any of them can be switched
back on from Settings. `--mail-to=you@example.com` says "I want this demo to
send", and then nothing is suppressed.

**Share, drop and listing tokens are random.** They are the whole credential -
there is no session behind them - and `/api/drop/[token]` in particular mints a
Blob upload token for an anonymous caller against nothing but the token in the
path. A readable one would be a stranger writing 100MB at a time into the
operator's real Blob store.

**Files are real** when `BLOB_READ_WRITE_TOKEN` is set: the reports,
certificates, photos and packing lists are generated at seed time and uploaded,
so every download in the demo opens something. Without a Blob store the rows
are still made, inline, and the script says which ones will not resolve.

Dates are relative to the run, so a demo opened six months from now still reads
as a shop that was busy yesterday. `LOCAL_DB=1 PGLITE_DIR=...` points the same
script at the throwaway database `npm run dev:local` uses.

## Gas tracking

Each system lists the gases it requires (Helium, Nitrogen, Argon, Hydrogen,
Air) with a status - Connected / Low / Empty / Not connected - and a free-text
note for tank details. Low/Empty/Not-connected gases surface on the dashboard
(metric tile, row pill, "Gas attention" filter) and at the top of the daily
digest email. Individual tanks are deliberately not inventoried; the note
field ("tank #A-441, swapped Jul 18") covers attribution without the
bookkeeping.

Schema changes apply themselves on deploy. `next.config.mjs`, at the start of
every Vercel production build (hooked into the config so it runs regardless of
how the build command is configured), applies `drizzle/schema-sync.sql` via
`scripts/sync-schema.ts`, then runs `scripts/verify-schema.ts`.

`drizzle/schema-sync.sql` is an idempotent, **additive-only** sync
(`CREATE ... IF NOT EXISTS`, guarded `ADD COLUMN`/constraints, never a `DROP`).
It heals a database in any state and can't produce the destructive rollback
that `drizzle-kit push` does when its introspection diff goes wrong against the
production catalog. **When you change `src/db/schema.ts`, mirror the additive
change in `drizzle/schema-sync.sql`** - `verify-schema.ts` fails the build if
any column the code defines is missing, so a forgotten mirror is caught loudly,
never shipped. DDL prefers `DATABASE_URL_UNPOOLED` (Neon's direct connection)
when set - add it in Vercel env alongside the pooled `DATABASE_URL`. Local
`npm run build` skips all of it (no `VERCEL` env).

`drizzle-kit push` (`npm run db:push`) is still the tool for a full reconcile
or destructive change - run it deliberately from a machine, not on deploy.
Additive changes (new tables/columns) apply cleanly; a destructive change
(dropping or renaming) will stop and fail the build instead of applying
silently - run that kind of migration deliberately with `npm run db:push`
from a machine.

## The audit log

Every mutation writes a row to `audit_log` with actor, entity, action, and
old/new values. There is intentionally no code path that updates or deletes
audit rows. If someone erases a note again, the history has the old value.

## Structure

```
src/
  auth.ts                 Auth.js config: Resend provider, role assignment, client gate
  middleware.ts           cookie-presence gate (real authz is server-side)
  db/schema.ts            all tables (domain + Auth.js)
  db/index.ts             Neon + Drizzle client
  lib/stages.ts           stage/status vocabulary, colors, carrier tracking URLs
  lib/authz.ts            requireUser / requireEditor / requireStaff / requireOwner
  lib/audit.ts            append-only audit writer
  lib/sheetSync.ts        Sheets API fetch (service account) + diff engine
  app/actions.ts          every mutation (server actions, all audited)
  app/page.tsx            dashboard
  app/instruments/[id]/   instrument detail
  app/parity/             sheet diff review
  app/settings/           client access toggles (owner only)
  app/login/              magic-link sign-in
  app/api/cron/sheet-sync hourly parity poll
  app/api/upload          Vercel Blob client-upload token endpoint
  components/             client components (Dashboard, panels, forms)
scripts/seed.ts           loads the Jul 2026 sheet snapshot
scripts/seed-demo.ts      the demo workspace handed to a buyer (see above)
```
