# Provisioning a new operator instance

Each customer (an equipment-service company — "the operator") gets its own
instance: one Vercel project, one Neon database, one sender domain. The code is
identical everywhere; everything operator-specific lives in the database or in
this short list of environment variables. A fresh database self-initializes on
first deploy — the schema sync runs during every build and seeds nothing
Sierra-specific (no orgs, no platform name, optional modules off).

## 1. Create the pieces

1. **Neon**: new project → copy the pooled connection string and the direct
   (unpooled) one.
2. **Vercel**: new project from this repo. Framework preset: Next.js. No build
   command override needed — the schema sync + verify gate hook into
   `next.config.mjs` and run on every production build.
3. **Vercel Blob**: add a Blob store to the project (Storage tab). This sets
   `BLOB_READ_WRITE_TOKEN` automatically.
4. **Resend**: create an API key; verify the sending domain you'll use for
   this instance (or use one subdomain per instance of a platform domain,
   e.g. `acme.notifications.yourplatform.com`).

## 2. Environment variables

| Variable | Value |
| --- | --- |
| `DATABASE_URL` | Neon pooled connection string |
| `DATABASE_URL_UNPOOLED` | Neon direct connection string (build-time schema sync) |
| `AUTH_SECRET` | `openssl rand -base64 33` |
| `AUTH_RESEND_KEY` | Resend API key |
| `EMAIL_FROM` | e.g. `Portal <portal@notify.customer-domain.com>` |
| `STAFF_EMAILS` | The platform-operator logins. First entry is the **owner** (superuser: Settings, view-as, hard deletes); the rest are staff. |
| `SHOP_TZ` | Instance timezone, e.g. `America/Chicago`. Drives "today" for EOD keys, date stamps, digests. |
| `APP_URL` | The instance's canonical URL once the domain is attached |
| `CRON_SECRET` | Random string; must match the header the cron jobs send |

Optional (only if the Google Sheet module will be used):
`SHEET_ID`, `SHEET_RANGE`, `SHEET_CSV_URL`, `GOOGLE_SERVICE_ACCOUNT_EMAIL`,
`GOOGLE_PRIVATE_KEY`.

`CLIENT_EMAILS` is legacy — leave it unset; client sign-in is managed in
Settings.

## 3. Crons

`vercel.json` schedules `api/cron/daily-digest`, `api/cron/sheet-sync` and
`api/cron/pm-generate`. The first two no-op unless the matching module is
switched on in Settings. PM generation is core product, not a module: with no
maintenance schedules defined it does nothing, so it too is safe to leave
scheduled on every instance.

## 4. First sign-in checklist (as the owner)

Settings has four parts, split by how often each changes: **Configuration**
(`/settings`) is the instance itself, set up once; **Personnel**
(`/settings/personnel`) is who is on it, changing weekly; **Catalog**
(`/settings/catalog`) is the equipment reference and **Procedures**
(`/settings/procedures`) is what gets done to equipment (checkout tests and
maintenance templates) - both curated forever, by the owner AND staff. The
catalog is the only place types, models and categories are defined: every
picker references it and none accepts free text. Each
organization then has its own page at `/settings/organizations/<id>`, which is
also the page that organization's own editors get.

1. Sign in with the first `STAFF_EMAILS` address (magic link).
2. **Configuration → This instance**: name the instance; set the tagline.
3. **Personnel → Organizations**: create the operator's own org (kind
   `provider`), then set it as **Operated by** back in Configuration — its
   name and logo go on sign-off packets and reports. Create the first client
   org(s).
4. **Personnel → Client sign-in**: switch the master toggle on. Then open each
   organization and invite its people from its own page (each entry gets an
   editor/viewer role; invitations email automatically).
5. **Configuration → Modules**: switch on EOD / digest / sheet sync only if
   this operator wants them. Fresh instances have all three off.
6. **Catalog**: add the system types this operator services (LC-MS, GC-MS),
   the module types (a fresh install ships the 13 starters), and the models
   under each. Models tagged to no system type are offered everywhere, which
   is right for control PCs and gas generators. Asset and system forms only
   offer what's defined here; a CSV import auto-registers what it brings in.
7. **/import**: bring the fleet in from their spreadsheet (template on the
   page). Assets and systems land with ownership and shares handled.
8. Upload the operator org's logo on its own settings page (Workspace
   appearance).

## 5. Smoke checks before handing over

- Sign in as owner; dashboard renders under the chosen name.
- Invite a test viewer into a client org → email arrives → they see only
  what's shared, and edits are refused.
- Upload a file to a system; open it via its `/api/files/...` link signed
  out → 404. Mark a system for sale, open `/listing/<token>` signed out →
  renders; end the listing → 404.
- `/api/export/assets` downloads; `/import` dry-run on the template CSV
  reports create actions and no errors.
- Trigger `api/cron/daily-digest` with the `CRON_SECRET` header → `skipped`
  unless the module is on.
- Define a maintenance template on /maintenance for an asset type in the
  fleet → it reports how many existing units it scheduled; add a new asset of
  that type → the schedule is on it from birth.
- Add a maintenance schedule due today on a test system → the task appears
  under Tasks immediately; mark it Done → the schedule's next due date moves
  out by one cadence. Open a system's **Label** and scan the QR with a phone →
  it lands on that system's page (after sign-in).
- Discussion privacy, worth checking once per instance because it is the thing
  customers ask about: post on a shared system as staff with **Internal** on,
  then view the system as the client org (view-as) → the post is absent, and
  the activity feed says a note was posted without quoting it. On
  `/discussions`, confirm a client sees only their own room.

## Notes

- **Timezone is an env var by design** (`SHOP_TZ`): shop-day helpers run
  synchronously in render paths. Set it at provisioning; changing it later is
  a redeploy.
- **Blob URLs** are public-but-unguessable underneath the `/api/files` proxy;
  the app never renders a raw URL. Treat the proxy as the only supported way
  to reach files.
- **Internal posts are private from the operator too.** That is deliberate: it
  is what makes the feature worth anything to a customer. The operator can see
  that an internal note exists (in the audit log) but never its text.
- Deleting an instance: snapshot the Neon database first — the audit log is
  the customer's record.
