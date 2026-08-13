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
| `STAFF_EMAILS` | Bootstrap operator logins. The **first entry is the root owner** - always a superuser, and the only house role that cannot be revoked from the UI, so it is the way back in if the members list is ever left without a working owner. Later entries seed staff. Everyone else is added and revoked in **Settings → Admin → Our people**, no redeploy. |
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
(`/settings/procedures`) is what gets done to equipment - one catalog where
each procedure says WHEN it fires: once at intake, on a cadence, or both -
curated forever, by the owner AND staff;
**Admin** (`/settings/admin`) is the operator's override on every system's
ownership and visibility, owner only. The
catalog is the only place types, models and categories are defined: every
picker references it and none accepts free text. Each
organization then has its own page at `/settings/organizations/<id>`, which is
also the page that organization's own editors get.

1. Sign in with the first `STAFF_EMAILS` address (magic link) - the root owner.
2. **Admin → Our people**: add the rest of the operator's staff and any
   co-owners. Owners get Settings, organizations, stages, branding, hard
   deletes and signature revocation; staff get every system and all the work.
   Roles take effect on the person's next page load.
3. **Configuration → This instance**: name the instance; set the tagline.
4. **Personnel → Organizations**: create the operator's own org (kind
   `provider`), then set it as **Operated by** back in Configuration — its
   name and logo go on sign-off packets and reports. Create the first client
   org(s).
5. **Personnel → Client sign-in**: switch the master toggle on. Then open each
   organization and invite its people from its own page (each entry gets an
   editor/viewer role; invitations email automatically).
6. **Configuration → Modules**: switch on EOD / digest / sheet sync only if
   this operator wants them. Fresh instances have all three off.
7. **Catalog**: add the system types this operator services (LC-MS, GC-MS),
   the module types (a fresh install ships the 13 starters), and the models
   under each. Models tagged to no system type are offered everywhere, which
   is right for control PCs and gas generators. Give each model its
   **manufacturer** - the catalog groups by it, and asset entry fills the
   unit's maker in from the model. Asset and system forms only offer what's
   defined here; a CSV import auto-registers what it brings in.
8. **/import** or **Assets → Several at once**: bring the fleet in. Both use
   the same columns (Type, Model, Serial, Mfr, Owner, Location, As found,
   Notes), so a template downloaded from the grid imports through /import
   unchanged - and a block copied out of Excel pastes straight into the grid. Assets and systems land with ownership and shares handled.
9. Upload the operator org's logo on its own settings page (Workspace
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
- Mark a procedure **Required for sign-off** in Settings → Procedures, open a
  system's sign-off packet, and confirm the Sign off button is blocked with the
  reason. Finish the work, file a report against the test (the "not evidence"
  dropdown on the file), and confirm signing then succeeds and prints.
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

- **If sign-in feels slow**, the server logs the send: `[auth] magic link sent
  in NNNms`, or `[auth] resend send failed after NNNms`. Anything left over
  after that number is the database round trips (adapter lookup + token write),
  and on a suspended Neon compute the first query of the day pays the wake-up -
  which the hourly crons normally prevent by keeping it warm. The Resend call
  is capped at 8s and fails with a readable message rather than hanging.

- **Sign-off signatures are audited approvals, not 21 CFR 11 e-signatures.**
  Identity comes from the authenticated session and intent from a typed name;
  there is no password to re-challenge at signing because sign-in is by magic
  link. Tell customers that plainly. Closing the gap means a second factor at
  the moment of signing.

- **Timezone is an env var by design** (`SHOP_TZ`): shop-day helpers run
  synchronously in render paths. Set it at provisioning; changing it later is
  a redeploy.
- **Blob URLs** are public-but-unguessable underneath the `/api/files` proxy;
  the app never renders a raw URL. Treat the proxy as the only supported way
  to reach files.
- **File storage is per organization and metered.** Each org has its own shelf
  (`/documents`) and its own ceiling (`orgs.storage_limit_mb`, set by the owner
  in Settings → that organization). A store holds its shelf plus the paperwork
  on every system and unit it owns, so files follow equipment when it changes
  hands; one document filed onto several records is stored — and charged —
  once. `0` means no ceiling, which is what every organization on an upgraded
  instance keeps until somebody sets a real number; new organizations start at
  5 GB. Nothing bills anybody yet: the meter and the wall are in place so a
  plan can be attached to them later without a migration.
