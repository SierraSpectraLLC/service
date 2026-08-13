// NOTE: Deploys apply drizzle/schema-sync.sql (idempotent, additive), not
// `drizzle-kit push`. When you add a table/column/index here, mirror it there.
// The build's verify-schema gate fails the deploy if a column is missing, so a
// forgotten mirror is caught loudly - never shipped silently.
import {
  pgTable, text, integer, boolean, timestamp, serial, primaryKey, index, unique, numeric, jsonb,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";
import type { AdapterAccountType } from "next-auth/adapters";

// ---------------------------------------------------------------------------
// Auth.js tables (required by the Drizzle adapter for email magic-link login)
// ---------------------------------------------------------------------------
export const users = pgTable("users", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  name: text("name"),
  email: text("email").unique().notNull(),
  emailVerified: timestamp("email_verified", { mode: "date" }),
  image: text("image"),
  // owner | staff | client_viewer | client_editor
  role: text("role").notNull().default("client_viewer"),
  /**
   * The fallback way in, for the days email doesn't arrive - a provider blocks a
   * domain, a filter eats the message. Set from inside the app by somebody
   * already signed in, so the address was proved before a password ever existed
   * for it; blank means this person has none and signs in by code as usual.
   * Format and rules live in lib/password.
   */
  passwordHash: text("password_hash").notNull().default(""),
  passwordSetAt: timestamp("password_set_at"),
  /**
   * Where to text a sign-in code, E.164. Set by the person themselves from
   * inside the app, so it is a second way back into an account rather than a way
   * to get one. Blank means codes go by email as they always have.
   */
  phone: text("phone").notNull().default(""),
});

export const accounts = pgTable("accounts", {
  userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  type: text("type").$type<AdapterAccountType>().notNull(),
  provider: text("provider").notNull(),
  providerAccountId: text("provider_account_id").notNull(),
  refresh_token: text("refresh_token"),
  access_token: text("access_token"),
  expires_at: integer("expires_at"),
  token_type: text("token_type"),
  scope: text("scope"),
  id_token: text("id_token"),
  session_state: text("session_state"),
}, (t) => [primaryKey({ columns: [t.provider, t.providerAccountId] })]);

export const sessions = pgTable("sessions", {
  sessionToken: text("session_token").primaryKey(),
  userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  expires: timestamp("expires", { mode: "date" }).notNull(),
});

/**
 * Sign-in throttling, one row per email address.
 *
 * The six-digit code that goes in the same email as the magic link is only a
 * credential because of what is counted here: wrong guesses, and codes asked
 * for. Kept in its own table rather than on the verification token, because the
 * counters have to outlive the code they are counting - a lock that vanished
 * with the token it protected would be no lock at all.
 *
 * Not tenant-stamped on purpose: this is about an address trying to get in, and
 * that happens before anybody knows whose workspace they belong to.
 */
