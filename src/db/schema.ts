// NOTE: Deploys apply drizzle/schema-sync.sql (idempotent, additive), not
// `drizzle-kit push`. When you add a table/column/index here, mirror it there.
// The build's verify-schema gate fails the deploy if a column is missing, so a
// forgotten mirror is caught loudly - never shipped silently.
import {
  pgTable, text, integer, boolean, timestamp, serial, primaryKey, index, unique,
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

// Stage vocabulary lives in src/lib/stages.ts; stored here as a text array.
export const instruments = pgTable("instruments", {
  id: serial("id").primaryKey(),
  externalId: text("external_id").unique().notNull(), // e.g. T-003, CASA-001
  client: text("client").notNull(),                   // Testen, GMI, Utah, Casablanca
  model: text("model").notNull(),
  priority: integer("priority").notNull().default(99),
  stages: text("stages").array().notNull().default([]),
  notes: text("notes").notNull().default(""),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const tasks = pgTable("tasks", {
  id: serial("id").primaryKey(),
  instrumentId: integer("instrument_id").notNull().references(() => instruments.id, { onDelete: "cascade" }),
  title: text("title").notNull(),
  body: text("body").notNull().default(""),
  // Open | In progress | Blocked | Done
  state: text("state").notNull().default("Open"),
  assignee: text("assignee").notNull().default(""),
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
  instrumentId: integer("instrument_id").notNull().references(() => instruments.id, { onDelete: "cascade" }),
  gas: text("gas").notNull(),                          // Helium, Nitrogen, ...
  status: text("status").notNull().default("Connected"), // Connected | Low | Empty | Not connected | Not needed
  note: text("note").notNull().default(""),            // tank #, psi, supplier
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, (t) => [index("gases_instrument_idx").on(t.instrumentId), unique("gases_instrument_gas").on(t.instrumentId, t.gas)]);

export const parts = pgTable("parts", {
  id: serial("id").primaryKey(),
  instrumentId: integer("instrument_id").notNull().references(() => instruments.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  partNumber: text("part_number").notNull().default(""),
  serial: text("serial").notNull().default(""),
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
  instrumentId: integer("instrument_id").notNull().references(() => instruments.id, { onDelete: "cascade" }),
  fileName: text("file_name").notNull(),
  // Tune report | Test data | Report | Photo | Manual | Other
  kind: text("kind").notNull().default("Other"),
  description: text("description").notNull().default(""),
  url: text("url").notNull(),         // Vercel Blob URL
  size: integer("size").notNull().default(0), // bytes
  uploadedBy: text("uploaded_by").notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (t) => [index("attachments_instrument_idx").on(t.instrumentId)]);

// One row per (instrument, day): the client-facing end-of-day update draft.
// Staff fill these in during the day; /eod renders them into the email template.
export const eodUpdates = pgTable("eod_updates", {
  id: serial("id").primaryKey(),
  instrumentId: integer("instrument_id").notNull().references(() => instruments.id, { onDelete: "cascade" }),
  date: text("date").notNull(), // YYYY-MM-DD in shop time
  systemUpdate: text("system_update").notNull().default(""),
  actionItem: text("action_item").notNull().default(""),
  skipped: boolean("skipped").notNull().default(false), // left out of today's email

  updatedBy: text("updated_by").notNull().default(""),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, (t) => [unique("eod_instrument_date").on(t.instrumentId, t.date), index("eod_date_idx").on(t.date)]);

// Append-only. No update or delete paths exist in the app code, by design.
export const auditLog = pgTable("audit_log", {
  id: serial("id").primaryKey(),
  actor: text("actor").notNull(),          // email or "sheet-sync"
  instrumentId: integer("instrument_id"),  // nullable: settings changes etc.
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

// Singleton row (id = 1)
export const appSettings = pgTable("app_settings", {
  id: integer("id").primaryKey().default(1),
  clientAccessEnabled: boolean("client_access_enabled").notNull().default(false),
  clientCanEdit: boolean("client_can_edit").notNull().default(false),
});
