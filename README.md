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
- **Storage > Blob**: create a store; `BLOB_READ_WRITE_TOKEN` is injected
  automatically.
- **Cron**: `vercel.json` already schedules `GET /api/cron/sheet-sync` hourly.
  Set `CRON_SECRET` in project env; Vercel sends it as the bearer token.

### 6. Google Sheet parity
In the client's sheet: File > Share > Publish to web > select the
"Refurbishment Tracker" tab > CSV. Put the URL in `SHEET_CSV_URL`.
Test manually:
```bash
curl -H "Authorization: Bearer $CRON_SECRET" https://your-app.vercel.app/api/cron/sheet-sync
```
Diffs land in the **Sheet parity** view. Nothing is ever auto-applied; you
choose "Keep ours" or "Accept sheet" per diff. Stage diffs are informational
only (resolve by hand on the instrument page); notes and priority can be
applied mechanically when you accept the sheet value.

## Roles

| Role          | How assigned                          | Can do                                   |
| ------------- | ------------------------------------- | ---------------------------------------- |
| owner         | first email in `STAFF_EMAILS`         | everything, incl. Settings               |
| staff         | other `STAFF_EMAILS`                  | everything except Settings               |
| client_viewer | `CLIENT_EMAILS` + view toggle on      | read-only dashboard + instrument pages   |
| client_editor | `CLIENT_EMAILS` + edit toggle on      | edit stages/tasks/parts/notes (audited)  |

All authorization is enforced server-side in the actions
(`src/app/actions.ts`), not just hidden in the UI.

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
  lib/sheetSync.ts        CSV fetch + parse + diff engine
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
