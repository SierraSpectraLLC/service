# Sierra Spectra → SaaS: Full System Audit

**Date:** 2026-08-08 · **Scope:** entire codebase at `80308e3` (~6,000 lines of TypeScript)
**Question:** what does this software have that can compete, what is it lacking, and what has to happen for it to replace shop spreadsheets and CMMS products like MaintainX?

---

## Executive summary

You have a **well-engineered, single-tenant job tracker built for exactly one relationship**: Sierra Spectra refurbishing instruments for LabZen. That specificity is both the problem and the opportunity.

- **The problem:** there is no tenancy, roles come from environment variables, settings are a singleton row, and client-specific vocabulary (gases, "Send to LabZen", one Google Sheet) is baked into schema and code. Nobody else can sign up for this app today.
- **The opportunity:** the app's two most unusual features — the **provider↔client shared portal** and the **Google Sheet parity engine** — are things MaintainX, UpKeep, and Limble *don't* do. MaintainX is built for internal maintenance teams. This app is built for a shop that maintains equipment *for clients* and needs to look transparent and professional while doing it. That is a real, underserved wedge.

The honest verdict: this is a strong **foundation** — clean authz, full audit trail, event-sourced stage history, small refactorable codebase — but it is roughly **40% of a SaaS product**. The missing 60% is tenancy, self-serve signup/billing, structured data (dates/costs), preventive-maintenance scheduling, and mobile/notification infrastructure. The good news is the codebase is small and disciplined enough that the refactor is weeks, not months.

---

## 1. What you have (competitive assets)

Ranked by how much they matter in the market:

1. **Two-sided client portal.** Client roles (`client_viewer`/`client_editor`) with owner-controlled access toggles, shared discussion threads with @mentions, a client sign-off page, and a daily client-facing EOD report workflow. This is the differentiator. Internal-team CMMS products treat "the customer" as out of scope; service shops currently email PDFs and spreadsheets. "Give your clients a live window into their equipment" is a pitch MaintainX cannot make.

2. **Spreadsheet parity engine** (`lib/sheetSync.ts`, `/parity`). Hourly diff against the customer's live Google Sheet, human-resolved per field ("keep ours" / "accept sheet" / "keep ours and fix their sheet"), row import, and push-back of new systems. Generalized, this is the best Excel-migration story in the category: *you don't have to kill the spreadsheet on day one — we'll keep it in sync until you trust us.* Nobody sells that onramp today; competitors offer one-time CSV import.

3. **Append-only audit log on every mutation** (`lib/audit.ts`, enforced in all ~45 server actions). Actor, entity, field, old/new value, no update/delete code path. This is genuinely rare rigor and directly answers the #1 spreadsheet failure mode ("someone erased the note and nobody knows who"). It's also the seed of a compliance story (ISO 17025 labs, regulated shops).

4. **Event-sourced stage history → cycle-time metrics.** `stage_events` powers "12d in Checkout" aging chips and average-days-per-stage. This is the analytics kernel every CMMS charges extra for, and you get it for free from the data model.

5. **SOP templates.** Named task bundles with checklists, applied at instrument creation or later. Directly maps to the "procedures/checklists" feature CMMS buyers ask about.

6. **Parts lifecycle done thoughtfully.** Status flow (Needed → Ordered → In transit → Received → Backordered → Installed → Removed), auto-stamped lifecycle dates, carrier deep links, custom spec fields, consumable vs part distinction.

7. **Multi-stage tagging.** An asset can be in `Refurbishment` *and* `Waiting / blocked` simultaneously. Real shops work this way; single-status CMMS boards fight it. Keep this.

8. **Engineering fundamentals that de-risk the pivot.** Server-side authorization in every action (never UI-only), passwordless magic-link auth, session revocation when access is removed, unit tests on the pure logic, near-zero dependency footprint, additive-only self-applying migrations with a build-time verification gate, and deliberate mobile touches (EOD autosave that avoids page revalidation jank). A ~6k-line codebase with this discipline is *cheap to refactor* — treat that as an asset.

