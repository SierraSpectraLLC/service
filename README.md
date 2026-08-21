# Sierra Spectra - Instrument Management

Replaces the client's Google Sheet with a real system: instrument tracking with
multi-stage tags, rich tasks (checklists, threaded notes, assignment), parts
orders with carrier tracking links, file attachments on Vercel Blob, an
append-only audit log, role-based client access, and an hourly parity check
against the old Google Sheet.

Stack: Next.js (App Router) · Neon Postgres · Drizzle ORM · Auth.js (magic
links via Resend) · Vercel Blob · Vercel Cron.

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

### 5. Vercel
Import the repo in Vercel. Add all env vars from `.env`. Then:
- **Region**: page speed is dominated by the latency between the Vercel
  function and Neon, multiplied by several queries per page. Make sure the
  project's function region (Vercel > Settings > Functions) matches the Neon
  project's region (shown in the Neon console) - a cross-country mismatch adds
  hundreds of ms per page load that no code change can recover.
- **Storage > Blob**: create a store; `BLOB_READ_WRITE_TOKEN` is injected
  automatically.
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
- **Digest scheduling**: the hourly cron sends only what is due. Every
  organization keeps its own send hour in shop time (Settings > Organizations;
  Settings > Configuration for the internal edition) and a per-organization
  stamp of the day it last went, so an hourly cron still delivers one email a
  day and a missed hour catches up rather than skipping. Both screens also
  carry **Preview** (renders today's edition with real data, sends nothing) and
  **Send now** (delivers immediately and counts as today's).

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
```
