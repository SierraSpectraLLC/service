// NOTE: Deploys apply drizzle/schema-sync.sql (idempotent, additive), not
// `drizzle-kit push`. When you add a table/column/index here, mirror it there.
// The build's verify-schema gate fails the deploy if a column is missing, so a
// forgotten mirror is caught loudly - never shipped silently.
import {
  pgTable, text, integer, boolean, timestamp, serial, primaryKey, index, unique, numeric, jsonb,
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
  // Workspace appearance, set by the org's own editors: header color (hex)
  // and a logo shown beside the wordmark. Blank = the platform default look.
  themeColor: text("theme_color").notNull().default(""),
  logoUrl: text("logo_url").notNull().default(""),
  // Who at this organization receives its daily report. Each client gets its
  // own list and its own send button - one report per client, never a merged
  // one that would show them each other's systems.
  eodRecipients: text("eod_recipients").notNull().default(""),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (t) => [unique("org_name_unique").on(t.name)]);

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
  externalId: text("external_id").unique().notNull(), // e.g. T-003, CASA-001
  client: text("client").notNull(),                   // Testen, GMI, Utah, Casablanca
  // Shop-defined grouping, e.g. "LC-MS", "GC", "N2 generator". Added on the fly
  // from the system form; the vocabulary is whatever is in use.
  category: text("category").notNull().default(""),
  // Legacy free-text description. No longer edited: a system is named by its
  // assets (lib/systemLabel). Kept as the fallback for pre-asset records and
  // sheet imports.
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

// A service provider's frozen copy of a system's record, written the moment its
// share is revoked ("they keep their own service reports"). `data` is the full
// dossier as of that instant - immutable by construction, later edits to the
// live system can never reach it. Only provider-kind orgs get one; unsharing a
// client stays a clean delete. The record outlives the system (FK set null) and
// carries its own external_id/label so it still reads on its own.
export const engagementRecords = pgTable("engagement_records", {
  id: serial("id").primaryKey(),
  instrumentId: integer("instrument_id").references(() => instruments.id, { onDelete: "set null" }),
  orgId: integer("org_id").notNull().references(() => orgs.id, { onDelete: "cascade" }),
  externalId: text("external_id").notNull().default(""),
  label: text("label").notNull().default(""),
  revokedBy: text("revoked_by").notNull().default(""),
  revokedAt: timestamp("revoked_at").notNull().defaultNow(),
  data: jsonb("data").notNull(),
}, (t) => [index("engagement_records_org_idx").on(t.orgId)]);

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

// A task belongs to a system, to an asset on its own (a spare on the bench), or
// to both (system work tagged to the unit it happened on). At least one is set.
export const tasks = pgTable("tasks", {
  id: serial("id").primaryKey(),
  instrumentId: integer("instrument_id").references(() => instruments.id, { onDelete: "cascade" }),
  title: text("title").notNull(),
  body: text("body").notNull().default(""),
  // Open | In progress | Blocked | Done
  state: text("state").notNull().default("Open"),
  assignee: text("assignee").notNull().default(""),
  dueDate: text("due_date").notNull().default(""), // YYYY-MM-DD in shop time, blank = no date
  origin: text("origin").notNull().default(""), // '' = hand-made | 'checkout' = auto-generated test
  assetId: integer("asset_id").references(() => assets.id, { onDelete: "set null" }), // optional: which asset this is about
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
  cost: text("cost").notNull().default(""), // free text: "1,240" - money math not needed yet
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
  id: serial("id").primaryKey(),
  instrumentId: integer("instrument_id").references(() => instruments.id, { onDelete: "cascade" }),
  assetId: integer("asset_id").references(() => assets.id, { onDelete: "cascade" }), // files for a standalone asset
  fileName: text("file_name").notNull(),
  // Tune report | Test data | Report | Photo | Manual | Other
  kind: text("kind").notNull().default("Other"),
  description: text("description").notNull().default(""),
  url: text("url").notNull(),         // Vercel Blob URL
  size: integer("size").notNull().default(0), // bytes
  uploadedBy: text("uploaded_by").notNull(),
  // Files are opt-in on a for-sale listing, so no report leaks by accident.
  showOnListing: boolean("show_on_listing").notNull().default(false),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (t) => [index("attachments_instrument_idx").on(t.instrumentId)]);

// One row per (system or asset, day): the client-facing end-of-day update.
// Written where the work happens - on the system's or asset's own page - and
// assembled by /eod into one email per client, which is why the row can hang
// off either target. Exactly one of instrument_id / asset_id is set.
export const eodUpdates = pgTable("eod_updates", {
  id: serial("id").primaryKey(),
  instrumentId: integer("instrument_id").references(() => instruments.id, { onDelete: "cascade" }),
  assetId: integer("asset_id").references(() => assets.id, { onDelete: "cascade" }),
  date: text("date").notNull(), // YYYY-MM-DD in shop time
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
  instrumentId: integer("instrument_id").notNull().references(() => instruments.id, { onDelete: "cascade" }),
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
export const vocabTerms = pgTable("vocab_terms", {
  id: serial("id").primaryKey(),
  kind: text("kind").notNull(),                        // 'category' | 'model'
  assetType: text("asset_type").notNull().default(""), // models only: which asset type
  name: text("name").notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (t) => [unique("vocab_term_unique").on(t.kind, t.assetType, t.name)]);

// Checkout items: tasks and tests auto-created when a system or asset is
// added. Each asset type (or "system" for instrument-level items) carries an
// ordered list; a non-empty model scope narrows an item to those models and,
// per kind, scoped items REPLACE the type's all-model items when any match.
// Superseded checkout_rules stays in the DB (additive pipeline) but is only
// read by the schema-sync migration that seeds this table. Managed on
// /checkout.
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
});