- **Internal posts are private from the operator too.** That is deliberate: it
  is what makes the feature worth anything to a customer. The operator can see
  that an internal note exists (in the audit log) but never its text.
- Deleting an instance: snapshot the Neon database first — the audit log is
  the customer's record.

---

## Remote support (optional module, needs a host)

Reaching a lab PC from the portal. Replaces the arrangement where an instrument
controller runs TeamViewer or UltraViewer permanently and an engineer gets in
with **the PC's password** — a shared secret everyone who ever needed access
still knows, usually on a label, not revocable without walking to the machine,
and leaving no record of who connected. Here identity comes from the portal
session: access is per-person, revoked by a toggle, and every session writes an
audit row naming a human.

The portal is never in the media path. Vercel functions cannot hold a socket
open, so a **relay host** carries sessions and the agent reaches it by checking
in — a lab PC behind NAT has no address anything could dial. The portal only
decides who may connect, writes down that they did, and hands the browser a
short-lived URL.

### The host (AWS Lightsail)

**Step-by-step setup lives in [REMOTE_HOST_SETUP.md](./REMOTE_HOST_SETUP.md)** -
follow that the first time. The summary below is the parts worth remembering
after you have done it once.


- **2 GB tier.** 512 MB will not run the engine comfortably.
- **Region: nearest the labs.** Engineers move around; benches don't.
- **Allocate and attach a static IP _before enrolling a single agent_.**
  Lightsail's static IP is free but not automatic — without one, a stop/start
  changes the address and every installed agent is left pointing at nothing.
- Open `443` and `80` in the instance's **Networking** tab (Lightsail's own
  firewall, not EC2 security groups). Port 80 is only for the ACME challenge.
- **Turn on automatic snapshots.** That is the entire backup story, and it
  covers the agent certificates — lose those and every machine needs
  re-enrolling.
- Lightsail CPU is burstable. Sustained relay is network-bound so this is
  usually fine; credit exhaustion under load is the signal to move up a tier.
  The bundled transfer allowance is a few TB and a relayed session consumes it
  on both legs — irrelevant at a handful of concurrent sessions, worth watching
  if that changes.
- DNS: one A record, `remote.<instance-domain>` → the static IP.

### Portal env vars

| Var | What |
| --- | --- |
| `REMOTE_URL` | `https://remote.<domain>` — the relay host |
| `REMOTE_LOGIN_KEY` | Shared key the portal mints session cookies with |
| `REMOTE_ADMIN_USER` | The engine identity the portal acts as |

**`REMOTE_LOGIN_KEY` outranks `CRON_SECRET`.** Whoever holds it can mint admin
cookies for the host. It lives in Vercel env and the host's config, nowhere
else; rotation means editing both and restarting the engine.

All three absent is a supported state: `/remote` says "no support host
configured yet" and lists machines without offering to connect. The module flag
and the host are deliberately separate so the flag can go on first.

### Setup gate — do this before trusting any of it

Not optional, and not something to skip because the portal side already builds.

The wire format in `src/lib/remote.ts` is written against **MeshCentral 1.2.4**
specifically — its 80-byte login key, its token layout, and the two different
query parameters the browser page and the admin channel read it from. All three
have moved between releases, and none of them fail loudly: a mismatch shows a
login page instead of a machine. `tests/remoteCookie.test.ts` pins the format and
was checked against the engine's own decoder, so **upgrading the host means
re-reading `encodeCookie` and `decodeCookieAESGCM` in `meshcentral.js` and
re-running that file.**

Then prove the whole path by hand:

1. Enroll a real Windows PC from the installer link on `/remote`.
2. Reboot it. It must come back on its own — that is what "unattended" means.
3. Connect from a browser. Control the desktop.
4. Confirm a session recording exists.
5. Confirm the audit row names you.
6. Hand the linked system off in the portal and confirm the machine flips to
   "asks first" (see below).
7. Stop the host and confirm `/remote` still renders the cached list and refuses
   politely rather than erroring.

### Attended vs unattended follows custody

Unattended in the shop, consent required once a system reaches a customer —
derived, not toggled, because the failure mode of a manual switch is the
sentence you never want to say to an auditor: *"we still had silent unattended
access to a customer's instrument PC eight months after we sold it to them."*

The rules live in `src/lib/remoteAccess.ts` (pure, and tested):

- `Shipped` on the linked system → consent required
- the system's owner no longer matching the org the PC was enrolled under →
  consent required (this is what a handoff does)