---

## 2. What's blocking SaaS (architecture audit)

Ranked by severity:

### 2.1 No tenancy — the defining blocker
- No organization/workspace concept. **Zero tables carry a tenant id.**
- Roles are assigned from env vars: first email in `STAFF_EMAILS` is the owner (`lib/allowMatch.ts`). Adding a user is a redeploy.
- `app_settings` is a singleton row (`id = 1`).
- One Google Sheet (`SHEET_ID`), one shop timezone (`SHOP_TZ`), one client allowlist, one EOD recipient list.
- The `people.org` column is literally `"sierra" | "labzen"`.

Everything in the roadmap hangs off fixing this: `orgs`, `org_members(user_id, org_id, role)`, `org_id` on every domain table, and a `requireOrg()` scoping helper that every query goes through.

### 2.2 Identity by free-text name strings
`lead`, `assignee`, `author`, `uploadedBy`, and EOD `updatedBy` are all free-text names. Notification routing resolves a name to an email via a heuristic chain ending in *"a staff email whose local part starts with the name"* (`resolveAssigneeEmail`). @mentions are substring matches. At one 5-person shop this works; across tenants it will silently email the wrong person. Assignment and authorship must become foreign keys to `users`.

### 2.3 Unstructured data where reporting needs structure
- Part dates (`orderedAt`, `eta`, `receivedAt`, `installedAt`, `removedAt`) are free text like `"Jul 22"`.
- `cost` is free text (`"1,240"`); `qty` is free text.
- Consequence: no cost rollups, no overdue-part queries, no date math, no year boundaries. Cost and history reporting are table stakes in CMMS evaluations — buyers run "what did this asset cost us this year?" as a demo question. These need typed columns (with the free-text preserved in a note during backfill).

### 2.4 Hardcoded vertical vocabulary
- **Gases** are a dedicated table and enum (`Helium…Air`) with bespoke dashboard tiles, filters, and digest sections. Perfect for GC/LC-MS labs, meaningless for a fabrication shop.
- **Built-in stage names are load-bearing:** logic keys on the literal strings `"Waiting / blocked"`, `"Shipped"`, `"Waiting to ship"`, `"Intake"` (dashboard counts, sheet push filtering, EOD grouping). Renaming a built-in is forbidden *because* of this coupling.
- Attachment kinds are a fixed enum (`Tune report`, `Test data`…).
- Email templates are branded `SIERRA SPECTRA`; the EOD button is "Send to LabZen"; login/layout copy names both companies (43 occurrences across 12 files).
- The seed script ships LabZen's actual instrument fleet.

### 2.5 Patterns that won't survive scale
- Full-table `select()` then filter in JS: `users`, `people`, `instruments` are loaded whole in many actions (`renameStage`, `removeClientAccess`, allowlist checks run `select * from client_allowlist` on every client sign-in and session read).
- Sequential awaited inserts in loops (template application, stage renames) — no transactions anywhere. The `neon-http` driver can't do them; multi-step mutations (update + stage event + audit row) can partially fail and leave inconsistent history.
- No pagination on any list (dashboard, audit feed, discussions).
- The `session` callback does 1–2 DB round-trips per request to refresh roles.
- Audit `action` strings are baked English sentences at write time — fine forever for one shop, but they can't be localized or re-rendered, and they duplicate the structured fields already stored alongside.

### 2.6 Operational gaps
- Build-time `schema-sync.sql` is clever for one database but doesn't scale to a real migration pipeline (no versioning, no down-migrations, drift risk once there are staging + prod + preview DBs). Move to `drizzle-kit generate` migration files applied by CI.
- No rate limiting on the magic-link endpoint (email-bombing and enumeration vector once signup is public).
- Vercel Blob files are public-URL-by-obscurity; multi-tenant file isolation needs scoped paths and, eventually, signed access.
- No error monitoring (Sentry), no structured logging, no health checks beyond the blob probe.
- Tests cover pure helpers only (7 files); the 1,200-line `actions.ts` — where all authorization lives — has zero test coverage. Before multiplying tenants, authz needs integration tests.