export const loginAttempts = pgTable("login_attempts", {
  identifier: text("identifier").primaryKey(),   // the email, lowercased
  attempts: integer("attempts").notNull().default(0),
  requests: integer("requests").notNull().default(0),
  windowStart: timestamp("window_start").notNull().defaultNow(),
  lockedUntil: timestamp("locked_until"),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const verificationTokens = pgTable("verification_tokens", {
  identifier: text("identifier").notNull(),
  token: text("token").notNull(),
  expires: timestamp("expires", { mode: "date" }).notNull(),
}, (t) => [primaryKey({ columns: [t.identifier, t.token] })]);

// ---------------------------------------------------------------------------
// Domain tables
// ---------------------------------------------------------------------------

// Organizations the portal is shared WITH. Sierra Spectra itself is not a row
// here - staff/owner come from STAFF_EMAILS and see everything. A `client` owns
// or operates systems; a `provider` is an outside service outfit either side
// brings onto specific systems.
export const orgs = pgTable("orgs", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  kind: text("kind").notNull().default("client"), // client | provider
  // Does this organization run a workspace of its own - staff, documents it
  // signs, clients it creates? That is what makes it a TENANT, and it is the
  // difference between the company selling the service and the companies buying
  // it. One operator is the root (app_settings.operator_org_id): the company
  // running the instance, whose staff support every tenant. See lib/tenants.
  isOperator: boolean("is_operator").notNull().default(false),
  // The operator this organization belongs to. Null for operators themselves.
  // Cascade because a tenant's clients are part of that tenant: offboarding the
  // operator takes its client list, their logins and their shares with it.
  parentOrgId: integer("parent_org_id").references((): AnyPgColumn => orgs.id, { onDelete: "cascade" }),
  // Workspace appearance, set by the org's own editors: header color (hex)
  // and a logo shown beside the wordmark. Blank = the platform default look.
  themeColor: text("theme_color").notNull().default(""),
  logoUrl: text("logo_url").notNull().default(""),
  // Who at this organization receives its daily report. Each client gets its
  // own list and its own send button - one report per client, never a merged
  // one that would show them each other's systems.
  eodRecipients: text("eod_recipients").notNull().default(""),
  // How much stored file the organization may hold, in megabytes. 0 means no
  // ceiling, which is what every organization that predates this column was
  // given - a limit nobody agreed to is not a limit, it's an outage. New
  // organizations start at the default and the operator moves them from
  // Settings. See lib/storage for what counts toward it.
  storageLimitMb: integer("storage_limit_mb").notNull().default(5120),
  // Remote support, sold as a tier: with this on, the organization's own editors
  // can reach their own machines from the portal. House staff always can - that
  // is the base service - so this dial is only about client self-service.
  remoteAccessEnabled: boolean("remote_access_enabled").notNull().default(false),
  // The engine's device group for this organization, created the first time a
  // machine is enrolled for them. One group per org is what keeps one client's
  // machines invisible to another. Blank = no group yet.
  remoteGroupId: text("remote_group_id").notNull().default(""),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (t) => [unique("org_name_unique").on(t.name)]);

/**
 * The tenant stamp.
 *
 * Every top-level record carries the operator whose workspace it belongs to, set
 * once at creation and never derived: a system, a spare, a procedure, a
 * stockroom. Staff see their own tenant's records plus whatever another operator
 * has shared with them (see lib/tenants).
 *
 * Deliberately nullable, and NULL means "no tenant" rather than "every tenant".
 * A record created without a stamp disappears from its own workspace - loud, and
 * caught in testing - instead of appearing in everybody else's. Reads fail
 * closed; only platform staff, who see every tenant anyway, can find one.
 *
 * ON DELETE CASCADE: offboarding an operator takes its work with it. The audit
 * log is the one exception (set null), because history should outlive the
 * account it describes.
 */
const tenantStamp = () => integer("tenant_org_id").references(() => orgs.id, { onDelete: "cascade" });

// The visibility rule, one row per (system, org): an org sees exactly the
// systems shared with it. `access` 'view' is read-only however the org's role
// is set; 'edit' lets its editors work the system.
export const systemShares = pgTable("system_shares", {
  id: serial("id").primaryKey(),
  instrumentId: integer("instrument_id").notNull().references(() => instruments.id, { onDelete: "cascade" }),
  orgId: integer("org_id").notNull().references(() => orgs.id, { onDelete: "cascade" }),
  access: text("access").notNull().default("view"), // view | edit
  addedBy: text("added_by").notNull().default(""),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (t) => [
  unique("system_share_unique").on(t.instrumentId, t.orgId),
  index("system_shares_org_idx").on(t.orgId),
]);

// Per-asset visibility, one row per (asset, org) - the standalone-asset twin
// of system_shares, so a spare's dossier can be shown to any number of
// organizations. An asset that sits on a system is normally reached through
// the system's shares; these rows matter for shelf stock and for units whose
// dossier should outlive a system detachment.
export const assetShares = pgTable("asset_shares", {
  id: serial("id").primaryKey(),
  assetId: integer("asset_id").notNull().references(() => assets.id, { onDelete: "cascade" }),
  orgId: integer("org_id").notNull().references(() => orgs.id, { onDelete: "cascade" }),
  access: text("access").notNull().default("view"), // view | edit
  addedBy: text("added_by").notNull().default(""),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (t) => [
  unique("asset_share_unique").on(t.assetId, t.orgId),
  index("asset_shares_org_idx").on(t.orgId),
]);

// Stage vocabulary lives in src/lib/stages.ts; stored here as a text array.
export const instruments = pgTable("instruments", {
  id: serial("id").primaryKey(),
  /**
   * The photo of the whole system - an LC and an MS standing next to each other,
   * the thing an engineer recognizes across a room and a client recognizes as
   * theirs. A pointer to an ordinary attachment rather than a URL of its own, so
   * one file is one row: it counts against storage once, it is reachable only
   * through the authorized proxy, and deleting the file clears this by itself.
   */
  photoAttachmentId: integer("photo_attachment_id"),
  tenantOrgId: tenantStamp(),
  externalId: text("external_id").unique().notNull(), // e.g. T-003, CASA-001
  client: text("client").notNull(),                   // Testen, GMI, Utah, Casablanca
  // Shop-defined grouping, e.g. "LC-MS", "GC", "N2 generator". Added on the fly
  // from the system form; the vocabulary is whatever is in use.
  category: text("category").notNull().default(""),
  // A name you chose, which always wins over the composed one. Blank means
  // "name it from the assets" - fine for a two-box system, useless once seven
  // LC modules add up to a paragraph. See lib/systemLabel.
  name: text("name").notNull().default(""),
  // Legacy free-text description. No longer edited: a system with no chosen
  // name is named by its assets (lib/systemLabel). Kept as the fallback for
  // pre-asset records and sheet imports.
  model: text("model").notNull(),
  manufacturer: text("manufacturer").notNull().default(""), // Shimadzu, Agilent, Thermo...
  serial: text("serial").notNull().default(""),             // the instrument's own serial
  location: text("location").notNull().default(""),         // room / bench on the client's floor
  // Which organization owns this system - a client, or a service company that
  // owns its own stock. Null = stewarded by the house: work the operator runs
  // directly, and systems a provider logged before the real owner joined the
  // platform ("unclaimed"). The owner's editors approve access requests;
  // visibility itself still comes only from system_shares.
  ownerOrgId: integer("owner_org_id").references(() => orgs.id, { onDelete: "set null" }),
  // WHOSE QUEUE the system is sitting in - a third axis, independent of both
  // ownership and access. A refurbished system parked with the client while
  // they run application tests is still ours to own and everyone's to see, but
  // it is not our move: nothing we do clears it. Null = our queue.
  //
  // This is what lets a finished system leave the shop's board without being
  // archived or shipped, and it's why turnaround can stop counting days that
  // were never ours to spend (see lib/reports).
  queueOrgId: integer("queue_org_id").references(() => orgs.id, { onDelete: "set null" }),
  queueReason: text("queue_reason").notNull().default(""), // "waiting on your N2 generator tech"
  // When it landed in the current queue. Null = never moved, so read it as the
  // system's own createdAt rather than backfilling every row.
  queueSince: timestamp("queue_since"),
  // Resale state, set by the owning org (or staff). While for_sale is true the
  // listing_token URL serves a public, heavily redacted view of the system:
  // maintenance history and opted-in reports, never location/client/costs.
  // The token survives unmarking (the URL just 404s) so re-listing keeps links.
  forSale: boolean("for_sale").notNull().default(false),
  saleNote: text("sale_note").notNull().default(""), // public blurb on the listing
  listingToken: text("listing_token").notNull().default(""),
  priority: integer("priority").notNull().default(99),
  // Who's driving this system - a people-roster name (Sierra or LabZen), assignable by either side.
  lead: text("lead").notNull().default(""),
  // Retired from the active fleet but kept in full. Archiving is the editor-safe
  // alternative to deletion; hard delete stays owner-only.
  archived: boolean("archived").notNull().default(false),
  archivedAt: timestamp("archived_at"),
  archivedBy: text("archived_by").notNull().default(""),
  stages: text("stages").array().notNull().default([]),
  notes: text("notes").notNull().default(""),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

// An organization's frozen copy of a system's record. `data` is the full
// dossier as of that instant - immutable by construction, later edits to the
// live system can never reach it. The record outlives the system (FK set null)
// and carries its own external_id/label so it still reads on its own.
//
// Two things mint one, and they read very differently to the holder:
//   'revoked'  a service provider's share was withdrawn - "they keep their own
//              service reports". Clients don't get one; unsharing a client is
//              cleanup, not the end of an engagement.
//   'handoff'  the system changed hands and this org was the outgoing owner.
//              Unlike a revocation this does NOT imply access ended: a reseller
//              kept on as a viewer holds a record AND still sees the live
//              system, which is why listings filter on live visibility rather
//              than assuming the record means "gone".
//
// A repeat event of the same kind for the same org supersedes the earlier
// record rather than stacking beside it - the newer dossier covers the same
// tenure. Superseded rows are kept (a dossier is evidence, never deleted) and
// simply drop out of the listings.
export const engagementRecords = pgTable("engagement_records", {
  id: serial("id").primaryKey(),
  instrumentId: integer("instrument_id").references(() => instruments.id, { onDelete: "set null" }),
  orgId: integer("org_id").notNull().references(() => orgs.id, { onDelete: "cascade" }),
  kind: text("kind").notNull().default("revoked"),
  externalId: text("external_id").notNull().default(""),
  label: text("label").notNull().default(""),
  revokedBy: text("revoked_by").notNull().default(""),
  revokedAt: timestamp("revoked_at").notNull().defaultNow(),
  supersededAt: timestamp("superseded_at"),
  data: jsonb("data").notNull(),
}, (t) => [index("engagement_records_org_idx").on(t.orgId)]);

// The operator's own people, and what they can do. Owner-managed from Settings
// so adding or revoking a colleague no longer means editing an environment
// variable and redeploying.
//
// Exact emails only - no "@domain" entries, for the same reason STAFF_EMAILS
// never allowed them: house access sees every organization's data, and one
// mistyped domain would hand that to everyone who happens to share it.
//
// role 'none' is a deliberate third value: it revokes somebody who is still
// listed in STAFF_EMAILS. The env list stays authoritative for the ROOT owner
// (see lib/houseRole) precisely so a bad edit here can never lock everyone out
// of an instance, but everyone else has to be revocable from the UI, and the
// only way to say "env says staff, we say no" is to record it.
export const houseMembers = pgTable("house_members", {
  id: serial("id").primaryKey(),
  email: text("email").notNull(),
  // Which operator this person is staff of - the workspace they run, and the
  // only tenant they are the house of. Null is a staff row with no company,
  // which lib/tenants resolves to seeing nothing rather than seeing everything.
  //
  // The email unique index below is deliberately kept: a person is staff of one
  // service company. An engineer who moves companies is moved, not duplicated.
  orgId: integer("org_id").references(() => orgs.id, { onDelete: "cascade" }),
  role: text("role").notNull().default("staff"), // owner | staff | none
  name: text("name").notNull().default(""),      // display only
  addedBy: text("added_by").notNull().default(""),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (t) => [unique("house_member_email_unique").on(t.email)]);

// Chain of custody. instruments.owner_org_id is the fast "who owns it now"
// pointer; this is the history behind it, and for a resale market that history
// is the product - a serial number that can prove who has held a system and
// when is worth more than one that can't.
//
// A handoff (LabZen ships a refurbished system to their own client) writes one
// row here, leaves the service provider's share in place, and freezes an
// engagement record for the outgoing owner. Backfilled with one 'intake' row
// per already-owned system so the chain has a start.
export const custodyEvents = pgTable("custody_events", {
  id: serial("id").primaryKey(),
  instrumentId: integer("instrument_id").references(() => instruments.id, { onDelete: "cascade" }),
  assetId: integer("asset_id").references(() => assets.id, { onDelete: "cascade" }),
  // intake (first known owner) | transfer (handed on) | claim (granted via a
  // serial claim) | release (back to house stewardship)
  kind: text("kind").notNull().default("transfer"),
  fromOrgId: integer("from_org_id").references(() => orgs.id, { onDelete: "set null" }),
  toOrgId: integer("to_org_id").references(() => orgs.id, { onDelete: "set null" }),
  // Names kept as text as well as ids: an org row can be deleted, but the
  // custody record has to stay readable forever.
  fromName: text("from_name").notNull().default(""),
  toName: text("to_name").notNull().default(""),
  note: text("note").notNull().default(""),
  actor: text("actor").notNull().default(""),
  at: timestamp("at").notNull().defaultNow(),
}, (t) => [
  index("custody_instrument_idx").on(t.instrumentId),
  index("custody_asset_idx").on(t.assetId),
]);

// Every time a system changed hands as WORK - who was expected to act next,
// and why. Distinct from custody_events, which is ownership: LabZen can own a
// system that sits in our queue, and can hold the queue on a system Acme owns.
//
// Kept as a ledger because the durations matter: three weeks waiting on the
// client's nitrogen contractor should not land in our turnaround figures, and
// the only way to prove that is a record of when the ball was in whose court.
export const queueEvents = pgTable("queue_events", {
  id: serial("id").primaryKey(),
  instrumentId: integer("instrument_id").notNull().references(() => instruments.id, { onDelete: "cascade" }),
  fromOrgId: integer("from_org_id").references(() => orgs.id, { onDelete: "set null" }),
  toOrgId: integer("to_org_id").references(() => orgs.id, { onDelete: "set null" }),
  // Null org ids mean the house, whose name isn't in the orgs table on every
  // instance - so both names are stored as text too, and stay readable forever.
  fromName: text("from_name").notNull().default(""),
  toName: text("to_name").notNull().default(""),
  reason: text("reason").notNull().default(""),
  actor: text("actor").notNull().default(""),
  at: timestamp("at").notNull().defaultNow(),
}, (t) => [index("queue_events_instrument_idx").on(t.instrumentId), index("queue_events_at_idx").on(t.at)]);

// Someone knocking on the door: they matched a serial in /lookup and asked to
// be let onto the system. An 'access' request asks to be let in and is decided
// by staff or the owning org's editors; a 'claim' asserts "this instrument is
// ours" and only the platform operator may grant it, since approving one moves
// ownership - and a serial number is not proof of purchase.
export const accessRequests = pgTable("access_requests", {
  id: serial("id").primaryKey(),
  instrumentId: integer("instrument_id").notNull().references(() => instruments.id, { onDelete: "cascade" }),
  orgId: integer("org_id").notNull().references(() => orgs.id, { onDelete: "cascade" }),
  kind: text("kind").notNull().default("access"), // access | claim
  requestedBy: text("requested_by").notNull().default(""),
  message: text("message").notNull().default(""),
  status: text("status").notNull().default("pending"), // pending | approved | denied
  decidedBy: text("decided_by").notNull().default(""),
  decidedAt: timestamp("decided_at"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (t) => [index("access_requests_instrument_idx").on(t.instrumentId)]);

// Preventive maintenance, the calendar kind: "flush the lines every 90 days".
// A schedule belongs to a system or a standalone asset, and the daily cron
// turns each due schedule into an ordinary task (origin 'pm'), so everything
// downstream - assignment, checklists, notifications, sign-off packets - works
// on PM work with no special cases. Completing the task advances next_due from
// the day it was done (floating cadence), which is how shops actually run:
// changing a filter late doesn't owe you an extra change next week.
// One procedure catalog: everything defined against a module type (or
// "system") that turns into work on units automatically. WHEN it fires is a
// property, not a table: runs_at_intake covers the old checkout items,
// interval_days the old maintenance templates, and one row can carry both -
// "Leak check" at intake AND quarterly is one definition, not two that drift.
// interval_days null is the single statement of "does not repeat".
//
// parts is a JSON list [{name, number}] in a text column - same convention as
// parts.specs - because the parts table is per-work-order tracking rows, not
// an inventory entity a catalog could join.
export const procedures = pgTable("procedures", {
  id: serial("id").primaryKey(),
  tenantOrgId: tenantStamp(),
  assetType: text("asset_type").notNull(),          // catalog module type or "system"
  kind: text("kind").notNull().default("task"),     // 'task' | 'test'
  name: text("name").notNull(),
  notes: text("notes").notNull().default(""),
  position: integer("position").notNull().default(0), // ordering within its type; generated tasks keep it
  // Test-only
  resultType: text("result_type").notNull().default("pass_fail"),
  target: text("target"),
  tolerancePct: numeric("tolerance_pct"),
  // Task-only
  requiresNote: boolean("requires_note").notNull().default(false),
  consumesPart: boolean("consumes_part").notNull().default(false),
  // Timing. Both may be true; both false is rejected by the actions.
  runsAtIntake: boolean("runs_at_intake").notNull().default(false),
  intervalDays: integer("interval_days"),
  // Mandatory for sign-off: the work it generates must be Done, and a test
  // must additionally have a report filed against it, before anyone can sign.
  required: boolean("required").notNull().default(false),
  parts: text("parts").notNull().default(""),       // JSON [{name, number}], "" = none
  modelScope: text("model_scope").array().notNull().default([]), // [] = all models
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

// RETIRED: merged into `procedures` (see the procedures-merge migration).
// The table stays because the sync pipeline is additive-only; nothing reads it.
export const pmTemplates = pgTable("pm_templates", {
  id: serial("id").primaryKey(),
  assetType: text("asset_type").notNull(), // MODULE_KINDS entry, e.g. "Pump"
  title: text("title").notNull(),
  body: text("body").notNull().default(""),
  everyDays: integer("every_days").notNull(),
  // The consumable the job takes, structured so a generated task can turn
  // into a part request without retyping the number.
  partName: text("part_name").notNull().default(""),
  partNumber: text("part_number").notNull().default(""),
  modelScope: text("model_scope").array().notNull().default([]), // [] = all models
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const pmSchedules = pgTable("pm_schedules", {
  id: serial("id").primaryKey(),
  tenantOrgId: tenantStamp(),
  instrumentId: integer("instrument_id").references(() => instruments.id, { onDelete: "cascade" }),
  assetId: integer("asset_id").references(() => assets.id, { onDelete: "cascade" }),
  title: text("title").notNull(),
  body: text("body").notNull().default(""),
  assignee: text("assignee").notNull().default(""),
  everyDays: integer("every_days").notNull(),
  nextDue: text("next_due").notNull(), // YYYY-MM-DD in shop time
  lastDone: text("last_done").notNull().default(""), // blank = never yet done
  paused: boolean("paused").notNull().default(false),
  // The part(s) the job takes, carried onto every generated task. `parts` is
  // JSON [{name, number}]; the single name/number pair predates it and is
  // still written by hand-made schedules - readers go through
  // schedulePartsOf(), which falls back to the pair.
  partName: text("part_name").notNull().default(""),
  partNumber: text("part_number").notNull().default(""),
  parts: text("parts").notNull().default(""),
  // Which definition stamped this schedule out; null = written by hand. Kept
  // on deletion - the schedule is shop data now, not catalog state.
  // template_id predates the procedures merge and is no longer written.
  templateId: integer("template_id").references(() => pmTemplates.id, { onDelete: "set null" }),
  procedureId: integer("procedure_id").references(() => procedures.id, { onDelete: "set null" }),
  createdBy: text("created_by").notNull().default(""),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (t) => [index("pm_instrument_idx").on(t.instrumentId), index("pm_asset_idx").on(t.assetId)]);

// A task belongs to a system, to an asset on its own (a spare on the bench), or
// to both (system work tagged to the unit it happened on). At least one is set.
export const tasks = pgTable("tasks", {
  id: serial("id").primaryKey(),
  tenantOrgId: tenantStamp(),
  instrumentId: integer("instrument_id").references(() => instruments.id, { onDelete: "cascade" }),
  title: text("title").notNull(),
  body: text("body").notNull().default(""),
  // Open | In progress | Blocked | Done
  state: text("state").notNull().default("Open"),
  assignee: text("assignee").notNull().default(""),
  dueDate: text("due_date").notNull().default(""), // YYYY-MM-DD in shop time, blank = no date
  // '' = hand-made | 'checkout' = auto-generated test | 'pm' = from a maintenance
  // schedule | 'issue' = raised by whoever owns the system saying it is broken |
  // 'pm_request' = the client asking for upkeep (no schedule attached on purpose:
  // completing it must not move a contract's calendar - see lib/pmRequest)
  origin: text("origin").notNull().default(""),
  assetId: integer("asset_id").references(() => assets.id, { onDelete: "set null" }), // optional: which asset this is about
  // Which schedule generated this task; completing it advances that schedule.
  pmScheduleId: integer("pm_schedule_id").references(() => pmSchedules.id, { onDelete: "set null" }),
  // Which catalog procedure generated it (intake work). Kept so sign-off can
  // tell which tasks are mandatory without matching on titles.
  procedureId: integer("procedure_id").references(() => procedures.id, { onDelete: "set null" }),
  sortOrder: integer("sort_order").notNull().default(0),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  completedAt: timestamp("completed_at"),
}, (t) => [index("tasks_instrument_idx").on(t.instrumentId)]);

export const checklistItems = pgTable("checklist_items", {
  id: serial("id").primaryKey(),
  taskId: integer("task_id").notNull().references(() => tasks.id, { onDelete: "cascade" }),
  text: text("text").notNull(),
  done: boolean("done").notNull().default(false),
  sortOrder: integer("sort_order").notNull().default(0),
}, (t) => [index("checklist_task_idx").on(t.taskId)]);

// Threaded notes on a single checklist item (the model Joe picked: B, collapsed)
export const itemNotes = pgTable("item_notes", {
  id: serial("id").primaryKey(),
  itemId: integer("item_id").notNull().references(() => checklistItems.id, { onDelete: "cascade" }),
  author: text("author").notNull(),
  text: text("text").notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (t) => [index("item_notes_item_idx").on(t.itemId)]);

// Task-level notes thread (commentary about the whole job)
export const taskNotes = pgTable("task_notes", {
  id: serial("id").primaryKey(),
  taskId: integer("task_id").notNull().references(() => tasks.id, { onDelete: "cascade" }),
  author: text("author").notNull(),
  text: text("text").notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (t) => [index("task_notes_task_idx").on(t.taskId)]);

// Gas requirements per system. One row per (instrument, gas); status vocabulary
// lives in src/lib/stages.ts. Tank details go in the free-text note - individual
// tank inventory is deliberately not modeled (yet).
export const instrumentGases = pgTable("instrument_gases", {
  id: serial("id").primaryKey(),
  instrumentId: integer("instrument_id").references(() => instruments.id, { onDelete: "cascade" }),
  assetId: integer("asset_id").references(() => assets.id, { onDelete: "cascade" }), // gases for a standalone asset
  gas: text("gas").notNull(),                          // Helium, Nitrogen, ...
  status: text("status").notNull().default("Connected"), // Connected | Low | Empty | Not connected | Not needed
  note: text("note").notNull().default(""),            // tank #, psi, supplier
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, (t) => [index("gases_instrument_idx").on(t.instrumentId), unique("gases_instrument_gas").on(t.instrumentId, t.gas)]);

// Same ownership rule as tasks: a system, a standalone asset, or both.
export const parts = pgTable("parts", {
  id: serial("id").primaryKey(),
  instrumentId: integer("instrument_id").references(() => instruments.id, { onDelete: "cascade" }),
  // part | consumable - consumables (ferrules, septa, liners) share the same
  // lifecycle/cost/audit but get a lighter-weight form.
  kind: text("kind").notNull().default("part"),
  assetId: integer("asset_id").references(() => assets.id, { onDelete: "set null" }), // optional: which asset it went into
  name: text("name").notNull(),
  partNumber: text("part_number").notNull().default(""),
  serial: text("serial").notNull().default(""),
  qty: text("qty").notNull().default(""), // free text, mainly for consumables
  // Custom label/value fields as a JSON array of {k,v} - e.g. GC column ID/length.
  specs: text("specs").notNull().default(""),
  vendor: text("vendor").notNull().default(""),
  po: text("po").notNull().default(""),
  cost: text("cost").notNull().default(""), // free text, the display source of truth
  // Parsed from `cost` server-side on every write (lib/money) so reports can
  // sum spend. Null = never parsed / not money-shaped; 0 is a real zero.
  costCents: integer("cost_cents"),
  // Whose money bought it, stamped at write time from the system's owner then.
  // Cost visibility follows THIS, not the system's current owner: when a system
  // is handed on, the new owner must not inherit sight of what the previous one
  // paid. Null = pre-handoff rows and house-stewarded work, which fall back to
  // the system's owner (correct, since nothing had changed hands yet).
  ownerOrgId: integer("owner_org_id").references(() => orgs.id, { onDelete: "set null" }),
  carrier: text("carrier").notNull().default(""),
  tracking: text("tracking").notNull().default(""),
  orderedAt: text("ordered_at").notNull().default(""),
  eta: text("eta").notNull().default(""),
  receivedAt: text("received_at").notNull().default(""),
  installedAt: text("installed_at").notNull().default(""),
  removedAt: text("removed_at").notNull().default(""),
  // Install/swap detail: what it replaced, serial in/out, where it came from.
  note: text("note").notNull().default(""),
  // Needed | Ordered | In transit | Received | Backordered | Installed | Removed
  status: text("status").notNull().default("Needed"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (t) => [index("parts_instrument_idx").on(t.instrumentId)]);

export const attachments = pgTable("attachments", {
  /**
   * How this photo sits in a thumbnail: "rot,zoom,x,y", blank for untouched.
   * The stored file is never altered - framing is a preference about display,
   * and cropping evidence to tidy a tile is not a trade worth making. Parsed by
   * lib/photoFrame, which is also the only place that knows the format.
   */
  framing: text("framing").notNull().default(""),
  id: serial("id").primaryKey(),
  tenantOrgId: tenantStamp(),
  instrumentId: integer("instrument_id").references(() => instruments.id, { onDelete: "cascade" }),
  assetId: integer("asset_id").references(() => assets.id, { onDelete: "cascade" }), // files for a standalone asset
  // Whose shelf a HOMELESS file sits on - one with no system and no unit.
  // Every organization has its own document library, and null is the
  // operator's. Files that do belong to a record need no stamp: they live in
  // the store of whoever owns that record, which is why a system joining a
  // client's roster brings its paperwork along. See lib/storage.
  orgId: integer("org_id").references(() => orgs.id, { onDelete: "cascade" }),
  fileName: text("file_name").notNull(),
  // Tune report | Test data | Report | Photo | Manual | Other
  kind: text("kind").notNull().default("Other"),
  description: text("description").notNull().default(""),
  url: text("url").notNull(),         // Vercel Blob URL
  size: integer("size").notNull().default(0), // bytes
  uploadedBy: text("uploaded_by").notNull(),
  // The task this file is evidence FOR - how a mandatory test proves it
  // passed. Null for general documents (manuals, photos, delivery paperwork).
  taskId: integer("task_id").references(() => tasks.id, { onDelete: "set null" }),
  // Files are opt-in on a for-sale listing, so no report leaks by accident.
  showOnListing: boolean("show_on_listing").notNull().default(false),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (t) => [index("attachments_instrument_idx").on(t.instrumentId)]);

/**
 * A release signature: one person, at one moment, stating that a system (or a
 * standalone unit) is fit to hand over. Append-only in spirit - a signature is
 * revoked with a reason rather than edited, and the revocation is kept.
 *
 * `data` freezes what was true at signing (task counts, the mandatory tests and
 * the reports that evidenced them) because that is what the signature actually
 * attests to. The live record keeps moving; the claim does not.
 *
 * Honest limits: identity comes from the authenticated session and intent from
 * a typed name, not from re-entering a password - this instance signs in by
 * magic link, so there is no password to re-challenge. That makes this a strong
 * audited approval, not a 21 CFR 11 electronic signature. Getting there needs a
 * second factor at the moment of signing.
 */
export const signoffs = pgTable("signoffs", {
  id: serial("id").primaryKey(),
  instrumentId: integer("instrument_id").references(() => instruments.id, { onDelete: "cascade" }),
  assetId: integer("asset_id").references(() => assets.id, { onDelete: "cascade" }),
  signedBy: text("signed_by").notNull(),       // authenticated email
  signerName: text("signer_name").notNull(),   // typed at signing, the intent
  signerTitle: text("signer_title").notNull().default(""),
  meaning: text("meaning").notNull().default("Approved for release"),
  note: text("note").notNull().default(""),
  data: jsonb("data").notNull(),               // frozen evidence snapshot
  revokedAt: timestamp("revoked_at"),
  revokedBy: text("revoked_by").notNull().default(""),
  revokedReason: text("revoked_reason").notNull().default(""),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (t) => [index("signoffs_instrument_idx").on(t.instrumentId), index("signoffs_asset_idx").on(t.assetId)]);

// One row per (system or asset, day): the client-facing end-of-day update.
// Written where the work happens - on the system's or asset's own page - and
// assembled by /eod into one email per client, which is why the row can hang
// off either target. Exactly one of instrument_id / asset_id is set.
export const eodUpdates = pgTable("eod_updates", {
  id: serial("id").primaryKey(),
  tenantOrgId: tenantStamp(),
  instrumentId: integer("instrument_id").references(() => instruments.id, { onDelete: "cascade" }),
  assetId: integer("asset_id").references(() => assets.id, { onDelete: "cascade" }),
  date: text("date").notNull(), // YYYY-MM-DD in shop time
  // Whose report this line belonged to ON THIS DATE, stamped at write time and
  // never updated. Reading the owner off the system instead meant a handoff
  // rewrote history: a system sold on Tuesday took Monday's update with it,
  // vanishing from the old client's report and appearing on the new owner's,
  // who had nothing to do with the work. Null is the operator's own group.
  ownerOrgId: integer("owner_org_id").references(() => orgs.id, { onDelete: "set null" }),
  systemUpdate: text("system_update").notNull().default(""),
  actionItem: text("action_item").notNull().default(""),
  skipped: boolean("skipped").notNull().default(false), // left out of today's email

  updatedBy: text("updated_by").notNull().default(""),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, (t) => [
  unique("eod_instrument_date").on(t.instrumentId, t.date),
  unique("eod_asset_date").on(t.assetId, t.date),
  index("eod_date_idx").on(t.date),
]);

// Append-only. No update or delete paths exist in the app code, by design.
export const auditLog = pgTable("audit_log", {
  id: serial("id").primaryKey(),
  // History outlives the account it describes, so this one is set null on
  // delete rather than cascade - see tenantStamp.
  tenantOrgId: integer("tenant_org_id").references(() => orgs.id, { onDelete: "set null" }),
  actor: text("actor").notNull(),          // email or "sheet-sync"
  instrumentId: integer("instrument_id"),  // nullable: settings changes etc.
  // Set whenever the change concerns an asset, so the asset page can show the
  // same activity feed a system gets. No FK: the log outlives its subjects.
  assetId: integer("asset_id"),
  entityType: text("entity_type").notNull(),
  entityId: text("entity_id").notNull().default(""),
  action: text("action").notNull(),        // human-readable summary
  field: text("field").notNull().default(""),
  oldValue: text("old_value").notNull().default(""),
  newValue: text("new_value").notNull().default(""),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (t) => [index("audit_instrument_idx").on(t.instrumentId), index("audit_created_idx").on(t.createdAt)]);

export const sheetDiffs = pgTable("sheet_diffs", {
  id: serial("id").primaryKey(),
  runAt: timestamp("run_at").notNull().defaultNow(),
  externalId: text("external_id").notNull(),
  field: text("field").notNull(),
  sheetValue: text("sheet_value").notNull().default(""),
  dbValue: text("db_value").notNull().default(""),
  resolved: boolean("resolved").notNull().default(false),
  resolvedBy: text("resolved_by").notNull().default(""),
  resolution: text("resolution").notNull().default(""), // kept_ours | accepted_sheet
}, (t) => [index("diffs_resolved_idx").on(t.resolved)]);

// Labour logged against a system, in minutes (entered as hours in the UI).
// Feeds the per-system total and, with parts cost, the true cost of a refurb.
export const timeEntries = pgTable("time_entries", {
  id: serial("id").primaryKey(),
  tenantOrgId: tenantStamp(),
  // System, standalone asset, or both - at least one set, enforced by
  // resolveTarget like every other work row.
  instrumentId: integer("instrument_id").references(() => instruments.id, { onDelete: "cascade" }),
  assetId: integer("asset_id").references(() => assets.id, { onDelete: "set null" }), // optional: which asset the hours went into
  person: text("person").notNull().default(""),
  date: text("date").notNull(),           // YYYY-MM-DD in shop time
  minutes: integer("minutes").notNull().default(0),
  note: text("note").notNull().default(""),
  loggedBy: text("logged_by").notNull().default(""),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (t) => [index("time_instrument_idx").on(t.instrumentId)]);

// Assets: the individual units systems are built from - an LC stack's pump,
// autosampler, detector, a GC's headspace unit. First-class citizens: each has
// its own identity, status, and lifecycle, and can be attached to a system,
// sit on the shelf as a spare (instrument_id null), or be decommissioned.
// Service history is derived: tasks/parts/time tagged with asset_id plus the
// lifecycle rows in asset_events.
export const assets = pgTable("assets", {
  id: serial("id").primaryKey(),
  tenantOrgId: tenantStamp(),
  /** This module's own photo. Same pointer-to-an-attachment rule as a system's. */
  photoAttachmentId: integer("photo_attachment_id"),
  instrumentId: integer("instrument_id").references(() => instruments.id, { onDelete: "set null" }), // null = unattached
  kind: text("kind").notNull().default("Other"), // Pump, Autosampler, ... (vocabulary in lib/stages.ts)
  model: text("model").notNull().default(""),
  serial: text("serial").notNull().default(""),
  manufacturer: text("manufacturer").notNull().default(""),
  // Whose unit it is - a client name, or blank for our own stock. Independent
  // of whatever system it currently sits in.
  owner: text("owner").notNull().default(""),
  // When the owner is an organization in the portal, this is the visibility
  // link: they see this unit even when it sits on no system of theirs.
  ownerOrgId: integer("owner_org_id").references(() => orgs.id, { onDelete: "set null" }),
  // Condition on arrival, in the tech's words. Written once at intake and kept.
  asFound: text("as_found").notNull().default(""),
  // Resale state - same contract as the instruments columns: while for_sale is
  // true the listing_token URL serves a public, redacted view of this unit.
  forSale: boolean("for_sale").notNull().default(false),
  saleNote: text("sale_note").notNull().default(""),
  listingToken: text("listing_token").notNull().default(""),
  // In service | Spare | Needs attention | Down | Decommissioned (lib/stages.ts)
  status: text("status").notNull().default("In service"),
  location: text("location").notNull().default(""), // where a spare lives: "shelf B"
  note: text("note").notNull().default(""),
  sortOrder: integer("sort_order").notNull().default(0),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (t) => [index("assets_instrument_idx").on(t.instrumentId)]);

// Asset lifecycle: installed / removed / moved / status changes, with the
// system involved. Merged with tagged work into the asset's service history.
export const assetEvents = pgTable("asset_events", {
  id: serial("id").primaryKey(),
  assetId: integer("asset_id").notNull().references(() => assets.id, { onDelete: "cascade" }),
  kind: text("kind").notNull(), // installed | removed | moved | status | note
  instrumentId: integer("instrument_id"), // the system involved, if any (no FK: survives system deletion)
  detail: text("detail").notNull().default(""),
  actor: text("actor").notNull().default(""),
  at: timestamp("at").notNull().defaultNow(),
}, (t) => [index("asset_events_asset_idx").on(t.assetId)]);

// Shared discussion threads between Sierra Spectra and the client. One thread
// per instrument, plus a General board (instrument_id null) for lab-wide items
// like the N2 generator project. Posting requires only a signed-in user -
// clients may post even when the edit toggle is off (talking != editing).
export const discussionPosts = pgTable("discussion_posts", {
  id: serial("id").primaryKey(),
  instrumentId: integer("instrument_id").references(() => instruments.id, { onDelete: "cascade" }), // null = General
  author: text("author").notNull(),
  authorEmail: text("author_email").notNull().default(""),
  body: text("body").notNull(),
  // Which organization the author was speaking for; null = the operator's own
  // staff. Stored on the post rather than looked up from the author, because a
  // person can change organizations and a post's audience cannot.
  authorOrgId: integer("author_org_id").references(() => orgs.id, { onDelete: "set null" }),
  // "all" = everyone who can see the thread. "internal" = the author's own
  // organization only, operator included: this is what keeps one company's
  // working talk off every other company's screen.
  audience: text("audience").notNull().default("all"),
  // General board only: whose room the post sits in. The operator sits in every
  // room, each organization only in its own, so the General board is a set of
  // private rooms and never a public square. Null = the operator's own board.
  roomOrgId: integer("room_org_id").references(() => orgs.id, { onDelete: "cascade" }),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (t) => [index("discussion_instrument_idx").on(t.instrumentId), index("discussion_created_idx").on(t.createdAt)]);

// Per-user read marks for discussion threads. threadId 0 = the General board,
// otherwise the instrument id. Drives the "N new" badges.
export const discussionReads = pgTable("discussion_reads", {
  id: serial("id").primaryKey(),
  userEmail: text("user_email").notNull(),
  threadId: integer("thread_id").notNull(),
  lastSeenAt: timestamp("last_seen_at").notNull().defaultNow(),
}, (t) => [unique("discussion_reads_user_thread").on(t.userEmail, t.threadId)]);

// People roster (Sierra + LabZen): task assignees and @mention targets.
// Email optional - blank falls back to the STAFF_EMAILS heuristic in notify.ts.
export const people = pgTable("people", {
  id: serial("id").primaryKey(),
  tenantOrgId: tenantStamp(),
  name: text("name").notNull(),
  email: text("email").notNull().default(""),
  org: text("org").notNull().default("sierra"), // sierra | labzen
}, (t) => [unique("people_name_unique").on(t.name)]);

// Stage transition history: one row every time a stage is added to or removed
// from an instrument. Powers the "12d in Checkout" age chips and cycle-time
// metrics. Written by toggleStage/createInstrument/deleteStage; renaming a
// custom stage leaves old rows under the old name (rare, accepted).
export const stageEvents = pgTable("stage_events", {
  id: serial("id").primaryKey(),
  instrumentId: integer("instrument_id").notNull().references(() => instruments.id, { onDelete: "cascade" }),
  stage: text("stage").notNull(),
  kind: text("kind").notNull(), // added | removed
  at: timestamp("at").notNull().defaultNow(),
}, (t) => [index("stage_events_instrument_idx").on(t.instrumentId)]);

// Shop vocabulary, defined ahead of use: system categories ("LC-MS") and
// asset models per type ("Autosampler" / "ASI-L"). Pickers everywhere combine
// these terms with values already in use, so a checkout test can be scoped to
// a model the shop hasn't stocked yet. Managed in Settings.
// The equipment catalog: system categories ("LC-MS"), asset types ("Pump"),
// and asset models ("LC-20AD") - curated by the house, shared by everyone on
// the instance, and the ONLY place equipment vocabulary is defined. Every
// picker that names a type, model or category reads from here; there is no
// free-text fallback, so "LC-20" spelled four ways can't happen. Seeded once
// from the fleet in use (see the catalog-seed migration), then curated.
//
// A model hangs off an asset TYPE (which is what a checkout item or PM template
// keys on) and is tagged with the system categories it belongs to, because
// those are different axes: a Detector means FID or TCD on a GC-MS and SPD-20A
// on an LC-MS. Empty categories = every system type, which is both the
// backward-compatible default for models defined before tagging existed and the
// right answer for genuinely universal kit like a control PC.
export const vocabTerms = pgTable("vocab_terms", {
  id: serial("id").primaryKey(),
  tenantOrgId: tenantStamp(),
  kind: text("kind").notNull(),                        // 'category' | 'asset_type' | 'model'
  assetType: text("asset_type").notNull().default(""), // models only: which asset type
  name: text("name").notNull(),
  // Models only: who makes it. Thirty pumps across seven makers in one pile is
  // unusable, so the catalog groups by this and asset forms fill the unit's
  // manufacturer in from it.
  manufacturer: text("manufacturer").notNull().default(""),
  // Models only: system categories this model appears under. [] = all of them.
  // An array rather than one value because a pump can serve LC-MS and HPLC
  // alike - same reasoning as checkout_items.model_scope.
  categories: text("categories").array().notNull().default([]),
  // What this kind of thing LOOKS like - a stock photo of the model, the module
  // type or the system type. Deliberately NOT an attachment: a catalog photo
  // illustrates a hundred records and belongs to none of them, so it must never
  // turn up in a client's Files, their gallery, or their storage bill. It is one
  // blob URL owned by the catalog row, served through /api/catalog/photo.
  photoUrl: text("photo_url").notNull().default(""),
  photoFraming: text("photo_framing").notNull().default(""),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  // Unique on identity only, not on categories: FID is one model that happens
  // to apply to several system types, not a row per type.
}, (t) => [unique("vocab_term_unique").on(t.kind, t.assetType, t.name)]);

// How one person arranges a record page: which panels sit in which column, in
// what order, and which they've hidden. Per PERSON, not per browser - two
// people sharing a workstation get their own view, and one person's arrangement
// follows them from the bench PC to a laptop.
//
// Keyed by sign-in email like the notification tables, and stored as jsonb
// because the shape belongs to the component: adding a panel or a third column
// later shouldn't need a migration to a table nobody queries by field.
export const uiLayouts = pgTable("ui_layouts", {
  id: serial("id").primaryKey(),
  email: text("email").notNull(),
  viewKey: text("view_key").notNull(),   // 'system' | 'asset'
  data: jsonb("data").notNull(),         // { order: string[], right: string[], hidden: string[] }
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, (t) => [unique("ui_layout_unique").on(t.email, t.viewKey)]);

// One row per event per recipient - the in-app copy of every notification the
// platform sends. Written BEFORE the email goes out, so "the mail was junked"
// never means "the event vanished". Keyed by sign-in email rather than user id
// because recipients (roster mentions, allowlisted clients) can be notified
// before they've ever signed in and created a users row.
export const notifications = pgTable("notifications", {
  id: serial("id").primaryKey(),
  email: text("email").notNull(),           // recipient, lowercase
  kind: text("kind").notNull(),             // NOTIFY_KINDS entry (lib/inbox)
  title: text("title").notNull(),           // one line, same voice as the email subject
  href: text("href").notNull().default(""), // in-app path, "" when there's nowhere to go
  createdAt: timestamp("created_at").notNull().defaultNow(),
  readAt: timestamp("read_at"),             // null = unread
}, (t) => [index("notifications_email_idx").on(t.email)]);

// Per-kind email opt-outs. No row = email on: the table only records
// departures from the default, so a fresh install (and every existing user)
// starts with everything enabled and the inbox always gets a row regardless.
export const notificationPrefs = pgTable("notification_prefs", {
  id: serial("id").primaryKey(),
  email: text("email").notNull(),
  kind: text("kind").notNull(),
  emailOn: boolean("email_on").notNull().default(true),
}, (t) => [unique("notification_prefs_unique").on(t.email, t.kind)]);

// ── Stock ───────────────────────────────────────────────────────────────────
// Where parts physically live. Three kinds, because "where is it" has three
// different answers in this business: a shelf in the shop, the client's own
// spares cage at their site, or a van/field kit that travels with a tech.
// A room's org is what makes cross-org stock meaningful - a client can let
// their service provider draw from their cage, and a provider can let the
// client see the spares held on their behalf (see stockroomShares).
export const stockrooms = pgTable("stockrooms", {
  id: serial("id").primaryKey(),
  tenantOrgId: tenantStamp(),
  name: text("name").notNull(),
  kind: text("kind").notNull().default("shop"), // shop | client | mobile
  // Whose stock this is. Null = the house's own.
  orgId: integer("org_id").references(() => orgs.id, { onDelete: "cascade" }),
  // mobile only: whose van or kit, so a tech's own stock is findable by name.
  keeper: text("keeper").notNull().default(""),
  location: text("location").notNull().default(""),
  note: text("note").notNull().default(""),
  archived: boolean("archived").notNull().default(false),
  createdBy: text("created_by").notNull().default(""),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (t) => [index("stockrooms_org_idx").on(t.orgId)]);

// Who else may see or draw from a room, one row per (room, org) - the same
// shape as systemShares. 'issue' is the meaningful grant: it lets another
// organization's editors decrement someone else's inventory.
export const stockroomShares = pgTable("stockroom_shares", {
  id: serial("id").primaryKey(),
  stockroomId: integer("stockroom_id").notNull().references(() => stockrooms.id, { onDelete: "cascade" }),
  orgId: integer("org_id").notNull().references(() => orgs.id, { onDelete: "cascade" }),
  access: text("access").notNull().default("view"), // view | issue
  addedBy: text("added_by").notNull().default(""),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (t) => [
  unique("stockroom_share_unique").on(t.stockroomId, t.orgId),
  index("stockroom_shares_org_idx").on(t.orgId),
]);

// On-hand of one part number in one room. Keyed on the part number as text,
// like the price book, and matched case-insensitively through the same
// normalizePn - inventory and pricing must agree on what "the same part" is.
// Case-insensitive uniqueness on (stockroom_id, part_number) is an expression
// index in drizzle/schema-sync.sql; the ORM can't declare lower().
export const stockItems = pgTable("stock_items", {
  id: serial("id").primaryKey(),
  stockroomId: integer("stockroom_id").notNull().references(() => stockrooms.id, { onDelete: "cascade" }),
  partNumber: text("part_number").notNull(),
  name: text("name").notNull().default(""),
  qty: integer("qty").notNull().default(0),
  // Reorder point. 0 = never suggest reordering this, which is the honest
  // default for a part nobody has decided a floor for yet.
  minQty: integer("min_qty").notNull().default(0),
  bin: text("bin").notNull().default(""),
  // What a unit actually cost, when it's known - set by PO receiving. Null
  // falls back to the price book's best offer when a part is issued.
  unitCostCents: integer("unit_cost_cents"),
  note: text("note").notNull().default(""),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, (t) => [index("stock_items_room_idx").on(t.stockroomId)]);

// The ledger. Counts live on stock_items for fast reads, but every change to
// one appends a move here, so "why does it say four" always has an answer and
// a miscount is a correcting entry rather than a silent overwrite.
export const stockMoves = pgTable("stock_moves", {
  id: serial("id").primaryKey(),
  stockroomId: integer("stockroom_id").notNull().references(() => stockrooms.id, { onDelete: "cascade" }),
  partNumber: text("part_number").notNull(),
  delta: integer("delta").notNull(),  // signed: +in, -out
  kind: text("kind").notNull(),       // receive | issue | adjust | transfer_in | transfer_out | return
  // transfer only: the room on the other end.
  counterpartyId: integer("counterparty_id").references(() => stockrooms.id, { onDelete: "set null" }),
  // issue only: what it went into, and the parts row it became.
  instrumentId: integer("instrument_id").references(() => instruments.id, { onDelete: "set null" }),
  assetId: integer("asset_id").references(() => assets.id, { onDelete: "set null" }),
  partId: integer("part_id").references(() => parts.id, { onDelete: "set null" }),
  reason: text("reason").notNull().default(""),
  actor: text("actor").notNull().default(""),
  at: timestamp("at").notNull().defaultNow(),
}, (t) => [index("stock_moves_room_idx").on(t.stockroomId), index("stock_moves_at_idx").on(t.at)]);

// A purchase order: one vendor, one destination shelf, the lines you're buying.
// Raised by hand or from a room's reorder list (which prices itself from the
// price book), then received - and receiving is what puts stock on the shelf,
// so the count and the paperwork can't disagree.
export const purchaseOrders = pgTable("purchase_orders", {
  id: serial("id").primaryKey(),
  tenantOrgId: tenantStamp(),
  // Human-facing number, assigned at creation and never reused.
  number: text("number").notNull(),
  vendor: text("vendor").notNull(),
  stockroomId: integer("stockroom_id").references(() => stockrooms.id, { onDelete: "set null" }),
  // Whose money. Follows the destination room's org, frozen here because a
  // room can be handed over later and the PO belongs to whoever paid.
  orgId: integer("org_id").references(() => orgs.id, { onDelete: "set null" }),
  // draft | sent | partial | received | cancelled
  status: text("status").notNull().default("draft"),
  reference: text("reference").notNull().default(""), // vendor quote or confirmation number
  note: text("note").notNull().default(""),
  expectedAt: text("expected_at").notNull().default(""), // free text, like parts.eta
  createdBy: text("created_by").notNull().default(""),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  sentAt: timestamp("sent_at"),
  closedAt: timestamp("closed_at"),
  cancelReason: text("cancel_reason").notNull().default(""),
}, (t) => [unique("po_number_unique").on(t.number), index("po_status_idx").on(t.status)]);

export const poLines = pgTable("po_lines", {
  id: serial("id").primaryKey(),
  poId: integer("po_id").notNull().references(() => purchaseOrders.id, { onDelete: "cascade" }),
  partNumber: text("part_number").notNull(),
  name: text("name").notNull().default(""),
  qtyOrdered: integer("qty_ordered").notNull().default(1),
  // Receiving accumulates here; a line is settled when received >= ordered.
  qtyReceived: integer("qty_received").notNull().default(0),
  unitCents: integer("unit_cents"),  // null = price not agreed yet
  note: text("note").notNull().default(""),
}, (t) => [index("po_lines_po_idx").on(t.poId)]);

// The house price book: what a part number costs from each vendor who sells
// it. One row per (PN, vendor) pair - the OEM's price and every third-party
// price sit side by side, so "request part" can pick the cheapest and an
// engineer filling in a part form sees what the shop last paid. House-curated
// like the catalog; prices are staff data and only ever shown where costs
// already are (lib/redact governs the read side).
//
// Case-insensitive uniqueness on (part_number, vendor) is an expression index
// in drizzle/schema-sync.sql ("part_prices_pn_vendor") - drizzle's pgTable
// can't declare lower() indexes, so the mirror carries it alone.
export const partPrices = pgTable("part_prices", {
  id: serial("id").primaryKey(),
  tenantOrgId: tenantStamp(),
  partNumber: text("part_number").notNull(),
  vendor: text("vendor").notNull(),
  // The maker's own listing vs a third party. Breaks price ties in the OEM's
  // favor - at the same price, provenance wins.
  isOem: boolean("is_oem").notNull().default(false),
  priceCents: integer("price_cents").notNull(),
  url: text("url").notNull().default(""),   // where to order it
  note: text("note").notNull().default(""), // "min order 5", "6wk lead time"
  updatedBy: text("updated_by").notNull().default(""),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

// RETIRED: merged into `procedures` (see the procedures-merge migration).
// The table stays because the sync pipeline is additive-only; nothing reads it
// except the older checkout_rules seed migration that fills it.
export const checkoutItems = pgTable("checkout_items", {
  id: serial("id").primaryKey(),
  assetType: text("asset_type").notNull(),          // MODULE_KINDS entry or "system"
  kind: text("kind").notNull().default("test"),     // 'task' | 'test'
  name: text("name").notNull(),
  position: integer("position").notNull().default(0), // ordering within its asset type
  // Test-only
  resultType: text("result_type").notNull().default("pass_fail"), // pass_fail | measured | reading | note
  target: text("target"),                           // e.g. "5 mL/min", or the note text
  tolerancePct: numeric("tolerance_pct"),           // only for measured, e.g. 10
  // Task-only
  requiresNote: boolean("requires_note").notNull().default(false),
  consumesPart: boolean("consumes_part").notNull().default(false),
  // [] = all models. For assetType 'system' this holds system types
  // (instruments.model values) instead of asset models.
  modelScope: text("model_scope").array().notNull().default([]),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

// RETIRED: SOP templates (a named bundle of tasks applied to an instrument in
// one tap). The feature went unused and its UI and actions were removed; the
// tables stay because the sync pipeline is additive-only. Nothing reads them.
export const taskTemplates = pgTable("task_templates", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (t) => [unique("task_templates_name_unique").on(t.name)]);

export const templateTasks = pgTable("template_tasks", {
  id: serial("id").primaryKey(),
  templateId: integer("template_id").notNull().references(() => taskTemplates.id, { onDelete: "cascade" }),
  title: text("title").notNull(),
  body: text("body").notNull().default(""),
  sortOrder: integer("sort_order").notNull().default(0),
}, (t) => [index("template_tasks_template_idx").on(t.templateId)]);

export const templateItems = pgTable("template_items", {
  id: serial("id").primaryKey(),
  templateTaskId: integer("template_task_id").notNull().references(() => templateTasks.id, { onDelete: "cascade" }),
  text: text("text").notNull(),
  sortOrder: integer("sort_order").notNull().default(0),
}, (t) => [index("template_items_task_idx").on(t.templateTaskId)]);

// Stage vocabulary: seeded with the nine built-ins (schema-sync.sql), owner
// can recolor any stage and add/rename/delete custom ones in Settings.
// Built-in rows (builtin=true) can't be renamed or deleted - their names are
// referenced by sync, dashboard counts, and the EOD report.
export const stageDefs = pgTable("stage_defs", {
  id: serial("id").primaryKey(),
  tenantOrgId: tenantStamp(),
  name: text("name").notNull(),
  bg: text("bg").notNull(),
  fg: text("fg").notNull(),
  sortOrder: integer("sort_order").notNull().default(0),
  builtin: boolean("builtin").notNull().default(false),
}, (t) => [unique("stage_defs_name_unique").on(t.name)]);

// Client sign-in allowlist, editable by the owner in Settings. An entry is
// either an exact email ("jane@labzenllc.com") or a whole domain
// ("@labzenllc.com"). Unioned with the CLIENT_EMAILS env allowlist at sign-in.
export const clientAllowlist = pgTable("client_allowlist", {
  id: serial("id").primaryKey(),
  entry: text("entry").notNull(),
  // Which organization this entry signs in as. Null = unusable (the sign-in
  // gate rejects it), so an entry can't grant access with no scope.
  orgId: integer("org_id").references(() => orgs.id, { onDelete: "cascade" }),
  // Per-person role: editors work the records, viewers read them. Replaces the
  // old instance-wide "clients can edit" toggle (kept in app_settings for the
  // one-time backfill, ignored since).
  canEdit: boolean("can_edit").notNull().default(false),
  addedBy: text("added_by").notNull().default(""),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (t) => [unique("allowlist_entry_unique").on(t.entry)]);

// Singleton row (id = 1)
export const appSettings = pgTable("app_settings", {
  id: integer("id").primaryKey().default(1),
  clientAccessEnabled: boolean("client_access_enabled").notNull().default(false),
  clientCanEdit: boolean("client_can_edit").notNull().default(false),
  // Comma-separated list the EOD "Send to LabZen" button emails.
  eodRecipients: text("eod_recipients").notNull().default(""),
  // Which org the Google-sheet tracker and the EOD report belong to. Only
  // systems shared with this org take part in either.
  sheetOrgId: integer("sheet_org_id").references(() => orgs.id, { onDelete: "set null" }),
  // What this instance calls itself. The platform is a product, not a service
  // company: every visible wordmark, page title and email header reads from
  // here so renaming it never needs a deploy. Blank falls back to
  // DEFAULT_BRAND in lib/brand.ts.
  platformName: text("platform_name").notNull().default(""),
  platformTagline: text("platform_tagline").notNull().default(""),
  // The service organization that runs this instance - Sierra Spectra here.
  // Distinct from the platform operator role: this is a provider org like any
  // other, so its engagements are shares and its people are org members.
  // Systems the operator creates are shared with it automatically.
  operatorOrgId: integer("operator_org_id").references(() => orgs.id, { onDelete: "set null" }),
  // Optional modules. The sheet tracker, EOD report and daily digest grew out
  // of one operator's workflow; a fresh instance ships with all three off and
  // their crons, nav entries and pages go quiet. This instance keeps them on
  // via a one-time migration.
  sheetSyncEnabled: boolean("sheet_sync_enabled").notNull().default(false),
  eodEnabled: boolean("eod_enabled").notNull().default(false),
  digestEnabled: boolean("digest_enabled").notNull().default(false),
  // Remote support: reaching a lab PC from the portal. Off until an operator
  // stands up the relay host and sets REMOTE_URL - the pages check both, so a
  // flag flipped before the infrastructure exists says so instead of failing.
  remoteEnabled: boolean("remote_enabled").notNull().default(false),
});

/**
 * A lab PC we can reach - the instrument controller running LabSolutions,
 * MassHunter, ChemStation. One row per machine an agent was installed on.
 *
 * This replaces "the PC's password", which is how remote support works today
 * with TeamViewer and UltraViewer: a shared secret that everyone who ever
 * needed access still knows, that is probably on a label, that cannot be
 * revoked without walking to the machine, and that leaves no record of who
 * connected. Here identity comes from the portal session, and every connection
 * writes an audit row naming a person.
 *
 * `orgId` is stamped at enrollment and is whose machine it is. It is deliberately
 * NOT re-derived from the linked system, because comparing the two is what tells
 * us the system has changed hands since the PC was enrolled - see
 * lib/remoteAccess, which turns that into a consent prompt.
 *
 * `nodeId` is the engine's own identifier for the machine. Everything else here
 * is a cache of what the engine knows, so the page still renders a useful list
 * when the relay host is unreachable.
 */
export const remoteDevices = pgTable("remote_devices", {
  id: serial("id").primaryKey(),
  tenantOrgId: tenantStamp(),
  orgId: integer("org_id").references(() => orgs.id, { onDelete: "cascade" }),
  // The system this PC drives, when it drives one. A pointer, so the device
  // survives the system being detached or deleted.
  instrumentId: integer("instrument_id").references(() => instruments.id, { onDelete: "set null" }),
  nodeId: text("node_id").notNull().default(""),
  name: text("name").notNull().default(""),
  platform: text("platform").notNull().default("windows"),
  // Staff's answer to "must somebody be at this machine?", overruling the one
  // derived from custody. Null - the normal state - means derive it.
  consentOverride: boolean("consent_override"),
  // Last time the agent said hello. Null until it first does. A cache: the
  // engine is the authority, this is what we can show without it.
  lastSeenAt: timestamp("last_seen_at"),
  enrolledBy: text("enrolled_by").notNull().default(""),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (t) => [
  unique("remote_device_node_unique").on(t.nodeId),
  index("remote_devices_org_idx").on(t.orgId),
  index("remote_devices_instrument_idx").on(t.instrumentId),
]);