- otherwise → unattended
- staff can override per machine, either way. Unattended-after-handoff is a
  legitimate paid exception; that override is the tier.

### Who can connect

House staff always — that is the service. A client organization's own editors
reach their own machines only when **Settings → that organization → Remote
support** is on; that switch is the sellable tier. A view-as persona may look
but never connect: taking control of a customer's PC belongs to a real
identity, not a lens.

### Rollout: parallel, never a cutover

Do not uninstall TeamViewer on day one. When remote access fails an engineer
cannot do their job, and a new agent will not be as battle-hardened as software
that has spent fifteen years fighting corporate firewalls. Enroll one bench PC,
run both side by side, and pull TV per-machine once ours has earned it.

Removing a device row **does not remove access** — the agent keeps checking in
until somebody uninstalls it on the machine itself. The confirmation dialog says
so, and so should you.

---

## OneDrive and SharePoint in the PDF studio (optional, needs an app registration)

Bill asked whether the studio could pull a PDF out of OneDrive instead of
downloading it to the PC first. Two answers ship, and the cheap one needs
nothing at all:

**Drag it in.** A PDF in a synced OneDrive or SharePoint folder shows up in
Explorer like any other file. Dragging it onto the studio makes Windows fetch it
on the spot. No sign-in, no setup, no registration. Try this before doing
anything below — for a machine that already syncs the folder, it *is* the
feature.

**Connect the account.** Everything below buys browsing and searching OneDrive
and SharePoint from inside the studio, a connection that survives sign-out, and
saving a finished packet back into a folder. Absent the two env vars, the studio
simply never mentions OneDrive.

### The registration (Azure portal, ~15 minutes, free)

1. **Entra ID → App registrations → New registration.** Name it for the portal.
   Under *Supported account types* pick **Accounts in any organizational
   directory** — anything narrower means only this company's accounts can ever
   connect, which rules out a client's own OneDrive.
2. **Redirect URI**, platform **Web**: `https://<portal-domain>/api/cloud/callback`.
   It must match exactly, including the scheme.
3. **Certificates & secrets → New client secret.** Copy the *Value* (not the id)
   immediately; Azure never shows it again. Note the expiry — a secret that
   lapses breaks every connection at once, and 24 months is the longest offered.
4. **API permissions → Microsoft Graph → Delegated**: `Files.ReadWrite.All`,
   `Sites.Read.All`, `User.Read`, `offline_access`. Delegated, never
   Application: the app then sees exactly what the signed-in person sees, so
   connecting cannot quietly grant this portal read access to a whole tenant.

### Portal env vars

| Var | What |
| --- | --- |
| `MS_CLIENT_ID` | Application (client) ID from the registration |
| `MS_CLIENT_SECRET` | The secret's **Value** |
| `MS_TENANT` | Optional. `common` (default) lets any work account connect; a tenant id locks it to one company |
| `CLOUD_TOKEN_KEY` | 32+ random characters. Seals stored refresh tokens |

**`CLOUD_TOKEN_KEY` is the one that matters.** Each connection stores a
Microsoft refresh token — a standing key to somebody's files that does not
expire on its own — and the token is sealed with this key before it is written,
so a copy of the database on its own opens nothing. Generate it with
`openssl rand -base64 48`. Changing it does not corrupt anything: every
connection simply reports that it needs making again.

`MS_CLIENT_ID` and `MS_CLIENT_SECRET` absent is a supported state. So is
`CLOUD_TOKEN_KEY` absent — the studio then declines to store a connection at all
rather than writing a token in the clear.

### A client's own tenant

The first person from another company to connect will see a consent screen, and
if their admin has locked consent down, an **admin approval required** message.
Their IT approves the app once for their tenant and it works for everyone there
after that. Nothing in this portal can shortcut that, and it should not be able
to.

### What it does and does not touch

- Reading a PDF out of OneDrive puts it in the browser's working set only. It
  is never copied into this app's storage and never counts against a quota
  unless somebody then saves the packet to a record or the library.
- Saving a packet **to** OneDrive goes browser-to-Microsoft directly, off an
  upload URL this server mints. The bytes never pass through a serverless
  function, whose request body is capped well below the size of a scanned
  packet.
- Browsing writes nothing down. Folder names from somebody's company do not end
  up in this database.
- A connection belongs to one person, never to an organization: it reaches
  whatever that individual can reach, so sharing one would hand over their
  document library with it.