---

## 3. Too specific vs. not generic enough

The direct answer to "what's too specific, what's not generic enough":

| Area | Verdict | What to do |
|---|---|---|
| Gas tracking (table, enums, tiles, digest) | **Too specific** | Generalize into configurable per-asset "attention attributes" (name + state + note + alert threshold). Ship the gas set as a preset in a "Lab / Analytical Instruments" template so the current customer loses nothing. |
| EOD "Send to LabZen" report | **Right idea, wrong scope** | This is a *client status report* feature — rename it, make recipients/cadence per client, offer weekly too. It's a selling point once genericized. |
| Sheet parity sync (one sheet, fixed column layout, hardcoded tab name) | **Under-generalized gem** | Make it the onboarding wizard: CSV/Google Sheet import with column mapping, plus optional continuous two-way sync per tenant. This is your Excel-replacement weapon. |
| Stage system | **Almost right** | Already DB-driven with custom stages and colors. Decouple logic from names: add semantic flags to `stage_defs` (`is_blocked`, `is_done`, `is_shipped`, `counts_as_active`) instead of matching literal strings. Then built-ins become just a default set and renaming stops being forbidden. |
| `people` roster + `users` duality | **Not generic** | Collapse into org membership + invited users; keep a lightweight "contact (no login)" flavor for assignable non-users. FK all assignments. |
| Parts | **Half right** | Keep the per-job lifecycle (it's good). Add typed dates/costs. Later, split "parts used on a job" from "stock inventory" — don't conflate them now. |
| Attachment kinds enum | **Too specific** | Per-tenant configurable list, seeded with sensible defaults. |
| Notifications (2 hardcoded events + digest) | **Not generic enough** | Move to an event → subscription model with per-user preferences and an in-app notification feed. Email-only is fine for v1 of that; push comes with the PWA. |
| `app_settings` singleton, env-var roles, `SHOP_TZ` | **Too specific** | All become per-org settings rows. |
| `instruments` terminology | **Too specific** | Generalize to `assets` with a per-tenant label ("Instruments", "Machines", "Vehicles", "Equipment"). |
| Free-text `client` column | **Not generic enough** | Clients become first-class records (the thing a portal login attaches to). This is the pivot's core entity: *your tenant's customers*. |
| Audit log | **Keep, restructure slightly** | Keep append-only writes; store structured fields (already done) and render sentences at read time. |
| Multi-stage tagging, SOP templates, cycle-time metrics | **Keep as-is** | These generalize cleanly already. |

---

## 4. Feature gap vs. MaintainX (table stakes you're missing)

What CMMS buyers will treat as disqualifying, roughly in the order they'll notice:

1. **Preventive maintenance scheduling — the core CMMS feature, entirely absent.** No due dates anywhere (tasks have no date fields at all), no recurring work orders, no calendar, no meter-based triggers. "Every 90 days, regenerate the trap; every 500 hours, service the pump" is the first thing a maintenance buyer asks for.
2. **Work request intake.** MaintainX's growth loop: anyone scans a code / hits a portal, submits a request with a photo, requester gets status updates. You have nothing between "client discussion post" and "staff creates a task."
3. **Mobile.** Responsive web only — no PWA install, no offline, no push notifications, no camera-first flows, no QR/barcode asset tags. MaintainX is mobile-first; technicians live on phones in the shop.
4. **Reporting & export.** One metrics page. No CSV/PDF export of anything — spreadsheet refugees will not accept a data roach motel; export is a trust feature. No cost reports (blocked on §2.3), no work-order history reports, no printable work orders.
5. **Inventory.** Parts are per-job order records, not stock with quantities, min/max, and reorder alerts.
6. **Integrations & API.** No public API, no webhooks, no Zapier. SSO is magic-link only — shops on Microsoft 365 / Google Workspace expect "Sign in with Google/Microsoft" (magic links also add friction every session).
7. **Self-serve commercial layer.** No signup, no trial, no plans/seats, no Stripe, no usage limits. Today onboarding a tenant means editing env vars and redeploying.

**What you should *not* try to match right now:** MaintainX's AI features, enterprise procurement suite, multi-site rollups, IoT/sensor integrations, and marketplace. Those are late-stage features; chasing them head-on against a company with $100M+ raised is how a two-person product dies. Win the wedge instead.

---

## 5. Positioning: how this actually beats MaintainX and Excel

Don't sell "a better CMMS." Sell **the CMMS for shops that service other people's equipment** — refurbishers, calibration labs, repair depots, field-service outfits. For them:

- MaintainX is shaped wrong (internal teams, no client concept).
- Excel persists because it's the only thing both sides can see (emailed weekly).
- Your differentiators — client portal, EOD/status reports, sign-off, discussions, audit trail, sheet parity — are *exactly* the provider↔client surface. You've built the hard, unusual part already; what's missing is the generic plumbing everyone has.

Two pricing/growth notes that follow from the architecture you already have:
- **Free client seats, paid staff seats.** Client viewers cost you nothing and are the viral loop — every job invites another company into the product (and some of those companies run shops).
- **The parity engine is the sales close for Excel holdouts:** "keep your spreadsheet running; we'll mirror it until you turn it off."

---

## 6. Roadmap to a true SaaS, fastest path

### Phase 1 — De-specialize the core (≈ weeks 1–4)
The tenancy refactor, done once, touching everything:
1. `orgs`, `org_members` (role lives here, not on `users`), invite flow (magic links already fit).
2. `org_id` on every domain table; a `requireOrg()` helper wrapping every query and action; kill env-var roles.
3. Per-org settings (timezone, asset label, client-access toggles, report recipients).
4. Clients as first-class records; client users attach to a client, scoping what they see.
5. Assignment/authorship by user FK; retire the name-matching heuristics.
6. Typed date/cost/qty columns on parts (backfill best-effort, keep originals in notes).
7. Stage semantic flags; strip literal-name logic; genericize gases → attention attributes; de-brand all copy/emails; parameterize the seed into industry templates.

### Phase 2 — SaaS shell (≈ weeks 4–8)
1. Public signup → create org → onboarding wizard with **CSV/Google Sheet import** (built from `sheetSync`'s parser).
2. Stripe: trial, staff-seat pricing, free client seats, plan gating.
3. Google + Microsoft OAuth alongside magic links.
4. Real migration pipeline (drizzle-kit migration files in CI), transactions (Neon WebSocket/pooled driver), rate limiting on auth endpoints, Sentry, pagination on all lists.
5. Integration tests over `actions.ts` authz before any of this ships.

### Phase 3 — Table stakes to win deals (≈ weeks 8–14)
1. **Due dates + recurring schedules** on tasks (the PM feature) with a calendar/overdue view — the single highest-value feature addition in this document.
2. Work request intake (public per-org request form, requester status emails).
3. PWA: installable, push notifications, camera capture on tasks; QR asset tags that deep-link to the asset page.
4. CSV export everywhere; printable/PDF work orders; the cost and cycle-time reports the typed columns now enable.
5. Minimal public API + webhooks.

**Keep shipping to your existing customer throughout** — Sierra Spectra/LabZen becomes tenant #1 and your reference case study. Nothing in Phase 1 removes a feature they use; it re-homes it.

---

## 7. Quick wins (do these regardless)

- Add due dates to tasks — small schema change, immediately useful to the current customer, and it starts the PM story.
- CSV export of the dashboard and audit log — hours of work, big trust signal.
- Add `is_blocked`/`is_shipped`-style flags to `stage_defs` and migrate the string-matching logic — unlocks stage renaming and is a prerequisite for everything generic.
- Rate-limit `/api/auth` magic-link sends.
- Write integration tests for `requireEditor`/`requireStaff`/`requireOwner` paths in `actions.ts`.
- Start every new table/column with `org_id` in mind, even before the refactor lands.
