-- Idempotent, additive schema sync. Applied on every Vercel build by
-- scripts/sync-schema.ts, then verified by scripts/verify-schema.ts.
--
-- RULES (keep this file safe to run against any DB state):
--   * Only CREATE / ADD. Never DROP, never ALTER an existing column's type.
--   * Every statement guarded (IF NOT EXISTS or a pg_constraint check), so it
--     is a no-op when the object already exists and heals a DB that is missing it.
--   * Mirror every additive change from src/db/schema.ts here. The build's
--     verify-schema gate fails the deploy if a column is missing, so a
--     forgotten mirror is caught loudly - it is never shipped silently.
--
-- Why not drizzle-kit push here: push does an introspection diff and, against
-- the production catalog, emits spurious destructive statements (DROP NOT NULL
-- on PK columns, PK rebuilds) in one transaction; a single failure rolls back
-- the whole batch including the legit changes. This file cannot do that.

-- ── Tables ────────────────────────────────────────────────────────────────
-- Auth.js
CREATE TABLE IF NOT EXISTS "users" (
  "id" text PRIMARY KEY NOT NULL,
  "name" text,
  "email" text NOT NULL,
  "email_verified" timestamp,
  "image" text,
  "role" text NOT NULL DEFAULT 'client_viewer',
  CONSTRAINT "users_email_unique" UNIQUE ("email")
);
CREATE TABLE IF NOT EXISTS "accounts" (
  "user_id" text NOT NULL,
  "type" text NOT NULL,
  "provider" text NOT NULL,
  "provider_account_id" text NOT NULL,
  "refresh_token" text,
  "access_token" text,
  "expires_at" integer,
  "token_type" text,
  "scope" text,
  "id_token" text,
  "session_state" text,
  CONSTRAINT "accounts_provider_provider_account_id_pk" PRIMARY KEY ("provider","provider_account_id")
);
CREATE TABLE IF NOT EXISTS "sessions" (
  "session_token" text PRIMARY KEY NOT NULL,
  "user_id" text NOT NULL,
  "expires" timestamp NOT NULL
);
CREATE TABLE IF NOT EXISTS "login_attempts" (
  "identifier" text PRIMARY KEY NOT NULL,
  "attempts" integer NOT NULL DEFAULT 0,
  "requests" integer NOT NULL DEFAULT 0,
  "window_start" timestamp NOT NULL DEFAULT now(),
  "locked_until" timestamp,
  "updated_at" timestamp NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS "verification_tokens" (
  "identifier" text NOT NULL,
  "token" text NOT NULL,
  "expires" timestamp NOT NULL,
  CONSTRAINT "verification_tokens_identifier_token_pk" PRIMARY KEY ("identifier","token")
);

-- Domain
CREATE TABLE IF NOT EXISTS "orgs" (
  "id" serial PRIMARY KEY NOT NULL,
  "name" text NOT NULL,
  "kind" text NOT NULL DEFAULT 'client',
  "created_at" timestamp NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS "system_shares" (
  "id" serial PRIMARY KEY NOT NULL,
  "instrument_id" integer NOT NULL,
  "org_id" integer NOT NULL,
  "access" text NOT NULL DEFAULT 'view',
  "added_by" text NOT NULL DEFAULT '',
  "created_at" timestamp NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS "instruments" (
  "id" serial PRIMARY KEY NOT NULL,
  "external_id" text NOT NULL,
  "client" text NOT NULL,
  "model" text NOT NULL,
  "manufacturer" text NOT NULL DEFAULT '',
  "serial" text NOT NULL DEFAULT '',
  "location" text NOT NULL DEFAULT '',
  "priority" integer NOT NULL DEFAULT 99,
  "lead" text NOT NULL DEFAULT '',
  "archived" boolean NOT NULL DEFAULT false,
  "archived_at" timestamp,
  "archived_by" text NOT NULL DEFAULT '',
  "stages" text[] NOT NULL DEFAULT '{}',
  "notes" text NOT NULL DEFAULT '',
  "created_at" timestamp NOT NULL DEFAULT now(),
  "updated_at" timestamp NOT NULL DEFAULT now(),
  CONSTRAINT "instruments_external_id_unique" UNIQUE ("external_id")
);
CREATE TABLE IF NOT EXISTS "tasks" (
  "id" serial PRIMARY KEY NOT NULL,
  "instrument_id" integer NOT NULL,
  "title" text NOT NULL,
  "body" text NOT NULL DEFAULT '',
  "state" text NOT NULL DEFAULT 'Open',
  "assignee" text NOT NULL DEFAULT '',
  "due_date" text NOT NULL DEFAULT '',
  "sort_order" integer NOT NULL DEFAULT 0,
  "created_at" timestamp NOT NULL DEFAULT now(),
  "completed_at" timestamp
);
CREATE TABLE IF NOT EXISTS "checklist_items" (
  "id" serial PRIMARY KEY NOT NULL,
  "task_id" integer NOT NULL,
  "text" text NOT NULL,
  "done" boolean NOT NULL DEFAULT false,
  "sort_order" integer NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS "item_notes" (
  "id" serial PRIMARY KEY NOT NULL,
  "item_id" integer NOT NULL,
  "author" text NOT NULL,
  "text" text NOT NULL,
  "created_at" timestamp NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS "task_notes" (
  "id" serial PRIMARY KEY NOT NULL,
  "task_id" integer NOT NULL,
  "author" text NOT NULL,
  "text" text NOT NULL,
  "created_at" timestamp NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS "instrument_gases" (
  "id" serial PRIMARY KEY NOT NULL,
  "instrument_id" integer NOT NULL,
  "gas" text NOT NULL,
  "status" text NOT NULL DEFAULT 'Connected',
  "note" text NOT NULL DEFAULT '',
  "updated_at" timestamp NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS "parts" (
  "id" serial PRIMARY KEY NOT NULL,
  "instrument_id" integer NOT NULL,
  "kind" text NOT NULL DEFAULT 'part',
  "name" text NOT NULL,
  "part_number" text NOT NULL DEFAULT '',
  "serial" text NOT NULL DEFAULT '',
  "qty" text NOT NULL DEFAULT '',
  "specs" text NOT NULL DEFAULT '',
  "vendor" text NOT NULL DEFAULT '',
  "po" text NOT NULL DEFAULT '',
  "cost" text NOT NULL DEFAULT '',
  "carrier" text NOT NULL DEFAULT '',
  "tracking" text NOT NULL DEFAULT '',
  "ordered_at" text NOT NULL DEFAULT '',
  "eta" text NOT NULL DEFAULT '',
  "received_at" text NOT NULL DEFAULT '',
  "installed_at" text NOT NULL DEFAULT '',
  "removed_at" text NOT NULL DEFAULT '',
  "note" text NOT NULL DEFAULT '',
  "status" text NOT NULL DEFAULT 'Needed',
  "created_at" timestamp NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS "attachments" (
  "id" serial PRIMARY KEY NOT NULL,
  "org_id" integer,
  "instrument_id" integer NOT NULL,
  "file_name" text NOT NULL,
  "kind" text NOT NULL DEFAULT 'Other',
  "description" text NOT NULL DEFAULT '',
  "url" text NOT NULL,
  "size" integer NOT NULL DEFAULT 0,
  "uploaded_by" text NOT NULL,
  "created_at" timestamp NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS "audit_log" (
  "id" serial PRIMARY KEY NOT NULL,
  "actor" text NOT NULL,
  "instrument_id" integer,
  "entity_type" text NOT NULL,
  "entity_id" text NOT NULL DEFAULT '',
  "action" text NOT NULL,
  "field" text NOT NULL DEFAULT '',
  "old_value" text NOT NULL DEFAULT '',
  "new_value" text NOT NULL DEFAULT '',
  "created_at" timestamp NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS "sheet_diffs" (
  "id" serial PRIMARY KEY NOT NULL,
  "run_at" timestamp NOT NULL DEFAULT now(),
  "external_id" text NOT NULL,
  "field" text NOT NULL,
  "sheet_value" text NOT NULL DEFAULT '',
  "db_value" text NOT NULL DEFAULT '',
  "resolved" boolean NOT NULL DEFAULT false,
  "resolved_by" text NOT NULL DEFAULT '',
  "resolution" text NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS "app_settings" (
  "id" integer PRIMARY KEY DEFAULT 1,
  "client_access_enabled" boolean NOT NULL DEFAULT false,
  "client_can_edit" boolean NOT NULL DEFAULT false,
  "eod_recipients" text NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS "time_entries" (
  "id" serial PRIMARY KEY NOT NULL,
  "instrument_id" integer NOT NULL,
  "person" text NOT NULL DEFAULT '',
  "date" text NOT NULL,
  "minutes" integer NOT NULL DEFAULT 0,
  "note" text NOT NULL DEFAULT '',
  "logged_by" text NOT NULL DEFAULT '',
  "created_at" timestamp NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS "assets" (
  "id" serial PRIMARY KEY NOT NULL,
  "instrument_id" integer,
  "kind" text NOT NULL DEFAULT 'Other',
  "model" text NOT NULL DEFAULT '',
  "serial" text NOT NULL DEFAULT '',
  "manufacturer" text NOT NULL DEFAULT '',
  "status" text NOT NULL DEFAULT 'In service',
  "location" text NOT NULL DEFAULT '',
  "note" text NOT NULL DEFAULT '',
  "sort_order" integer NOT NULL DEFAULT 0,
  "created_at" timestamp NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS "asset_events" (
  "id" serial PRIMARY KEY NOT NULL,
  "asset_id" integer NOT NULL,
  "kind" text NOT NULL,
  "instrument_id" integer,
  "detail" text NOT NULL DEFAULT '',
  "actor" text NOT NULL DEFAULT '',
  "at" timestamp NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS "signoffs" (
  "id" serial PRIMARY KEY NOT NULL,
  "instrument_id" integer,
  "asset_id" integer,
  "signed_by" text NOT NULL,
  "signer_name" text NOT NULL,
  "signer_title" text NOT NULL DEFAULT '',
  "meaning" text NOT NULL DEFAULT 'Approved for release',
  "note" text NOT NULL DEFAULT '',
  "data" jsonb NOT NULL,
  "revoked_at" timestamp,
  "revoked_by" text NOT NULL DEFAULT '',
  "revoked_reason" text NOT NULL DEFAULT '',
  "created_at" timestamp NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS "discussion_posts" (
  "id" serial PRIMARY KEY NOT NULL,
  "instrument_id" integer,
  "author" text NOT NULL,
  "author_email" text NOT NULL DEFAULT '',
  "body" text NOT NULL,
  "created_at" timestamp NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS "discussion_reads" (
  "id" serial PRIMARY KEY NOT NULL,
  "user_email" text NOT NULL,
  "thread_id" integer NOT NULL,
  "last_seen_at" timestamp NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS "pm_templates" (
  "id" serial PRIMARY KEY NOT NULL,
  "asset_type" text NOT NULL,
  "title" text NOT NULL,
  "body" text NOT NULL DEFAULT '',
  "every_days" integer NOT NULL,
  "part_name" text NOT NULL DEFAULT '',
  "part_number" text NOT NULL DEFAULT '',
  "model_scope" text[] NOT NULL DEFAULT '{}',
  "created_at" timestamp NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS "procedures" (
  "id" serial PRIMARY KEY NOT NULL,
  "asset_type" text NOT NULL,
  "kind" text NOT NULL DEFAULT 'task',
  "name" text NOT NULL,
  "notes" text NOT NULL DEFAULT '',
  "position" integer NOT NULL DEFAULT 0,
  "result_type" text NOT NULL DEFAULT 'pass_fail',
  "target" text,
  "tolerance_pct" numeric,
  "requires_note" boolean NOT NULL DEFAULT false,
  "consumes_part" boolean NOT NULL DEFAULT false,
  "runs_at_intake" boolean NOT NULL DEFAULT false,
  "interval_days" integer,
  "parts" text NOT NULL DEFAULT '',
  "model_scope" text[] NOT NULL DEFAULT '{}',
  "created_at" timestamp NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS "pm_schedules" (
  "id" serial PRIMARY KEY NOT NULL,
  "instrument_id" integer,
  "asset_id" integer,
  "title" text NOT NULL,
  "body" text NOT NULL DEFAULT '',
  "assignee" text NOT NULL DEFAULT '',
  "every_days" integer NOT NULL,
  "next_due" text NOT NULL,
  "last_done" text NOT NULL DEFAULT '',
  "paused" boolean NOT NULL DEFAULT false,
  "part_name" text NOT NULL DEFAULT '',
  "part_number" text NOT NULL DEFAULT '',
  "template_id" integer,
  "created_by" text NOT NULL DEFAULT '',
  "created_at" timestamp NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS "people" (
  "id" serial PRIMARY KEY NOT NULL,
  "name" text NOT NULL,
  "email" text NOT NULL DEFAULT '',
  "org" text NOT NULL DEFAULT 'sierra'
);
CREATE TABLE IF NOT EXISTS "stage_events" (
  "id" serial PRIMARY KEY NOT NULL,
  "instrument_id" integer NOT NULL,
  "stage" text NOT NULL,
  "kind" text NOT NULL,
  "at" timestamp NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS "checkout_rules" (
  "id" serial PRIMARY KEY NOT NULL,
  "kind" text NOT NULL,
  "model_match" text NOT NULL DEFAULT '',
  "title" text NOT NULL,
  "criteria" text NOT NULL DEFAULT '',
  "sort_order" integer NOT NULL DEFAULT 0,
  "created_at" timestamp NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS "vocab_terms" (
  "id" serial PRIMARY KEY NOT NULL,
  "kind" text NOT NULL,
  "asset_type" text NOT NULL DEFAULT '',
  "name" text NOT NULL,
  "categories" text[] NOT NULL DEFAULT '{}',
  "created_at" timestamp NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS "stockrooms" (
  "id" serial PRIMARY KEY NOT NULL,
  "name" text NOT NULL,
  "kind" text NOT NULL DEFAULT 'shop',
  "org_id" integer,
  "keeper" text NOT NULL DEFAULT '',
  "location" text NOT NULL DEFAULT '',
  "note" text NOT NULL DEFAULT '',
  "archived" boolean NOT NULL DEFAULT false,
  "created_by" text NOT NULL DEFAULT '',
  "created_at" timestamp NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS "stockroom_shares" (
  "id" serial PRIMARY KEY NOT NULL,
  "stockroom_id" integer NOT NULL,
  "org_id" integer NOT NULL,
  "access" text NOT NULL DEFAULT 'view',
  "added_by" text NOT NULL DEFAULT '',
  "created_at" timestamp NOT NULL DEFAULT now(),
  CONSTRAINT "stockroom_share_unique" UNIQUE("stockroom_id","org_id")
);
CREATE TABLE IF NOT EXISTS "stock_items" (
  "id" serial PRIMARY KEY NOT NULL,
  "stockroom_id" integer NOT NULL,
  "part_number" text NOT NULL,
  "name" text NOT NULL DEFAULT '',
  "qty" integer NOT NULL DEFAULT 0,
  "min_qty" integer NOT NULL DEFAULT 0,
  "bin" text NOT NULL DEFAULT '',
  "unit_cost_cents" integer,
  "note" text NOT NULL DEFAULT '',
  "updated_at" timestamp NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS "stock_moves" (
  "id" serial PRIMARY KEY NOT NULL,
  "stockroom_id" integer NOT NULL,
  "part_number" text NOT NULL,
  "delta" integer NOT NULL,
  "kind" text NOT NULL,
  "counterparty_id" integer,
  "instrument_id" integer,
  "asset_id" integer,
  "part_id" integer,
  "reason" text NOT NULL DEFAULT '',
  "actor" text NOT NULL DEFAULT '',
  "at" timestamp NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS "ui_layouts" (
  "id" serial PRIMARY KEY NOT NULL,
  "email" text NOT NULL,
  "view_key" text NOT NULL,
  "data" jsonb NOT NULL,
  "updated_at" timestamp NOT NULL DEFAULT now(),
  CONSTRAINT "ui_layout_unique" UNIQUE("email","view_key")
);
CREATE TABLE IF NOT EXISTS "house_members" (
  "id" serial PRIMARY KEY NOT NULL,
  "email" text NOT NULL,
  "role" text NOT NULL DEFAULT 'staff',
  "name" text NOT NULL DEFAULT '',
  "added_by" text NOT NULL DEFAULT '',
  "created_at" timestamp NOT NULL DEFAULT now(),
  CONSTRAINT "house_member_email_unique" UNIQUE("email")
);
CREATE TABLE IF NOT EXISTS "queue_events" (
  "id" serial PRIMARY KEY NOT NULL,
  "instrument_id" integer NOT NULL,
  "from_org_id" integer,
  "to_org_id" integer,
  "from_name" text NOT NULL DEFAULT '',
  "to_name" text NOT NULL DEFAULT '',
  "reason" text NOT NULL DEFAULT '',
  "actor" text NOT NULL DEFAULT '',
  "at" timestamp NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS "custody_events" (
  "id" serial PRIMARY KEY NOT NULL,
  "instrument_id" integer,
  "asset_id" integer,
  "kind" text NOT NULL DEFAULT 'transfer',
  "from_org_id" integer,
  "to_org_id" integer,
  "from_name" text NOT NULL DEFAULT '',
  "to_name" text NOT NULL DEFAULT '',
  "note" text NOT NULL DEFAULT '',
  "actor" text NOT NULL DEFAULT '',
  "at" timestamp NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS "purchase_orders" (
  "id" serial PRIMARY KEY NOT NULL,
  "number" text NOT NULL,
  "vendor" text NOT NULL,
  "stockroom_id" integer,
  "org_id" integer,
  "status" text NOT NULL DEFAULT 'draft',
  "reference" text NOT NULL DEFAULT '',
  "note" text NOT NULL DEFAULT '',
  "expected_at" text NOT NULL DEFAULT '',
  "created_by" text NOT NULL DEFAULT '',
  "created_at" timestamp NOT NULL DEFAULT now(),
  "sent_at" timestamp,
  "closed_at" timestamp,
  "cancel_reason" text NOT NULL DEFAULT '',
  CONSTRAINT "po_number_unique" UNIQUE("number")
);
CREATE TABLE IF NOT EXISTS "po_lines" (
  "id" serial PRIMARY KEY NOT NULL,
  "po_id" integer NOT NULL,
  "part_number" text NOT NULL,
  "name" text NOT NULL DEFAULT '',
  "qty_ordered" integer NOT NULL DEFAULT 1,
  "qty_received" integer NOT NULL DEFAULT 0,
  "unit_cents" integer,
  "note" text NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS "notifications" (
  "id" serial PRIMARY KEY NOT NULL,
  "email" text NOT NULL,
  "kind" text NOT NULL,
  "title" text NOT NULL,
  "href" text NOT NULL DEFAULT '',
  "created_at" timestamp NOT NULL DEFAULT now(),
  "read_at" timestamp
);
-- Emails waiting for the burst they belong to to finish. Never load-bearing:
-- the inbox row is written first and this only defers the interruption, so
-- losing the whole table costs some emails and no facts. See src/lib/outbox.ts.
CREATE TABLE IF NOT EXISTS "email_outbox" (
  "id" serial PRIMARY KEY NOT NULL,
  "email" text NOT NULL,
  "kind" text NOT NULL,
  "title" text NOT NULL DEFAULT '',
  "href" text NOT NULL DEFAULT '',
  "subject" text NOT NULL DEFAULT '',
  "body" text NOT NULL DEFAULT '',
  "actor" text NOT NULL DEFAULT '',
  "context" text NOT NULL DEFAULT '',
  "item" text NOT NULL DEFAULT '',
  "send_after" timestamp NOT NULL,
  "send_by" timestamp NOT NULL,
  "sent_at" timestamp,
  "created_at" timestamp DEFAULT now() NOT NULL
);
CREATE INDEX IF NOT EXISTS "email_outbox_due_idx" ON "email_outbox" ("sent_at","send_after");
CREATE TABLE IF NOT EXISTS "notification_prefs" (
  "id" serial PRIMARY KEY NOT NULL,
  "email" text NOT NULL,
  "kind" text NOT NULL,
  "email_on" boolean NOT NULL DEFAULT true,
  CONSTRAINT "notification_prefs_unique" UNIQUE("email","kind")
);
-- One person's standing connection to an outside file store. The refresh token
-- is sealed with CLOUD_TOKEN_KEY (see src/lib/secretBox.ts), so this table on
-- its own opens nothing.
CREATE TABLE IF NOT EXISTS "cloud_connections" (
  "id" serial PRIMARY KEY NOT NULL,
  "tenant_org_id" integer,
  "email" text NOT NULL,
  "provider" text NOT NULL DEFAULT 'microsoft',
  "account_name" text NOT NULL DEFAULT '',
  "account_email" text NOT NULL DEFAULT '',
  "refresh_token" text NOT NULL DEFAULT '',
  "access_token" text NOT NULL DEFAULT '',
  "access_expires_at" timestamp,
  "scopes" text NOT NULL DEFAULT '',
  "connected_at" timestamp NOT NULL DEFAULT now(),
  "last_used_at" timestamp,
  "broken_reason" text NOT NULL DEFAULT '',
  CONSTRAINT "cloud_connection_unique" UNIQUE("email","provider")
);
CREATE TABLE IF NOT EXISTS "part_prices" (
  "id" serial PRIMARY KEY NOT NULL,
  "part_number" text NOT NULL,
  "vendor" text NOT NULL,
  "is_oem" boolean NOT NULL DEFAULT false,
  "price_cents" integer NOT NULL,
  "url" text NOT NULL DEFAULT '',
  "note" text NOT NULL DEFAULT '',
  "updated_by" text NOT NULL DEFAULT '',
  "updated_at" timestamp NOT NULL DEFAULT now(),
  "created_at" timestamp NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS "checkout_items" (
  "id" serial PRIMARY KEY NOT NULL,
  "asset_type" text NOT NULL,
  "kind" text NOT NULL DEFAULT 'test',
  "name" text NOT NULL,
  "position" integer NOT NULL DEFAULT 0,
  "result_type" text NOT NULL DEFAULT 'pass_fail',
  "target" text,
  "tolerance_pct" numeric,
  "requires_note" boolean NOT NULL DEFAULT false,
  "consumes_part" boolean NOT NULL DEFAULT false,
  "model_scope" text[] NOT NULL DEFAULT '{}',
  "created_at" timestamp NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS "task_templates" (
  "id" serial PRIMARY KEY NOT NULL,
  "name" text NOT NULL,
  "created_at" timestamp NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS "template_tasks" (
  "id" serial PRIMARY KEY NOT NULL,
  "template_id" integer NOT NULL,
  "title" text NOT NULL,
  "body" text NOT NULL DEFAULT '',
  "sort_order" integer NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS "template_items" (
  "id" serial PRIMARY KEY NOT NULL,
  "template_task_id" integer NOT NULL,
  "text" text NOT NULL,
  "sort_order" integer NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS "stage_defs" (
  "id" serial PRIMARY KEY NOT NULL,
  "name" text NOT NULL,
  "bg" text NOT NULL,
  "fg" text NOT NULL,
  "sort_order" integer NOT NULL DEFAULT 0,
  "builtin" boolean NOT NULL DEFAULT false
);
CREATE TABLE IF NOT EXISTS "client_allowlist" (
  "id" serial PRIMARY KEY NOT NULL,
  "entry" text NOT NULL,
  "added_by" text NOT NULL DEFAULT '',
  "created_at" timestamp NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS "asset_shares" (
  "id" serial PRIMARY KEY NOT NULL,
  "asset_id" integer NOT NULL,
  "org_id" integer NOT NULL,
  "access" text NOT NULL DEFAULT 'view',
  "added_by" text NOT NULL DEFAULT '',
  "created_at" timestamp NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS "remote_devices" (
  "id" serial PRIMARY KEY NOT NULL,
  "org_id" integer,
  "instrument_id" integer,
  "node_id" text NOT NULL DEFAULT '',
  "name" text NOT NULL DEFAULT '',
  "platform" text NOT NULL DEFAULT 'windows',
  "consent_override" boolean,
  "last_seen_at" timestamp,
  "enrolled_by" text NOT NULL DEFAULT '',
  "created_at" timestamp NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS "engagement_records" (
  "id" serial PRIMARY KEY NOT NULL,
  "instrument_id" integer,
  "org_id" integer NOT NULL,
  "kind" text NOT NULL DEFAULT 'revoked',
  "external_id" text NOT NULL DEFAULT '',
  "label" text NOT NULL DEFAULT '',
  "revoked_by" text NOT NULL DEFAULT '',
  "revoked_at" timestamp NOT NULL DEFAULT now(),
  "superseded_at" timestamp,
  "data" jsonb NOT NULL
);
CREATE TABLE IF NOT EXISTS "access_requests" (
  "id" serial PRIMARY KEY NOT NULL,
  "instrument_id" integer NOT NULL,
  "org_id" integer NOT NULL,
  "kind" text NOT NULL DEFAULT 'access',
  "requested_by" text NOT NULL DEFAULT '',
  "message" text NOT NULL DEFAULT '',
  "status" text NOT NULL DEFAULT 'pending',
  "decided_by" text NOT NULL DEFAULT '',
  "decided_at" timestamp,
  "created_at" timestamp NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS "eod_updates" (
  "id" serial PRIMARY KEY NOT NULL,
  "instrument_id" integer NOT NULL,
  "date" text NOT NULL,
  "owner_org_id" integer,
  "system_update" text NOT NULL DEFAULT '',
  "action_item" text NOT NULL DEFAULT '',
  "skipped" boolean NOT NULL DEFAULT false,
  "updated_by" text NOT NULL DEFAULT '',
  "updated_at" timestamp NOT NULL DEFAULT now()
);

-- ── Columns (heals existing tables that predate a column) ─────────────────
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "name" text;
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "email" text;
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "email_verified" timestamp;
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "image" text;
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "role" text NOT NULL DEFAULT 'client_viewer';
ALTER TABLE "instruments" ADD COLUMN IF NOT EXISTS "priority" integer NOT NULL DEFAULT 99;
ALTER TABLE "instruments" ADD COLUMN IF NOT EXISTS "category" text NOT NULL DEFAULT '';
ALTER TABLE "assets" ADD COLUMN IF NOT EXISTS "owner" text NOT NULL DEFAULT '';
ALTER TABLE "assets" ADD COLUMN IF NOT EXISTS "as_found" text NOT NULL DEFAULT '';
ALTER TABLE "assets" ADD COLUMN IF NOT EXISTS "owner_org_id" integer;
ALTER TABLE "client_allowlist" ADD COLUMN IF NOT EXISTS "org_id" integer;
ALTER TABLE "app_settings" ADD COLUMN IF NOT EXISTS "sheet_org_id" integer;
ALTER TABLE "attachments" ADD COLUMN IF NOT EXISTS "asset_id" integer;
ALTER TABLE "audit_log" ADD COLUMN IF NOT EXISTS "asset_id" integer;
ALTER TABLE "instrument_gases" ADD COLUMN IF NOT EXISTS "asset_id" integer;
ALTER TABLE "instruments" ADD COLUMN IF NOT EXISTS "lead" text NOT NULL DEFAULT '';
ALTER TABLE "instruments" ADD COLUMN IF NOT EXISTS "manufacturer" text NOT NULL DEFAULT '';
ALTER TABLE "instruments" ADD COLUMN IF NOT EXISTS "serial" text NOT NULL DEFAULT '';
ALTER TABLE "instruments" ADD COLUMN IF NOT EXISTS "location" text NOT NULL DEFAULT '';
ALTER TABLE "instruments" ADD COLUMN IF NOT EXISTS "archived" boolean NOT NULL DEFAULT false;
ALTER TABLE "instruments" ADD COLUMN IF NOT EXISTS "archived_at" timestamp;
ALTER TABLE "instruments" ADD COLUMN IF NOT EXISTS "archived_by" text NOT NULL DEFAULT '';
ALTER TABLE "instruments" ADD COLUMN IF NOT EXISTS "stages" text[] NOT NULL DEFAULT '{}';
ALTER TABLE "instruments" ADD COLUMN IF NOT EXISTS "notes" text NOT NULL DEFAULT '';
ALTER TABLE "instruments" ADD COLUMN IF NOT EXISTS "created_at" timestamp NOT NULL DEFAULT now();
ALTER TABLE "instruments" ADD COLUMN IF NOT EXISTS "updated_at" timestamp NOT NULL DEFAULT now();
ALTER TABLE "instrument_gases" ADD COLUMN IF NOT EXISTS "status" text NOT NULL DEFAULT 'Connected';
ALTER TABLE "instrument_gases" ADD COLUMN IF NOT EXISTS "note" text NOT NULL DEFAULT '';
ALTER TABLE "instrument_gases" ADD COLUMN IF NOT EXISTS "updated_at" timestamp NOT NULL DEFAULT now();
ALTER TABLE "attachments" ADD COLUMN IF NOT EXISTS "kind" text NOT NULL DEFAULT 'Other';
ALTER TABLE "attachments" ADD COLUMN IF NOT EXISTS "description" text NOT NULL DEFAULT '';
ALTER TABLE "attachments" ADD COLUMN IF NOT EXISTS "size" integer NOT NULL DEFAULT 0;
ALTER TABLE "parts" ADD COLUMN IF NOT EXISTS "serial" text NOT NULL DEFAULT '';
ALTER TABLE "parts" ADD COLUMN IF NOT EXISTS "installed_at" text NOT NULL DEFAULT '';
ALTER TABLE "parts" ADD COLUMN IF NOT EXISTS "removed_at" text NOT NULL DEFAULT '';
ALTER TABLE "parts" ADD COLUMN IF NOT EXISTS "note" text NOT NULL DEFAULT '';
ALTER TABLE "parts" ADD COLUMN IF NOT EXISTS "kind" text NOT NULL DEFAULT 'part';
ALTER TABLE "parts" ADD COLUMN IF NOT EXISTS "qty" text NOT NULL DEFAULT '';
ALTER TABLE "parts" ADD COLUMN IF NOT EXISTS "specs" text NOT NULL DEFAULT '';
ALTER TABLE "eod_updates" ADD COLUMN IF NOT EXISTS "skipped" boolean NOT NULL DEFAULT false;
ALTER TABLE "tasks" ADD COLUMN IF NOT EXISTS "due_date" text NOT NULL DEFAULT '';
ALTER TABLE "tasks" ADD COLUMN IF NOT EXISTS "asset_id" integer;
ALTER TABLE "tasks" ADD COLUMN IF NOT EXISTS "origin" text NOT NULL DEFAULT '';
ALTER TABLE "parts" ADD COLUMN IF NOT EXISTS "asset_id" integer;
ALTER TABLE "time_entries" ADD COLUMN IF NOT EXISTS "asset_id" integer;
ALTER TABLE "app_settings" ADD COLUMN IF NOT EXISTS "eod_recipients" text NOT NULL DEFAULT '';
ALTER TABLE "instruments" ADD COLUMN IF NOT EXISTS "owner_org_id" integer;
ALTER TABLE "access_requests" ADD COLUMN IF NOT EXISTS "kind" text NOT NULL DEFAULT 'access';
ALTER TABLE "orgs" ADD COLUMN IF NOT EXISTS "theme_color" text NOT NULL DEFAULT '';
ALTER TABLE "orgs" ADD COLUMN IF NOT EXISTS "eod_recipients" text NOT NULL DEFAULT '';
ALTER TABLE "eod_updates" ADD COLUMN IF NOT EXISTS "asset_id" integer;
ALTER TABLE "orgs" ADD COLUMN IF NOT EXISTS "logo_url" text NOT NULL DEFAULT '';
ALTER TABLE "instruments" ADD COLUMN IF NOT EXISTS "for_sale" boolean NOT NULL DEFAULT false;
ALTER TABLE "instruments" ADD COLUMN IF NOT EXISTS "sale_note" text NOT NULL DEFAULT '';
ALTER TABLE "instruments" ADD COLUMN IF NOT EXISTS "listing_token" text NOT NULL DEFAULT '';
ALTER TABLE "attachments" ADD COLUMN IF NOT EXISTS "show_on_listing" boolean NOT NULL DEFAULT false;
ALTER TABLE "client_allowlist" ADD COLUMN IF NOT EXISTS "can_edit" boolean NOT NULL DEFAULT false;
ALTER TABLE "app_settings" ADD COLUMN IF NOT EXISTS "sheet_sync_enabled" boolean NOT NULL DEFAULT false;
ALTER TABLE "app_settings" ADD COLUMN IF NOT EXISTS "eod_enabled" boolean NOT NULL DEFAULT false;
ALTER TABLE "app_settings" ADD COLUMN IF NOT EXISTS "digest_enabled" boolean NOT NULL DEFAULT false;
ALTER TABLE "assets" ADD COLUMN IF NOT EXISTS "for_sale" boolean NOT NULL DEFAULT false;
ALTER TABLE "assets" ADD COLUMN IF NOT EXISTS "sale_note" text NOT NULL DEFAULT '';
ALTER TABLE "assets" ADD COLUMN IF NOT EXISTS "listing_token" text NOT NULL DEFAULT '';
ALTER TABLE "app_settings" ADD COLUMN IF NOT EXISTS "platform_name" text NOT NULL DEFAULT '';
ALTER TABLE "app_settings" ADD COLUMN IF NOT EXISTS "platform_tagline" text NOT NULL DEFAULT '';
ALTER TABLE "app_settings" ADD COLUMN IF NOT EXISTS "operator_org_id" integer;
ALTER TABLE "discussion_posts" ADD COLUMN IF NOT EXISTS "author_org_id" integer;
ALTER TABLE "discussion_posts" ADD COLUMN IF NOT EXISTS "audience" text NOT NULL DEFAULT 'all';
ALTER TABLE "discussion_posts" ADD COLUMN IF NOT EXISTS "room_org_id" integer;
ALTER TABLE "discussion_posts" ADD COLUMN IF NOT EXISTS "tenant_org_id" integer;
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "onboarded_at" timestamp;
CREATE TABLE IF NOT EXISTS "service_visits" (
  "id" serial PRIMARY KEY NOT NULL,
  "tenant_org_id" integer,
  "instrument_id" integer,
  "asset_id" integer,
  "day" text NOT NULL,
  "title" text NOT NULL DEFAULT '',
  "named_by" text NOT NULL DEFAULT '',
  "created_at" timestamp NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "service_visits_instrument_idx" ON "service_visits" ("instrument_id");
CREATE INDEX IF NOT EXISTS "service_visits_asset_idx" ON "service_visits" ("asset_id");
ALTER TABLE "tasks" ADD COLUMN IF NOT EXISTS "pm_schedule_id" integer;
ALTER TABLE "pm_schedules" ADD COLUMN IF NOT EXISTS "part_name" text NOT NULL DEFAULT '';
ALTER TABLE "pm_schedules" ADD COLUMN IF NOT EXISTS "part_number" text NOT NULL DEFAULT '';
ALTER TABLE "pm_schedules" ADD COLUMN IF NOT EXISTS "template_id" integer;
ALTER TABLE "pm_schedules" ADD COLUMN IF NOT EXISTS "parts" text NOT NULL DEFAULT '';
ALTER TABLE "pm_schedules" ADD COLUMN IF NOT EXISTS "procedure_id" integer;
ALTER TABLE "procedures" ADD COLUMN IF NOT EXISTS "required" boolean NOT NULL DEFAULT false;
ALTER TABLE "tasks" ADD COLUMN IF NOT EXISTS "procedure_id" integer;
ALTER TABLE "attachments" ADD COLUMN IF NOT EXISTS "task_id" integer;
ALTER TABLE "instruments" ADD COLUMN IF NOT EXISTS "name" text NOT NULL DEFAULT '';
ALTER TABLE "vocab_terms" ADD COLUMN IF NOT EXISTS "manufacturer" text NOT NULL DEFAULT '';
ALTER TABLE "parts" ADD COLUMN IF NOT EXISTS "cost_cents" integer;
ALTER TABLE "vocab_terms" ADD COLUMN IF NOT EXISTS "categories" text[] NOT NULL DEFAULT '{}';
ALTER TABLE "parts" ADD COLUMN IF NOT EXISTS "owner_org_id" integer;
ALTER TABLE "instruments" ADD COLUMN IF NOT EXISTS "queue_org_id" integer;
ALTER TABLE "instruments" ADD COLUMN IF NOT EXISTS "queue_reason" text NOT NULL DEFAULT '';
ALTER TABLE "instruments" ADD COLUMN IF NOT EXISTS "queue_since" timestamp;
ALTER TABLE "engagement_records" ADD COLUMN IF NOT EXISTS "kind" text NOT NULL DEFAULT 'revoked';
ALTER TABLE "engagement_records" ADD COLUMN IF NOT EXISTS "superseded_at" timestamp;
ALTER TABLE "eod_updates" ADD COLUMN IF NOT EXISTS "owner_org_id" integer;
ALTER TABLE "attachments" ADD COLUMN IF NOT EXISTS "org_id" integer;
ALTER TABLE "orgs" ADD COLUMN IF NOT EXISTS "storage_limit_mb" integer NOT NULL DEFAULT 5120;
ALTER TABLE "app_settings" ADD COLUMN IF NOT EXISTS "remote_enabled" boolean NOT NULL DEFAULT false;
ALTER TABLE "orgs" ADD COLUMN IF NOT EXISTS "remote_access_enabled" boolean NOT NULL DEFAULT false;
ALTER TABLE "orgs" ADD COLUMN IF NOT EXISTS "remote_group_id" text NOT NULL DEFAULT '';

-- Many operators on one instance: the org tree, per-operator staff, and the
-- tenant stamp every top-level record carries. See src/lib/tenants.ts.
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "view_mode" text NOT NULL DEFAULT '';
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "view_tour_at" timestamp;
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "password_hash" text NOT NULL DEFAULT '';
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "password_set_at" timestamp;
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "phone" text NOT NULL DEFAULT '';
ALTER TABLE "instruments" ADD COLUMN IF NOT EXISTS "photo_attachment_id" integer;
ALTER TABLE "assets" ADD COLUMN IF NOT EXISTS "photo_attachment_id" integer;
ALTER TABLE "attachments" ADD COLUMN IF NOT EXISTS "framing" text NOT NULL DEFAULT '';
-- Stock photos on the catalog itself: what a model, a module type or a system
-- type looks like. Not attachments, so they never reach a client's files,
-- gallery or storage bill - see src/lib/photos.ts.
-- What a person calls a lab PC, kept apart from the hostname the engine
-- overwrites on every reconcile. See src/lib/deviceName.ts.
ALTER TABLE "remote_devices" ADD COLUMN IF NOT EXISTS "nickname" text NOT NULL DEFAULT '';
ALTER TABLE "vocab_terms" ADD COLUMN IF NOT EXISTS "photo_url" text NOT NULL DEFAULT '';
ALTER TABLE "vocab_terms" ADD COLUMN IF NOT EXISTS "photo_framing" text NOT NULL DEFAULT '';
ALTER TABLE "orgs" ADD COLUMN IF NOT EXISTS "is_operator" boolean NOT NULL DEFAULT false;
ALTER TABLE "orgs" ADD COLUMN IF NOT EXISTS "parent_org_id" integer;
ALTER TABLE "house_members" ADD COLUMN IF NOT EXISTS "org_id" integer;
ALTER TABLE "instruments" ADD COLUMN IF NOT EXISTS "tenant_org_id" integer;
ALTER TABLE "assets" ADD COLUMN IF NOT EXISTS "tenant_org_id" integer;
ALTER TABLE "tasks" ADD COLUMN IF NOT EXISTS "tenant_org_id" integer;
ALTER TABLE "pm_schedules" ADD COLUMN IF NOT EXISTS "tenant_org_id" integer;
ALTER TABLE "time_entries" ADD COLUMN IF NOT EXISTS "tenant_org_id" integer;
ALTER TABLE "attachments" ADD COLUMN IF NOT EXISTS "tenant_org_id" integer;
ALTER TABLE "procedures" ADD COLUMN IF NOT EXISTS "tenant_org_id" integer;
ALTER TABLE "vocab_terms" ADD COLUMN IF NOT EXISTS "tenant_org_id" integer;
ALTER TABLE "stage_defs" ADD COLUMN IF NOT EXISTS "tenant_org_id" integer;
ALTER TABLE "people" ADD COLUMN IF NOT EXISTS "tenant_org_id" integer;
ALTER TABLE "stockrooms" ADD COLUMN IF NOT EXISTS "tenant_org_id" integer;
ALTER TABLE "purchase_orders" ADD COLUMN IF NOT EXISTS "tenant_org_id" integer;
ALTER TABLE "part_prices" ADD COLUMN IF NOT EXISTS "tenant_org_id" integer;
ALTER TABLE "eod_updates" ADD COLUMN IF NOT EXISTS "tenant_org_id" integer;
ALTER TABLE "remote_devices" ADD COLUMN IF NOT EXISTS "tenant_org_id" integer;
ALTER TABLE "audit_log" ADD COLUMN IF NOT EXISTS "tenant_org_id" integer;

-- Tenancy foreign keys. Cascade means offboarding an operator takes its work
-- with it; the audit log is set null so history outlives the account.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'service_visits_instrument_id_fk') THEN
    ALTER TABLE "service_visits" ADD CONSTRAINT "service_visits_instrument_id_fk"
      FOREIGN KEY ("instrument_id") REFERENCES "instruments"("id") ON DELETE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'service_visits_asset_id_fk') THEN
    ALTER TABLE "service_visits" ADD CONSTRAINT "service_visits_asset_id_fk"
      FOREIGN KEY ("asset_id") REFERENCES "assets"("id") ON DELETE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'service_visits_tenant_org_id_orgs_id_fk') THEN
    ALTER TABLE "service_visits" ADD CONSTRAINT "service_visits_tenant_org_id_orgs_id_fk"
      FOREIGN KEY ("tenant_org_id") REFERENCES "orgs"("id") ON DELETE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'orgs_parent_org_id_orgs_id_fk') THEN
    ALTER TABLE "orgs" ADD CONSTRAINT "orgs_parent_org_id_orgs_id_fk"
      FOREIGN KEY ("parent_org_id") REFERENCES "orgs"("id") ON DELETE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'house_members_org_id_orgs_id_fk') THEN
    ALTER TABLE "house_members" ADD CONSTRAINT "house_members_org_id_orgs_id_fk"
      FOREIGN KEY ("org_id") REFERENCES "orgs"("id") ON DELETE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'instruments_tenant_org_id_orgs_id_fk') THEN
    ALTER TABLE "instruments" ADD CONSTRAINT "instruments_tenant_org_id_orgs_id_fk"
      FOREIGN KEY ("tenant_org_id") REFERENCES "orgs"("id") ON DELETE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'assets_tenant_org_id_orgs_id_fk') THEN
    ALTER TABLE "assets" ADD CONSTRAINT "assets_tenant_org_id_orgs_id_fk"
      FOREIGN KEY ("tenant_org_id") REFERENCES "orgs"("id") ON DELETE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tasks_tenant_org_id_orgs_id_fk') THEN
    ALTER TABLE "tasks" ADD CONSTRAINT "tasks_tenant_org_id_orgs_id_fk"
      FOREIGN KEY ("tenant_org_id") REFERENCES "orgs"("id") ON DELETE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'pm_schedules_tenant_org_id_orgs_id_fk') THEN
    ALTER TABLE "pm_schedules" ADD CONSTRAINT "pm_schedules_tenant_org_id_orgs_id_fk"
      FOREIGN KEY ("tenant_org_id") REFERENCES "orgs"("id") ON DELETE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'time_entries_tenant_org_id_orgs_id_fk') THEN
    ALTER TABLE "time_entries" ADD CONSTRAINT "time_entries_tenant_org_id_orgs_id_fk"
      FOREIGN KEY ("tenant_org_id") REFERENCES "orgs"("id") ON DELETE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'attachments_tenant_org_id_orgs_id_fk') THEN
    ALTER TABLE "attachments" ADD CONSTRAINT "attachments_tenant_org_id_orgs_id_fk"
      FOREIGN KEY ("tenant_org_id") REFERENCES "orgs"("id") ON DELETE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'procedures_tenant_org_id_orgs_id_fk') THEN
    ALTER TABLE "procedures" ADD CONSTRAINT "procedures_tenant_org_id_orgs_id_fk"
      FOREIGN KEY ("tenant_org_id") REFERENCES "orgs"("id") ON DELETE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'vocab_terms_tenant_org_id_orgs_id_fk') THEN
    ALTER TABLE "vocab_terms" ADD CONSTRAINT "vocab_terms_tenant_org_id_orgs_id_fk"
      FOREIGN KEY ("tenant_org_id") REFERENCES "orgs"("id") ON DELETE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'stage_defs_tenant_org_id_orgs_id_fk') THEN
    ALTER TABLE "stage_defs" ADD CONSTRAINT "stage_defs_tenant_org_id_orgs_id_fk"
      FOREIGN KEY ("tenant_org_id") REFERENCES "orgs"("id") ON DELETE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'people_tenant_org_id_orgs_id_fk') THEN
    ALTER TABLE "people" ADD CONSTRAINT "people_tenant_org_id_orgs_id_fk"
      FOREIGN KEY ("tenant_org_id") REFERENCES "orgs"("id") ON DELETE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'stockrooms_tenant_org_id_orgs_id_fk') THEN
    ALTER TABLE "stockrooms" ADD CONSTRAINT "stockrooms_tenant_org_id_orgs_id_fk"
      FOREIGN KEY ("tenant_org_id") REFERENCES "orgs"("id") ON DELETE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'purchase_orders_tenant_org_id_orgs_id_fk') THEN
    ALTER TABLE "purchase_orders" ADD CONSTRAINT "purchase_orders_tenant_org_id_orgs_id_fk"
      FOREIGN KEY ("tenant_org_id") REFERENCES "orgs"("id") ON DELETE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'part_prices_tenant_org_id_orgs_id_fk') THEN
    ALTER TABLE "part_prices" ADD CONSTRAINT "part_prices_tenant_org_id_orgs_id_fk"
      FOREIGN KEY ("tenant_org_id") REFERENCES "orgs"("id") ON DELETE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'eod_updates_tenant_org_id_orgs_id_fk') THEN
    ALTER TABLE "eod_updates" ADD CONSTRAINT "eod_updates_tenant_org_id_orgs_id_fk"
      FOREIGN KEY ("tenant_org_id") REFERENCES "orgs"("id") ON DELETE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'remote_devices_tenant_org_id_orgs_id_fk') THEN
    ALTER TABLE "remote_devices" ADD CONSTRAINT "remote_devices_tenant_org_id_orgs_id_fk"
      FOREIGN KEY ("tenant_org_id") REFERENCES "orgs"("id") ON DELETE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'cloud_connections_tenant_org_id_orgs_id_fk') THEN
    ALTER TABLE "cloud_connections" ADD CONSTRAINT "cloud_connections_tenant_org_id_orgs_id_fk"
      FOREIGN KEY ("tenant_org_id") REFERENCES "orgs"("id") ON DELETE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'audit_log_tenant_org_id_orgs_id_fk') THEN
    ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_tenant_org_id_orgs_id_fk"
      FOREIGN KEY ("tenant_org_id") REFERENCES "orgs"("id") ON DELETE SET NULL;
  END IF;
END $$;

-- A photo is an attachment; deleting the file clears the pointer to it.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'instruments_photo_attachment_id_fk') THEN
    ALTER TABLE "instruments" ADD CONSTRAINT "instruments_photo_attachment_id_fk"
      FOREIGN KEY ("photo_attachment_id") REFERENCES "attachments"("id") ON DELETE SET NULL;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'assets_photo_attachment_id_fk') THEN
    ALTER TABLE "assets" ADD CONSTRAINT "assets_photo_attachment_id_fk"
      FOREIGN KEY ("photo_attachment_id") REFERENCES "attachments"("id") ON DELETE SET NULL;
  END IF;
END $$;

-- ── Indexes ───────────────────────────────────────────────────────────────

-- Every tenant-scoped list starts with this filter.
CREATE INDEX IF NOT EXISTS "instruments_tenant_idx" ON "instruments" ("tenant_org_id");
CREATE INDEX IF NOT EXISTS "assets_tenant_idx" ON "assets" ("tenant_org_id");
CREATE INDEX IF NOT EXISTS "tasks_tenant_idx" ON "tasks" ("tenant_org_id");
CREATE INDEX IF NOT EXISTS "pm_schedules_tenant_idx" ON "pm_schedules" ("tenant_org_id");
CREATE INDEX IF NOT EXISTS "time_entries_tenant_idx" ON "time_entries" ("tenant_org_id");
CREATE INDEX IF NOT EXISTS "attachments_tenant_idx" ON "attachments" ("tenant_org_id");
CREATE INDEX IF NOT EXISTS "procedures_tenant_idx" ON "procedures" ("tenant_org_id");
CREATE INDEX IF NOT EXISTS "vocab_terms_tenant_idx" ON "vocab_terms" ("tenant_org_id");
CREATE INDEX IF NOT EXISTS "stockrooms_tenant_idx" ON "stockrooms" ("tenant_org_id");
CREATE INDEX IF NOT EXISTS "purchase_orders_tenant_idx" ON "purchase_orders" ("tenant_org_id");
CREATE INDEX IF NOT EXISTS "part_prices_tenant_idx" ON "part_prices" ("tenant_org_id");
CREATE INDEX IF NOT EXISTS "eod_updates_tenant_idx" ON "eod_updates" ("tenant_org_id");
CREATE INDEX IF NOT EXISTS "audit_log_tenant_idx" ON "audit_log" ("tenant_org_id");
CREATE INDEX IF NOT EXISTS "orgs_parent_idx" ON "orgs" ("parent_org_id");
CREATE INDEX IF NOT EXISTS "house_members_org_idx" ON "house_members" ("org_id");
CREATE INDEX IF NOT EXISTS "tasks_instrument_idx" ON "tasks" ("instrument_id");
CREATE INDEX IF NOT EXISTS "checklist_task_idx" ON "checklist_items" ("task_id");
CREATE INDEX IF NOT EXISTS "item_notes_item_idx" ON "item_notes" ("item_id");
CREATE INDEX IF NOT EXISTS "task_notes_task_idx" ON "task_notes" ("task_id");
CREATE INDEX IF NOT EXISTS "gases_instrument_idx" ON "instrument_gases" ("instrument_id");
CREATE INDEX IF NOT EXISTS "parts_instrument_idx" ON "parts" ("instrument_id");
CREATE INDEX IF NOT EXISTS "attachments_instrument_idx" ON "attachments" ("instrument_id");
CREATE INDEX IF NOT EXISTS "audit_instrument_idx" ON "audit_log" ("instrument_id");
CREATE INDEX IF NOT EXISTS "audit_created_idx" ON "audit_log" ("created_at");
CREATE INDEX IF NOT EXISTS "diffs_resolved_idx" ON "sheet_diffs" ("resolved");
CREATE INDEX IF NOT EXISTS "eod_date_idx" ON "eod_updates" ("date");
CREATE INDEX IF NOT EXISTS "template_tasks_template_idx" ON "template_tasks" ("template_id");
CREATE INDEX IF NOT EXISTS "stage_events_instrument_idx" ON "stage_events" ("instrument_id");
CREATE INDEX IF NOT EXISTS "signoffs_instrument_idx" ON "signoffs" ("instrument_id");
CREATE INDEX IF NOT EXISTS "signoffs_asset_idx" ON "signoffs" ("asset_id");
CREATE INDEX IF NOT EXISTS "pm_instrument_idx" ON "pm_schedules" ("instrument_id");
CREATE INDEX IF NOT EXISTS "pm_asset_idx" ON "pm_schedules" ("asset_id");
CREATE INDEX IF NOT EXISTS "time_instrument_idx" ON "time_entries" ("instrument_id");
CREATE INDEX IF NOT EXISTS "assets_instrument_idx" ON "assets" ("instrument_id");
CREATE INDEX IF NOT EXISTS "asset_events_asset_idx" ON "asset_events" ("asset_id");
CREATE INDEX IF NOT EXISTS "discussion_instrument_idx" ON "discussion_posts" ("instrument_id");
CREATE INDEX IF NOT EXISTS "discussion_created_idx" ON "discussion_posts" ("created_at");
CREATE INDEX IF NOT EXISTS "template_items_task_idx" ON "template_items" ("template_task_id");

CREATE INDEX IF NOT EXISTS "notifications_email_idx" ON "notifications" ("email");
CREATE INDEX IF NOT EXISTS "queue_events_instrument_idx" ON "queue_events" ("instrument_id");
CREATE INDEX IF NOT EXISTS "queue_events_at_idx" ON "queue_events" ("at");
CREATE INDEX IF NOT EXISTS "custody_instrument_idx" ON "custody_events" ("instrument_id");
CREATE INDEX IF NOT EXISTS "custody_asset_idx" ON "custody_events" ("asset_id");
CREATE INDEX IF NOT EXISTS "po_status_idx" ON "purchase_orders" ("status");
CREATE INDEX IF NOT EXISTS "po_lines_po_idx" ON "po_lines" ("po_id");
CREATE INDEX IF NOT EXISTS "stockrooms_org_idx" ON "stockrooms" ("org_id");
CREATE INDEX IF NOT EXISTS "stockroom_shares_org_idx" ON "stockroom_shares" ("org_id");
CREATE INDEX IF NOT EXISTS "stock_items_room_idx" ON "stock_items" ("stockroom_id");
CREATE INDEX IF NOT EXISTS "stock_moves_room_idx" ON "stock_moves" ("stockroom_id");
CREATE INDEX IF NOT EXISTS "stock_moves_at_idx" ON "stock_moves" ("at");
-- One on-hand line per part number per room, however it was capitalized. Same
-- reasoning (and same ORM limitation) as part_prices_pn_vendor.
CREATE UNIQUE INDEX IF NOT EXISTS "stock_items_room_pn" ON "stock_items" ("stockroom_id", lower("part_number"));
-- One price per (PN, vendor) pair regardless of how either was capitalized.
-- Lives here alone: drizzle's pgTable can't declare expression indexes, so the
-- app enforces the same rule with a select-then-write (see addPartPrices) and
-- this index backstops races.
CREATE UNIQUE INDEX IF NOT EXISTS "part_prices_pn_vendor" ON "part_prices" (lower("part_number"), lower("vendor"));
CREATE INDEX IF NOT EXISTS "system_shares_org_idx" ON "system_shares" ("org_id");
CREATE INDEX IF NOT EXISTS "engagement_records_org_idx" ON "engagement_records" ("org_id");
CREATE INDEX IF NOT EXISTS "cloud_connections_email_idx" ON "cloud_connections" ("email");
CREATE INDEX IF NOT EXISTS "remote_devices_org_idx" ON "remote_devices" ("org_id");
CREATE INDEX IF NOT EXISTS "remote_devices_instrument_idx" ON "remote_devices" ("instrument_id");
CREATE INDEX IF NOT EXISTS "asset_shares_org_idx" ON "asset_shares" ("org_id");
CREATE INDEX IF NOT EXISTS "access_requests_instrument_idx" ON "access_requests" ("instrument_id");

-- ── Optional owners (widening only; no data is touched) ───────────────────
-- Tasks, parts, files and gases can belong to a standalone asset - a spare
-- being refurbished on the bench - so their instrument_id is optional. DROP
-- NOT NULL only ever accepts more rows than before, and each is guarded so a
-- re-run is a no-op.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['tasks','parts','attachments','instrument_gases','eod_updates','time_entries'] LOOP
    IF EXISTS (SELECT 1 FROM information_schema.columns
               WHERE table_schema = 'public' AND table_name = t
                 AND column_name = 'instrument_id' AND is_nullable = 'NO') THEN
      EXECUTE format('ALTER TABLE %I ALTER COLUMN "instrument_id" DROP NOT NULL', t);
    END IF;
  END LOOP;
END $$;

-- ── Unique constraints ────────────────────────────────────────────────────
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'gases_instrument_gas') THEN
    ALTER TABLE "instrument_gases" ADD CONSTRAINT "gases_instrument_gas" UNIQUE ("instrument_id","gas");
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'eod_instrument_date') THEN
    ALTER TABLE "eod_updates" ADD CONSTRAINT "eod_instrument_date" UNIQUE ("instrument_id","date");
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'eod_asset_date') THEN
    ALTER TABLE "eod_updates" ADD CONSTRAINT "eod_asset_date" UNIQUE ("asset_id","date");
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'allowlist_entry_unique') THEN
    ALTER TABLE "client_allowlist" ADD CONSTRAINT "allowlist_entry_unique" UNIQUE ("entry");
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'stage_defs_name_unique') THEN
    ALTER TABLE "stage_defs" ADD CONSTRAINT "stage_defs_name_unique" UNIQUE ("name");
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'org_name_unique') THEN
    ALTER TABLE "orgs" ADD CONSTRAINT "org_name_unique" UNIQUE ("name");
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'system_share_unique') THEN
    ALTER TABLE "system_shares" ADD CONSTRAINT "system_share_unique" UNIQUE ("instrument_id","org_id");
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'asset_share_unique') THEN
    ALTER TABLE "asset_shares" ADD CONSTRAINT "asset_share_unique" UNIQUE ("asset_id","org_id");
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'vocab_term_unique') THEN
    ALTER TABLE "vocab_terms" ADD CONSTRAINT "vocab_term_unique" UNIQUE ("kind","asset_type","name");
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'checkout_rule_unique') THEN
    ALTER TABLE "checkout_rules" ADD CONSTRAINT "checkout_rule_unique" UNIQUE ("kind","model_match","title");
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'task_templates_name_unique') THEN
    ALTER TABLE "task_templates" ADD CONSTRAINT "task_templates_name_unique" UNIQUE ("name");
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'discussion_reads_user_thread') THEN
    ALTER TABLE "discussion_reads" ADD CONSTRAINT "discussion_reads_user_thread" UNIQUE ("user_email","thread_id");
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'remote_device_node_unique') THEN
    ALTER TABLE "remote_devices" ADD CONSTRAINT "remote_device_node_unique" UNIQUE ("node_id");
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'people_name_unique') THEN
    ALTER TABLE "people" ADD CONSTRAINT "people_name_unique" UNIQUE ("name");
  END IF;
END $$;

-- ── Foreign keys (guarded; ON DELETE CASCADE per schema.ts) ───────────────
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'accounts_user_id_users_id_fk') THEN
    ALTER TABLE "accounts" ADD CONSTRAINT "accounts_user_id_users_id_fk"
      FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'sessions_user_id_users_id_fk') THEN
    ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk"
      FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tasks_instrument_id_instruments_id_fk') THEN
    ALTER TABLE "tasks" ADD CONSTRAINT "tasks_instrument_id_instruments_id_fk"
      FOREIGN KEY ("instrument_id") REFERENCES "instruments"("id") ON DELETE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'checklist_items_task_id_tasks_id_fk') THEN
    ALTER TABLE "checklist_items" ADD CONSTRAINT "checklist_items_task_id_tasks_id_fk"
      FOREIGN KEY ("task_id") REFERENCES "tasks"("id") ON DELETE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'item_notes_item_id_checklist_items_id_fk') THEN
    ALTER TABLE "item_notes" ADD CONSTRAINT "item_notes_item_id_checklist_items_id_fk"
      FOREIGN KEY ("item_id") REFERENCES "checklist_items"("id") ON DELETE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'task_notes_task_id_tasks_id_fk') THEN
    ALTER TABLE "task_notes" ADD CONSTRAINT "task_notes_task_id_tasks_id_fk"
      FOREIGN KEY ("task_id") REFERENCES "tasks"("id") ON DELETE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'instrument_gases_instrument_id_instruments_id_fk') THEN
    ALTER TABLE "instrument_gases" ADD CONSTRAINT "instrument_gases_instrument_id_instruments_id_fk"
      FOREIGN KEY ("instrument_id") REFERENCES "instruments"("id") ON DELETE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'parts_instrument_id_instruments_id_fk') THEN
    ALTER TABLE "parts" ADD CONSTRAINT "parts_instrument_id_instruments_id_fk"
      FOREIGN KEY ("instrument_id") REFERENCES "instruments"("id") ON DELETE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'attachments_instrument_id_instruments_id_fk') THEN
    ALTER TABLE "attachments" ADD CONSTRAINT "attachments_instrument_id_instruments_id_fk"
      FOREIGN KEY ("instrument_id") REFERENCES "instruments"("id") ON DELETE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'eod_updates_instrument_id_instruments_id_fk') THEN
    ALTER TABLE "eod_updates" ADD CONSTRAINT "eod_updates_instrument_id_instruments_id_fk"
      FOREIGN KEY ("instrument_id") REFERENCES "instruments"("id") ON DELETE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'time_entries_instrument_id_instruments_id_fk') THEN
    ALTER TABLE "time_entries" ADD CONSTRAINT "time_entries_instrument_id_instruments_id_fk"
      FOREIGN KEY ("instrument_id") REFERENCES "instruments"("id") ON DELETE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'assets_instrument_id_instruments_id_fk') THEN
    ALTER TABLE "assets" ADD CONSTRAINT "assets_instrument_id_instruments_id_fk"
      FOREIGN KEY ("instrument_id") REFERENCES "instruments"("id") ON DELETE SET NULL;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'asset_events_asset_id_assets_id_fk') THEN
    ALTER TABLE "asset_events" ADD CONSTRAINT "asset_events_asset_id_assets_id_fk"
      FOREIGN KEY ("asset_id") REFERENCES "assets"("id") ON DELETE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tasks_asset_id_assets_id_fk') THEN
    ALTER TABLE "tasks" ADD CONSTRAINT "tasks_asset_id_assets_id_fk"
      FOREIGN KEY ("asset_id") REFERENCES "assets"("id") ON DELETE SET NULL;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'parts_asset_id_assets_id_fk') THEN
    ALTER TABLE "parts" ADD CONSTRAINT "parts_asset_id_assets_id_fk"
      FOREIGN KEY ("asset_id") REFERENCES "assets"("id") ON DELETE SET NULL;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'time_entries_asset_id_assets_id_fk') THEN
    ALTER TABLE "time_entries" ADD CONSTRAINT "time_entries_asset_id_assets_id_fk"
      FOREIGN KEY ("asset_id") REFERENCES "assets"("id") ON DELETE SET NULL;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'discussion_posts_instrument_id_instruments_id_fk') THEN
    ALTER TABLE "discussion_posts" ADD CONSTRAINT "discussion_posts_instrument_id_instruments_id_fk"
      FOREIGN KEY ("instrument_id") REFERENCES "instruments"("id") ON DELETE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'pm_schedules_instrument_id_instruments_id_fk') THEN
    ALTER TABLE "pm_schedules" ADD CONSTRAINT "pm_schedules_instrument_id_instruments_id_fk"
      FOREIGN KEY ("instrument_id") REFERENCES "instruments"("id") ON DELETE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'pm_schedules_asset_id_assets_id_fk') THEN
    ALTER TABLE "pm_schedules" ADD CONSTRAINT "pm_schedules_asset_id_assets_id_fk"
      FOREIGN KEY ("asset_id") REFERENCES "assets"("id") ON DELETE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tasks_procedure_id_procedures_id_fk') THEN
    ALTER TABLE "tasks" ADD CONSTRAINT "tasks_procedure_id_procedures_id_fk"
      FOREIGN KEY ("procedure_id") REFERENCES "procedures"("id") ON DELETE SET NULL;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'attachments_task_id_tasks_id_fk') THEN
    ALTER TABLE "attachments" ADD CONSTRAINT "attachments_task_id_tasks_id_fk"
      FOREIGN KEY ("task_id") REFERENCES "tasks"("id") ON DELETE SET NULL;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'remote_devices_org_id_orgs_id_fk') THEN
    ALTER TABLE "remote_devices" ADD CONSTRAINT "remote_devices_org_id_orgs_id_fk"
      FOREIGN KEY ("org_id") REFERENCES "orgs"("id") ON DELETE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'remote_devices_instrument_id_instruments_id_fk') THEN
    ALTER TABLE "remote_devices" ADD CONSTRAINT "remote_devices_instrument_id_instruments_id_fk"
      FOREIGN KEY ("instrument_id") REFERENCES "instruments"("id") ON DELETE SET NULL;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'attachments_org_id_orgs_id_fk') THEN
    ALTER TABLE "attachments" ADD CONSTRAINT "attachments_org_id_orgs_id_fk"
      FOREIGN KEY ("org_id") REFERENCES "orgs"("id") ON DELETE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'signoffs_instrument_id_instruments_id_fk') THEN
    ALTER TABLE "signoffs" ADD CONSTRAINT "signoffs_instrument_id_instruments_id_fk"
      FOREIGN KEY ("instrument_id") REFERENCES "instruments"("id") ON DELETE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'signoffs_asset_id_assets_id_fk') THEN
    ALTER TABLE "signoffs" ADD CONSTRAINT "signoffs_asset_id_assets_id_fk"
      FOREIGN KEY ("asset_id") REFERENCES "assets"("id") ON DELETE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'pm_schedules_procedure_id_procedures_id_fk') THEN
    ALTER TABLE "pm_schedules" ADD CONSTRAINT "pm_schedules_procedure_id_procedures_id_fk"
      FOREIGN KEY ("procedure_id") REFERENCES "procedures"("id") ON DELETE SET NULL;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'pm_schedules_template_id_pm_templates_id_fk') THEN
    ALTER TABLE "pm_schedules" ADD CONSTRAINT "pm_schedules_template_id_pm_templates_id_fk"
      FOREIGN KEY ("template_id") REFERENCES "pm_templates"("id") ON DELETE SET NULL;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tasks_pm_schedule_id_pm_schedules_id_fk') THEN
    ALTER TABLE "tasks" ADD CONSTRAINT "tasks_pm_schedule_id_pm_schedules_id_fk"
      FOREIGN KEY ("pm_schedule_id") REFERENCES "pm_schedules"("id") ON DELETE SET NULL;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'discussion_posts_author_org_id_orgs_id_fk') THEN
    ALTER TABLE "discussion_posts" ADD CONSTRAINT "discussion_posts_author_org_id_orgs_id_fk"
      FOREIGN KEY ("author_org_id") REFERENCES "orgs"("id") ON DELETE SET NULL;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'discussion_posts_room_org_id_orgs_id_fk') THEN
    ALTER TABLE "discussion_posts" ADD CONSTRAINT "discussion_posts_room_org_id_orgs_id_fk"
      FOREIGN KEY ("room_org_id") REFERENCES "orgs"("id") ON DELETE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'stage_events_instrument_id_instruments_id_fk') THEN
    ALTER TABLE "stage_events" ADD CONSTRAINT "stage_events_instrument_id_instruments_id_fk"
      FOREIGN KEY ("instrument_id") REFERENCES "instruments"("id") ON DELETE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'template_tasks_template_id_task_templates_id_fk') THEN
    ALTER TABLE "template_tasks" ADD CONSTRAINT "template_tasks_template_id_task_templates_id_fk"
      FOREIGN KEY ("template_id") REFERENCES "task_templates"("id") ON DELETE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'system_shares_instrument_id_instruments_id_fk') THEN
    ALTER TABLE "system_shares" ADD CONSTRAINT "system_shares_instrument_id_instruments_id_fk"
      FOREIGN KEY ("instrument_id") REFERENCES "instruments"("id") ON DELETE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'system_shares_org_id_orgs_id_fk') THEN
    ALTER TABLE "system_shares" ADD CONSTRAINT "system_shares_org_id_orgs_id_fk"
      FOREIGN KEY ("org_id") REFERENCES "orgs"("id") ON DELETE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'assets_owner_org_id_orgs_id_fk') THEN
    ALTER TABLE "assets" ADD CONSTRAINT "assets_owner_org_id_orgs_id_fk"
      FOREIGN KEY ("owner_org_id") REFERENCES "orgs"("id") ON DELETE SET NULL;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'client_allowlist_org_id_orgs_id_fk') THEN
    ALTER TABLE "client_allowlist" ADD CONSTRAINT "client_allowlist_org_id_orgs_id_fk"
      FOREIGN KEY ("org_id") REFERENCES "orgs"("id") ON DELETE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'app_settings_sheet_org_id_orgs_id_fk') THEN
    ALTER TABLE "app_settings" ADD CONSTRAINT "app_settings_sheet_org_id_orgs_id_fk"
      FOREIGN KEY ("sheet_org_id") REFERENCES "orgs"("id") ON DELETE SET NULL;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'attachments_asset_id_assets_id_fk') THEN
    ALTER TABLE "attachments" ADD CONSTRAINT "attachments_asset_id_assets_id_fk"
      FOREIGN KEY ("asset_id") REFERENCES "assets"("id") ON DELETE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'instrument_gases_asset_id_assets_id_fk') THEN
    ALTER TABLE "instrument_gases" ADD CONSTRAINT "instrument_gases_asset_id_assets_id_fk"
      FOREIGN KEY ("asset_id") REFERENCES "assets"("id") ON DELETE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'app_settings_operator_org_id_orgs_id_fk') THEN
    ALTER TABLE "app_settings" ADD CONSTRAINT "app_settings_operator_org_id_orgs_id_fk"
      FOREIGN KEY ("operator_org_id") REFERENCES "orgs"("id") ON DELETE SET NULL;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'instruments_owner_org_id_orgs_id_fk') THEN
    ALTER TABLE "instruments" ADD CONSTRAINT "instruments_owner_org_id_orgs_id_fk"
      FOREIGN KEY ("owner_org_id") REFERENCES "orgs"("id") ON DELETE SET NULL;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'eod_updates_asset_id_assets_id_fk') THEN
    ALTER TABLE "eod_updates" ADD CONSTRAINT "eod_updates_asset_id_assets_id_fk"
      FOREIGN KEY ("asset_id") REFERENCES "assets"("id") ON DELETE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'asset_shares_asset_id_assets_id_fk') THEN
    ALTER TABLE "asset_shares" ADD CONSTRAINT "asset_shares_asset_id_assets_id_fk"
      FOREIGN KEY ("asset_id") REFERENCES "assets"("id") ON DELETE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'asset_shares_org_id_orgs_id_fk') THEN
    ALTER TABLE "asset_shares" ADD CONSTRAINT "asset_shares_org_id_orgs_id_fk"
      FOREIGN KEY ("org_id") REFERENCES "orgs"("id") ON DELETE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'engagement_records_instrument_id_instruments_id_fk') THEN
    ALTER TABLE "engagement_records" ADD CONSTRAINT "engagement_records_instrument_id_instruments_id_fk"
      FOREIGN KEY ("instrument_id") REFERENCES "instruments"("id") ON DELETE SET NULL;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'engagement_records_org_id_orgs_id_fk') THEN
    ALTER TABLE "engagement_records" ADD CONSTRAINT "engagement_records_org_id_orgs_id_fk"
      FOREIGN KEY ("org_id") REFERENCES "orgs"("id") ON DELETE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'access_requests_instrument_id_instruments_id_fk') THEN
    ALTER TABLE "access_requests" ADD CONSTRAINT "access_requests_instrument_id_instruments_id_fk"
      FOREIGN KEY ("instrument_id") REFERENCES "instruments"("id") ON DELETE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'access_requests_org_id_orgs_id_fk') THEN
    ALTER TABLE "access_requests" ADD CONSTRAINT "access_requests_org_id_orgs_id_fk"
      FOREIGN KEY ("org_id") REFERENCES "orgs"("id") ON DELETE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'template_items_template_task_id_template_tasks_id_fk') THEN
    ALTER TABLE "template_items" ADD CONSTRAINT "template_items_template_task_id_template_tasks_id_fk"
      FOREIGN KEY ("template_task_id") REFERENCES "template_tasks"("id") ON DELETE CASCADE;
  END IF;
END $$;

-- ── Seeds (idempotent; ON CONFLICT DO NOTHING never touches existing rows) ─
-- Built-in stages, colored to match the client sheet's dropdown chips.
-- After seeding, colors and custom stages are managed in Settings.
INSERT INTO "stage_defs" ("name","bg","fg","sort_order","builtin") VALUES
  ('Intake','#F9CB9C','#783F04',1,true),
  ('Refurbishment','#FFE599','#7F6000',2,true),
  ('System setup','#C9DAF8','#1C4587',3,true),
  ('Checkout','#B6E2A1','#2C5E1A',4,true),
  ('Applications','#E69138','#2E1C05',5,true),
  ('Sign-off','#E5F3E5','#2E6B2E',6,true),
  ('Waiting / blocked','#F4CCCC','#B42318',7,true),
  ('Waiting to ship','#D9D2E9','#674EA7',8,true),
  ('Shipped','#38761D','#D9EAD3',9,true),
  -- Added to the built-in list in code long after this seed first ran, so every
  -- instance that had already been seeded carried systems in a stage the
  -- vocabulary did not contain - and could not take them out of it again.
  ('In service','#E7F2FA','#1D6396',10,true),
  ('Maintenance due','#FAF0DC','#8A5410',11,true)
ON CONFLICT ("name") DO NOTHING;
-- The engineer's "Basic Testing Results" matrix as starter checkout rules;
-- fully editable (and extendable per model) on /templates.
INSERT INTO "checkout_rules" ("kind","model_match","title","criteria","sort_order") VALUES
  ('Pump','','Leak/Pulse Check','Pass/Fail',1),
  ('Pump','','Flow Check','Pass/Fail +/- 10%',2),
  ('Autosampler','','Temperature Check','Pass/Fail +/- 2.0 C',1),
  ('Autosampler','','Injection Check','Pass/Fail +/- 10 uL on total injection volume; +/- 3 uL on each injection',2),
  ('Column oven','','Temperature Check','Pass/Fail +/- 2.0 C',1),
  ('Detector','','Calibration','Pass/Fail',1),
  ('Mass spec','','Tuning and Calibration','Pass/Fail',1),
  ('Full system','','Caffeine Checkout','',1)
ON CONFLICT ("kind","model_match","title") DO NOTHING;

-- Assignee roster starters; emails and LabZen people are added in Settings.
INSERT INTO "people" ("name","email","org") VALUES
  ('Joe','','sierra'),
  ('Bill','','sierra')
ON CONFLICT ("name") DO NOTHING;

-- ── Migration: checkout_rules -> checkout_items ────────────────────────────
-- One-time copy, guarded on checkout_items being empty (so it also re-seeds a
-- DB where every item was deliberately deleted - same behavior the old seed
-- had). checkout_rules stays behind as the seed source and is otherwise unused.
-- Criteria parsing: "+/-" or the ± sign -> measured (a trailing % becomes
-- tolerance_pct, the rest of the text is kept in target); "pass"/"fail" or
-- blank -> pass_fail; anything else -> note with the original text in target.
-- Model filters: an exact case-insensitive match against the asset catalog
-- becomes a one-element scope; non-matches keep the raw string (nothing lost)
-- and get an audit_log row so they can be reviewed on /templates.
DO $$
DECLARE
  r RECORD;
  v_result text;
  v_remainder text;
  v_target text;
  v_tol numeric;
  v_catalog text;
  v_scope text[];
BEGIN
  IF NOT EXISTS (SELECT 1 FROM "checkout_items") THEN
    FOR r IN SELECT * FROM "checkout_rules" ORDER BY "kind", "sort_order", "id" LOOP
      IF r."criteria" ~ '(\+/-|±)' THEN
        v_result := 'measured';
        -- Drop a leading "Pass/Fail" - the measured type implies it.
        v_remainder := btrim(regexp_replace(r."criteria", '^\s*pass\s*/\s*fail\s*', '', 'i'));
        v_tol := substring(v_remainder from '(?:\+/-|±)\s*([0-9]+\.?[0-9]*)\s*%')::numeric;
        IF v_remainder ~ '^(\+/-|±)\s*[0-9]+\.?[0-9]*\s*%$' THEN
          v_target := NULL; -- a bare percent is fully expressed by tolerance_pct
        ELSE
          v_target := NULLIF(btrim(regexp_replace(v_remainder, '^(\+/-|±)\s*', '')), '');
        END IF;
      ELSIF r."criteria" ILIKE '%pass%' OR r."criteria" ILIKE '%fail%' OR btrim(r."criteria") = '' THEN
        v_result := 'pass_fail'; v_target := NULL; v_tol := NULL;
      ELSE
        v_result := 'note'; v_target := r."criteria"; v_tol := NULL;
      END IF;

      IF btrim(r."model_match") = '' THEN
        v_scope := '{}'::text[];
      ELSE
        SELECT a."model" INTO v_catalog FROM "assets" a
          WHERE lower(a."model") = lower(btrim(r."model_match")) LIMIT 1;
        IF v_catalog IS NOT NULL THEN
          v_scope := ARRAY[v_catalog];
        ELSE
          v_scope := ARRAY[btrim(r."model_match")];
          INSERT INTO "audit_log" ("actor","entity_type","entity_id","action")
          VALUES ('schema-sync', 'checkout', r."id"::text,
                  'checkout item "' || r."title" || '": model filter "' || btrim(r."model_match") || '" matched no asset in the catalog - carried over as-is, review on /templates');
        END IF;
        v_catalog := NULL;
      END IF;

      INSERT INTO "checkout_items"
        ("asset_type","kind","name","position","result_type","target","tolerance_pct","model_scope")
      VALUES (
        CASE WHEN r."kind" = 'Full system' THEN 'system' ELSE r."kind" END,
        'test', r."title", r."sort_order", v_result, v_target, v_tol, v_scope
      );
    END LOOP;
  END IF;
END $$;

-- ── Migration: one shared room -> organizations + per-system shares ────────
-- Before this, every signed-in client saw every system. Preserve exactly that
-- for the people who already have logins: create the org their allowlist
-- entries belong to, and share every existing system with it at 'edit' (the
-- client-edit toggle governed what they could actually change). Sierra keeps
-- seeing everything via STAFF_EMAILS - staff are not an org.
--
-- Guarded on orgs being empty, so it runs once and is a no-op forever after.
-- A brand-new database (no allowlist rows) gets nothing: orgs are created in
-- Settings as they are needed.
DO $$
DECLARE v_org integer;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM "orgs") AND EXISTS (SELECT 1 FROM "client_allowlist") THEN
    INSERT INTO "orgs" ("name","kind") VALUES ('LabZen','client') RETURNING "id" INTO v_org;
    UPDATE "client_allowlist" SET "org_id" = v_org WHERE "org_id" IS NULL;
    INSERT INTO "system_shares" ("instrument_id","org_id","access","added_by")
      SELECT "id", v_org, 'edit', 'schema-sync' FROM "instruments"
      ON CONFLICT ("instrument_id","org_id") DO NOTHING;
    UPDATE "app_settings" SET "sheet_org_id" = v_org WHERE "id" = 1 AND "sheet_org_id" IS NULL;
    INSERT INTO "audit_log" ("actor","entity_type","entity_id","action")
    VALUES ('schema-sync','org', v_org::text,
            'created organization "LabZen" from the existing sign-in allowlist and shared every system with it (edit) - unshare what should be private');
  END IF;
END $$;

-- ── Migration: the platform names itself; Sierra becomes a provider org ─────
-- The portal is a product, not a service company. Its wordmark now comes from
-- app_settings, seeded with the current name so nothing changes visibly on
-- deploy - rename it in Settings whenever the new brand is ready. In the same
-- step Sierra Spectra becomes a provider organization like any other, so its
-- service engagements are ordinary shares. The platform-operator role
-- (STAFF_EMAILS) is untouched and still sees everything.
--
-- Both steps are one-time and apply only to THIS instance, recognized by it
-- already holding data. A fresh database is a fresh product install: it gets no
-- Sierra org and no seeded name, and reads as DEFAULT_BRAND until Settings says
-- otherwise. Guarded on a marker so a rename in Settings is never undone.
--
-- ORDER MATTERS: this must stay below the organizations migration above, which
-- is guarded on "orgs" being empty. Creating an org before it would silently
-- skip the whole LabZen backfill.
DO $$
DECLARE v_org integer;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM "audit_log"
                 WHERE "actor" = 'schema-sync' AND "entity_type" = 'org' AND "entity_id" = 'operator-org')
     AND (EXISTS (SELECT 1 FROM "instruments") OR EXISTS (SELECT 1 FROM "client_allowlist")) THEN
    -- Keep the header reading as it does today; renaming is a Settings action.
    UPDATE "app_settings" SET "platform_name" = 'Sierra Spectra'
      WHERE "id" = 1 AND btrim("platform_name") = '';
    SELECT "id" INTO v_org FROM "orgs" WHERE lower("name") = 'sierra spectra';
    IF v_org IS NULL THEN
      INSERT INTO "orgs" ("name","kind") VALUES ('Sierra Spectra','provider') RETURNING "id" INTO v_org;
    END IF;
    UPDATE "app_settings" SET "operator_org_id" = v_org WHERE "id" = 1 AND "operator_org_id" IS NULL;
    INSERT INTO "audit_log" ("actor","entity_type","entity_id","action")
    VALUES ('schema-sync','org','operator-org',
            'created the "Sierra Spectra" service organization and set it as this instance''s operator - systems staff create are shared with it');
  END IF;
END $$;

-- NOTE: an earlier revision cleared owner_org_id on provider organizations,
-- on the rule that only a client could own equipment. That rule is gone - a
-- service company owns its own warehouse stock - so nothing heals ownership
-- here any more. The property that mattered lives in code instead: a provider
-- never *acquires* ownership by recording someone else's instrument
-- (creatorOwns in app/actions.ts); it only ever holds ownership that staff
-- assigned deliberately.

-- ── Migration: LabZen-era modules become optional, people carry org names ───
-- The sheet tracker, EOD report and digest stay on for this instance (it uses
-- them daily) and default off everywhere else. People rows drop the hardcoded
-- sierra/labzen labels for real organization names. Both one-time; the module
-- flags get a marker so switching one off in Settings survives redeploys, and
-- the people rewrite only ever matches the legacy literals.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM "audit_log"
                 WHERE "actor" = 'schema-sync' AND "entity_type" = 'settings' AND "entity_id" = 'module-flags')
     AND (EXISTS (SELECT 1 FROM "instruments") OR EXISTS (SELECT 1 FROM "client_allowlist")) THEN
    UPDATE "app_settings" SET "sheet_sync_enabled" = true, "eod_enabled" = true, "digest_enabled" = true WHERE "id" = 1;
    INSERT INTO "audit_log" ("actor","entity_type","entity_id","action")
    VALUES ('schema-sync','settings','module-flags',
            'kept the sheet tracker, EOD report and daily digest on for this existing instance - fresh installs start with them off');
  END IF;
  UPDATE "people" SET "org" = COALESCE((SELECT o."name" FROM "orgs" o JOIN "app_settings" s ON o."id" = s."operator_org_id" WHERE s."id" = 1), '')
    WHERE "org" = 'sierra';
  UPDATE "people" SET "org" = COALESCE((SELECT o."name" FROM "orgs" o JOIN "app_settings" s ON o."id" = s."sheet_org_id" WHERE s."id" = 1), 'Client')
    WHERE "org" = 'labzen';
END $$;

-- ── Migration: the daily report becomes one report per client ───────────────
-- Recipients used to be a single instance-wide list aimed at one client. Each
-- organization now carries its own, so /eod can group by client and send each
-- their own. Move the old list onto the organization it was aimed at. One-time:
-- editing a list afterwards must survive redeploys.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM "audit_log"
                 WHERE "actor" = 'schema-sync' AND "entity_type" = 'settings' AND "entity_id" = 'per-org-eod') THEN
    UPDATE "orgs" o SET "eod_recipients" = s."eod_recipients"
      FROM "app_settings" s
      WHERE s."id" = 1 AND o."id" = s."sheet_org_id" AND btrim(s."eod_recipients") <> '';
    INSERT INTO "audit_log" ("actor","entity_type","entity_id","action")
    VALUES ('schema-sync','settings','per-org-eod',
            'moved the daily report recipients onto the organization they were aimed at - each client now has its own list and its own send button');
  END IF;
END $$;

-- ── Migration: per-person roles replace the instance-wide edit toggle ───────
-- Every sign-in entry now carries its own editor/viewer role. Seed it once
-- from the old global "clients can edit" setting so nobody's rights change on
-- deploy; from then on the per-entry value is the only one read.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM "audit_log"
                 WHERE "actor" = 'schema-sync' AND "entity_type" = 'settings' AND "entity_id" = 'per-entry-roles') THEN
    UPDATE "client_allowlist" SET "can_edit" = COALESCE((SELECT "client_can_edit" FROM "app_settings" WHERE "id" = 1), false);
    -- Marker written even when no rows existed: a rerun must never clobber
    -- roles chosen per entry after this migration.
    INSERT INTO "audit_log" ("actor","entity_type","entity_id","action")
    VALUES ('schema-sync','settings','per-entry-roles',
            'seeded each sign-in entry''s editor/viewer role from the old instance-wide toggle - roles are per person from here on');
  END IF;
END $$;

-- ── Migration: formal system ownership ──────────────────────────────────────
-- owner_org_id says whose system it is (null = stewarded by the house). Seed it
-- once: a system whose shares include exactly one client-kind org at 'edit'
-- clearly belongs to that client; anything ambiguous stays house-stewarded and
-- is assigned by hand. One-time: an audit marker keeps a rerun from undoing a
-- deliberately cleared owner.
DO $$
DECLARE v_count integer;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM "audit_log"
                 WHERE "actor" = 'schema-sync' AND "entity_type" = 'org' AND "entity_id" = 'ownership-backfill') THEN
    UPDATE "instruments" i SET "owner_org_id" = one_owner.org_id
    FROM (
      SELECT s."instrument_id", min(s."org_id") AS org_id
      FROM "system_shares" s
      JOIN "orgs" o ON o."id" = s."org_id" AND o."kind" = 'client'
      WHERE s."access" = 'edit'
      GROUP BY s."instrument_id"
      HAVING count(*) = 1
    ) one_owner
    WHERE i."id" = one_owner."instrument_id" AND i."owner_org_id" IS NULL;
    GET DIAGNOSTICS v_count = ROW_COUNT;
    -- Marker always written, even at zero rows - a rerun must never assign
    -- owners to systems deliberately left with the house.
    INSERT INTO "audit_log" ("actor","entity_type","entity_id","action")
    VALUES ('schema-sync','org','ownership-backfill',
            'assigned ' || v_count || ' system(s) to the single client organization holding an edit share - review owners in each system''s sharing panel');
  END IF;
END $$;

-- ── Migration: discussion authorship and rooms ──────────────────────────────
-- Posts predate the audience rules, so attribute them once. author_org_id comes
-- from the exact sign-in entry that matches the author's email (@domain entries
-- name no one, so they can't attribute a post) - no match means the operator's
-- own staff wrote it, which is the correct reading for every staff post.
--
-- Every existing General post belonged to the one board the old code allowed:
-- the operator's room with the tracker's organization. Point them at that org
-- so nobody loses history the day rooms arrive; if no sheet org was ever set,
-- they stay on the operator's own board, which is who could see them anyway.
--
-- Nothing is marked internal: these posts were written under rules where all of
-- them were shared, and silently narrowing an existing conversation would be a
-- worse surprise than leaving it as it was read at the time.
DO $$
DECLARE v_authors integer; v_rooms integer;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM "audit_log"
                 WHERE "actor" = 'schema-sync' AND "entity_type" = 'discussion' AND "entity_id" = 'authorship-backfill') THEN
    UPDATE "discussion_posts" p SET "author_org_id" = a."org_id"
    FROM "client_allowlist" a
    WHERE a."org_id" IS NOT NULL
      AND left(btrim(a."entry"), 1) <> '@'
      AND lower(btrim(a."entry")) = lower(btrim(p."author_email"))
      AND p."author_org_id" IS NULL;
    GET DIAGNOSTICS v_authors = ROW_COUNT;

    UPDATE "discussion_posts" SET "room_org_id" = (SELECT "sheet_org_id" FROM "app_settings" WHERE "id" = 1)
    WHERE "instrument_id" IS NULL AND "room_org_id" IS NULL;
    GET DIAGNOSTICS v_rooms = ROW_COUNT;

    -- Marker written unconditionally: a rerun must never re-attribute posts
    -- after someone has moved a person between organizations.
    INSERT INTO "audit_log" ("actor","entity_type","entity_id","action")
    VALUES ('schema-sync','discussion','authorship-backfill',
            'attributed ' || v_authors || ' post(s) to the organization their author signs in as and moved ' || v_rooms || ' General post(s) into that organization''s room - every post stays shared, none was marked internal');
  END IF;
END $$;

-- ── Migration: seed the equipment catalog ───────────────────────────────────
-- The catalog becomes the only place asset types, models and system categories
-- are defined - pickers stop accepting free text. Seed it once so nothing the
-- shop already uses becomes unpickable: the starter asset types every install
-- gets, plus every type, model and category the fleet actually carries.
-- Models seed with no category tags (universal) - filing them under LC-MS /
-- GC-MS is curation, done in Settings > Catalog afterwards.
DO $$
DECLARE v_types integer; v_models integer; v_cats integer;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM "audit_log"
                 WHERE "actor" = 'schema-sync' AND "entity_type" = 'vocab' AND "entity_id" = 'catalog-seed') THEN
    INSERT INTO "vocab_terms" ("kind","asset_type","name")
    SELECT 'asset_type', '', t.name FROM (
      SELECT unnest(ARRAY['Pump','Autosampler','Column oven','Detector','Mass spec','Degasser',
                          'Controller','Headspace','GC','Injector','Vacuum pump','Computer','Other']) AS name
      UNION
      SELECT DISTINCT "kind" FROM "assets" WHERE btrim("kind") <> ''
    ) t
    WHERE NOT EXISTS (SELECT 1 FROM "vocab_terms" v
                      WHERE v."kind" = 'asset_type' AND lower(v."name") = lower(t.name));
    GET DIAGNOSTICS v_types = ROW_COUNT;

    INSERT INTO "vocab_terms" ("kind","asset_type","name")
    SELECT DISTINCT 'model', a."kind", a."model" FROM "assets" a
    WHERE btrim(a."model") <> '' AND btrim(a."kind") <> ''
      AND NOT EXISTS (SELECT 1 FROM "vocab_terms" v
                      WHERE v."kind" = 'model' AND lower(v."asset_type") = lower(a."kind")
                        AND lower(v."name") = lower(a."model"));
    GET DIAGNOSTICS v_models = ROW_COUNT;

    INSERT INTO "vocab_terms" ("kind","asset_type","name")
    SELECT DISTINCT 'category', '', i."category" FROM "instruments" i
    WHERE btrim(i."category") <> ''
      AND NOT EXISTS (SELECT 1 FROM "vocab_terms" v
                      WHERE v."kind" = 'category' AND lower(v."name") = lower(i."category"));
    GET DIAGNOSTICS v_cats = ROW_COUNT;

    -- Marker written unconditionally: a rerun must never resurrect a type or
    -- model the shop has deliberately removed from the catalog since.
    INSERT INTO "audit_log" ("actor","entity_type","entity_id","action")
    VALUES ('schema-sync','vocab','catalog-seed',
            'seeded the equipment catalog from the fleet: ' || v_types || ' asset type(s), ' ||
            v_models || ' model(s), ' || v_cats || ' system categor(ies) - curate in Settings > Catalog');
  END IF;
END $$;

-- ── Migration: one procedure catalog ────────────────────────────────────────
-- checkout_items and pm_templates were secretly the same thing - a procedure
-- defined against a module type, optionally narrowed to models, applied to
-- every unit - differing only in WHEN they fire. Copy both into `procedures`:
-- checkout items become runs_at_intake, templates become interval_days, and
-- nothing merges automatically - same-named rows on both sides stay separate
-- for hand reconciliation. Schedules stamped by a template are re-pointed at
-- the procedure that replaced it (procedure_id), so dedupe and completion keep
-- working; the schedules themselves are not touched. Old tables stay, retired.
DO $$
DECLARE r RECORD; v_id integer; v_items integer := 0; v_tpls integer := 0; v_pos integer;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM "audit_log"
                 WHERE "actor" = 'schema-sync' AND "entity_type" = 'procedure' AND "entity_id" = 'procedures-merge') THEN
    FOR r IN SELECT * FROM "checkout_items" ORDER BY "asset_type", "position", "id" LOOP
      INSERT INTO "procedures" ("asset_type","kind","name","position","result_type","target","tolerance_pct",
                                "requires_note","consumes_part","runs_at_intake","interval_days","model_scope","created_at")
      VALUES (r."asset_type", r."kind", r."name", r."position", r."result_type", r."target", r."tolerance_pct",
              r."requires_note", r."consumes_part", true, NULL, r."model_scope", r."created_at");
      v_items := v_items + 1;
    END LOOP;
    FOR r IN SELECT * FROM "pm_templates" ORDER BY "asset_type", "id" LOOP
      -- Templates had no ordering; they land after the intake items of their type.
      SELECT COALESCE(max("position"), 0) + 1 INTO v_pos FROM "procedures" WHERE "asset_type" = r."asset_type";
      INSERT INTO "procedures" ("asset_type","kind","name","notes","position","runs_at_intake","interval_days",
                                "parts","model_scope","created_at")
      VALUES (r."asset_type", 'task', r."title", r."body", v_pos, false, r."every_days",
              CASE WHEN btrim(r."part_number") <> '' OR btrim(r."part_name") <> ''
                   THEN json_build_array(json_build_object('name', r."part_name", 'number', r."part_number"))::text
                   ELSE '' END,
              r."model_scope", r."created_at")
      RETURNING "id" INTO v_id;
      UPDATE "pm_schedules" SET "procedure_id" = v_id WHERE "template_id" = r."id";
      v_tpls := v_tpls + 1;
    END LOOP;
    -- Marker written unconditionally: a rerun must never re-copy rows the shop
    -- has since edited or deleted in the merged catalog.
    INSERT INTO "audit_log" ("actor","entity_type","entity_id","action")
    VALUES ('schema-sync','procedure','procedures-merge',
            'merged ' || v_items || ' checkout item(s) and ' || v_tpls || ' maintenance template(s) into the procedure catalog - same-named pairs were kept separate for hand reconciliation');
  END IF;
END $$;

-- ── Migration: model manufacturers ──────────────────────────────────────────
-- Models gained a maker so the catalog can group by it. Seed each one from the
-- fleet: if every unit recorded as this model agrees on a manufacturer, that is
-- the model's manufacturer. Disagreement means the data is dirty, so those are
-- left blank for someone to set by hand rather than guessed at.
DO $$
DECLARE v_count integer;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM "audit_log"
                 WHERE "actor" = 'schema-sync' AND "entity_type" = 'vocab' AND "entity_id" = 'model-manufacturers') THEN
    UPDATE "vocab_terms" v SET "manufacturer" = agreed.mfr
    FROM (
      SELECT a."kind", a."model", min(btrim(a."manufacturer")) AS mfr
      FROM "assets" a
      WHERE btrim(a."manufacturer") <> '' AND btrim(a."model") <> ''
      GROUP BY a."kind", a."model"
      HAVING count(DISTINCT lower(btrim(a."manufacturer"))) = 1
    ) agreed
    WHERE v."kind" = 'model' AND v."manufacturer" = ''
      AND lower(v."asset_type") = lower(agreed."kind") AND lower(v."name") = lower(agreed."model");
    GET DIAGNOSTICS v_count = ROW_COUNT;
    -- Marker written unconditionally: a rerun must not overwrite a maker
    -- someone has since corrected by hand.
    INSERT INTO "audit_log" ("actor","entity_type","entity_id","action")
    VALUES ('schema-sync','vocab','model-manufacturers',
            'set the manufacturer on ' || v_count || ' catalog model(s) from the fleet - models whose units disagreed were left blank to set by hand');
  END IF;
END $$;

-- ── Migration: numeric part costs ───────────────────────────────────────────
-- cost stays the free-text display value; cost_cents is the summable copy the
-- reports read. Backfill parses only unambiguously money-shaped values
-- ("1,240", "$95.50") and leaves prose ("call for quote") null rather than
-- guessing. Marker written unconditionally so a rerun never re-parses a value
-- someone has since corrected.
DO $$
DECLARE v_count integer;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM "audit_log"
                 WHERE "actor" = 'schema-sync' AND "entity_type" = 'part' AND "entity_id" = 'cost-cents-backfill') THEN
    UPDATE "parts"
    SET "cost_cents" = round(replace(regexp_replace(btrim("cost"), '^\$', ''), ',', '')::numeric * 100)
    WHERE "cost_cents" IS NULL
      AND btrim("cost") ~ '^\$?\d{1,3}(,\d{3})*(\.\d{1,2})?$|^\$?\d+(\.\d{1,2})?$';
    GET DIAGNOSTICS v_count = ROW_COUNT;
    INSERT INTO "audit_log" ("actor","entity_type","entity_id","action")
    VALUES ('schema-sync','part','cost-cents-backfill',
            'parsed ' || v_count || ' part cost(s) into cents for reporting - non-numeric costs stay text-only');
  END IF;
END $$;

-- ── Part cost ownership ───────────────────────────────────────────────────
-- Cost visibility used to follow the system's CURRENT owner, which means a
-- handoff would have handed the new owner sight of every price the previous
-- one paid. Costs now follow the org that bought the part. Stamping existing
-- rows from today's owner is correct precisely because nothing has changed
-- hands yet - this runs before the first handoff is possible.
DO $$
DECLARE v_count integer;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM "audit_log"
                 WHERE "actor" = 'schema-sync' AND "entity_type" = 'part' AND "entity_id" = 'cost-owner-backfill') THEN
    UPDATE "parts" p
    SET "owner_org_id" = i."owner_org_id"
    FROM "instruments" i
    WHERE p."instrument_id" = i."id" AND p."owner_org_id" IS NULL AND i."owner_org_id" IS NOT NULL;
    GET DIAGNOSTICS v_count = ROW_COUNT;
    UPDATE "parts" p
    SET "owner_org_id" = a."owner_org_id"
    FROM "assets" a
    WHERE p."instrument_id" IS NULL AND p."asset_id" = a."id"
      AND p."owner_org_id" IS NULL AND a."owner_org_id" IS NOT NULL;
    INSERT INTO "audit_log" ("actor","entity_type","entity_id","action")
    VALUES ('schema-sync','part','cost-owner-backfill',
            'stamped ' || v_count || ' part(s) with the org that paid, so a handoff cannot expose a previous owner''s prices');
  END IF;
END $$;

-- ── Chain of custody ──────────────────────────────────────────────────────
-- One 'intake' row per already-owned system and shelf asset, so the custody
-- chain has a documented start rather than beginning at the first handoff.
-- Dated from the record's own creation, which is the earliest defensible date.
DO $$
DECLARE v_count integer;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM "audit_log"
                 WHERE "actor" = 'schema-sync' AND "entity_type" = 'custody' AND "entity_id" = 'intake-backfill') THEN
    INSERT INTO "custody_events" ("instrument_id","kind","to_org_id","to_name","note","actor","at")
    SELECT i."id", 'intake', i."owner_org_id", o."name",
           'first owner on record', 'schema-sync', i."created_at"
    FROM "instruments" i JOIN "orgs" o ON o."id" = i."owner_org_id"
    WHERE i."owner_org_id" IS NOT NULL;
    GET DIAGNOSTICS v_count = ROW_COUNT;
    INSERT INTO "custody_events" ("asset_id","kind","to_org_id","to_name","note","actor","at")
    SELECT a."id", 'intake', a."owner_org_id", o."name",
           'first owner on record', 'schema-sync', a."created_at"
    FROM "assets" a JOIN "orgs" o ON o."id" = a."owner_org_id"
    WHERE a."owner_org_id" IS NOT NULL AND a."instrument_id" IS NULL;
    INSERT INTO "audit_log" ("actor","entity_type","entity_id","action")
    VALUES ('schema-sync','custody','intake-backfill',
            'opened the custody chain for ' || v_count || ' owned system(s) and every owned shelf unit');
  END IF;
END $$;

-- ── Engagement records: what kind of ending is this? ──────────────────────
-- Records were minted by two very different events long before the column
-- existed: a provider's share being withdrawn, and a system changing hands.
-- The default stamps everything 'revoked', which is wrong for the handoffs, so
-- reclassify from the custody chain: a handoff writes the outgoing owner's
-- record and its own custody 'transfer' row inside one action, seconds apart.
-- A ten-minute window is generous enough for a slow dossier and far tighter
-- than any two real events on the same system and org.
DO $$
DECLARE v_count integer;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM "audit_log"
                 WHERE "actor" = 'schema-sync' AND "entity_type" = 'record' AND "entity_id" = 'record-kind-backfill') THEN
    UPDATE "engagement_records" r
    SET "kind" = 'handoff'
    WHERE EXISTS (
      SELECT 1 FROM "custody_events" c
      WHERE c."kind" = 'transfer'
        AND c."instrument_id" = r."instrument_id"
        AND c."from_org_id" = r."org_id"
        AND c."at" BETWEEN r."revoked_at" - interval '10 minutes' AND r."revoked_at" + interval '10 minutes'
    );
    GET DIAGNOSTICS v_count = ROW_COUNT;
    INSERT INTO "audit_log" ("actor","entity_type","entity_id","action")
    VALUES ('schema-sync','record','record-kind-backfill',
            'reclassified ' || v_count || ' frozen record(s) as handoffs; the rest stand as withdrawn shares');
  END IF;
END $$;

-- ── EOD history: whose report was this, on the day it was written? ────────
-- The report used to read ownership off the system, so selling a system moved
-- every past update with it - Monday's work vanished from the client who paid
-- for it and appeared under a new owner who had never seen the instrument.
-- Stamp each existing row from the custody chain: the owner as of the end of
-- that row's own date, which is exactly what the report should have said.
-- NULL stays NULL and means the operator's own group.
DO $$
DECLARE v_count integer;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM "audit_log"
                 WHERE "actor" = 'schema-sync' AND "entity_type" = 'eod' AND "entity_id" = 'eod-owner-backfill') THEN
    UPDATE "eod_updates" e
    SET "owner_org_id" = (
      SELECT c."to_org_id" FROM "custody_events" c
      WHERE c."instrument_id" = e."instrument_id"
        AND c."at" < (e."date"::date + 1)
      ORDER BY c."at" DESC, c."id" DESC
      LIMIT 1
    )
    WHERE e."instrument_id" IS NOT NULL AND e."owner_org_id" IS NULL;
    GET DIAGNOSTICS v_count = ROW_COUNT;
    UPDATE "eod_updates" e
    SET "owner_org_id" = (
      SELECT c."to_org_id" FROM "custody_events" c
      WHERE c."asset_id" = e."asset_id"
        AND c."at" < (e."date"::date + 1)
      ORDER BY c."at" DESC, c."id" DESC
      LIMIT 1
    )
    WHERE e."asset_id" IS NOT NULL AND e."owner_org_id" IS NULL;
    INSERT INTO "audit_log" ("actor","entity_type","entity_id","action")
    VALUES ('schema-sync','eod','eod-owner-backfill',
            'pinned ' || v_count || ' recorded update(s) to the org that owned the system that day, so a handoff cannot rewrite a past report');
  END IF;
END $$;

-- ── File storage: nobody wakes up to a limit they didn't agree to ─────────
-- storage_limit_mb defaults to 5 GB for organizations created from here on.
-- Every organization that already exists is set to 0 - no ceiling - because
-- introducing a quota retroactively would turn a working instance into a
-- support call, and because the operator has to decide what to sell before
-- anyone is held to it. Setting a real limit is a deliberate act in Settings.
DO $$
DECLARE v_count integer;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM "audit_log"
                 WHERE "actor" = 'schema-sync' AND "entity_type" = 'org' AND "entity_id" = 'storage-unlimited-existing') THEN
    UPDATE "orgs" SET "storage_limit_mb" = 0;
    GET DIAGNOSTICS v_count = ROW_COUNT;
    INSERT INTO "audit_log" ("actor","entity_type","entity_id","action")
    VALUES ('schema-sync','org','storage-unlimited-existing',
            'left ' || v_count || ' existing organization(s) on unlimited file storage; new ones start at the 5 GB default');
  END IF;
END $$;

-- ── Migration: one instance, many operators ─────────────────────────────────
-- Until now the instance had one house: whoever was staff saw everything, and
-- every other organization saw what was shared with it. That is one service
-- company with many clients. Selling the platform to other service companies
-- means each of them runs a workspace of its own - their staff, their clients,
-- their equipment - on the same instance, seeing none of each other.
--
-- The existing world becomes the first tenant. The operator org named in
-- app_settings becomes an operator; every other organization becomes its client;
-- every staff member becomes its staff; every record is stamped with it. Nothing
-- changes for anyone signed in today: the operator that runs the instance is the
-- root, and its staff keep seeing everything, because somebody has to be able to
-- support the tenants that come next.
--
-- An instance that never named an operator org is left alone. lib/tenants treats
-- a missing root as "one operator, no tenancy", which is exactly what it is.
DO $$
DECLARE v_root integer; v_orgs integer; v_rows integer; v_total integer := 0; t text;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM "audit_log"
                 WHERE "actor" = 'schema-sync' AND "entity_type" = 'org' AND "entity_id" = 'first-tenant') THEN
    SELECT "operator_org_id" INTO v_root FROM "app_settings" WHERE "id" = 1;
    IF v_root IS NOT NULL THEN
      UPDATE "orgs" SET "is_operator" = true WHERE "id" = v_root;
      UPDATE "orgs" SET "parent_org_id" = v_root WHERE "id" <> v_root AND "parent_org_id" IS NULL;
      GET DIAGNOSTICS v_orgs = ROW_COUNT;
      UPDATE "house_members" SET "org_id" = v_root WHERE "org_id" IS NULL;

      FOREACH t IN ARRAY ARRAY['instruments','assets','tasks','pm_schedules','time_entries',
                               'attachments','procedures','vocab_terms','stage_defs','people',
                               'stockrooms','purchase_orders','part_prices','eod_updates',
                               'remote_devices','audit_log'] LOOP
        EXECUTE format('UPDATE %I SET "tenant_org_id" = $1 WHERE "tenant_org_id" IS NULL', t) USING v_root;
        GET DIAGNOSTICS v_rows = ROW_COUNT;
        v_total := v_total + v_rows;
      END LOOP;

      INSERT INTO "audit_log" ("actor","entity_type","entity_id","action","tenant_org_id")
      VALUES ('schema-sync','org','first-tenant',
              'made the operator organization the first tenant: ' || v_orgs || ' organization(s) became its clients and '
              || v_total || ' record(s) were stamped with it - staff of the operator that runs the instance keep seeing everything',
              v_root);
    END IF;
    -- No sentinel when there was no operator to stamp with: an instance that
    -- deploys before it names one must still get this backfill on the deploy
    -- after it does, so the block stays retryable until it has work to do.
  END IF;
END $$;

-- ── Migration: stamp every discussion post with the workspace it was said in ─
-- "Internal" used to mean "the house", and the house was a role. One service
-- company ran an instance, so that was the same thing. It stops being the same
-- thing the moment a second service company works a shared system: both are
-- staff, and a role comparison would have handed each of them the other's
-- internal notes and every room on the other's General board.
--
-- A post on a system belongs to the workspace that system belongs to. A General
-- post belongs to the operator whose room it is in, and failing that to the root
-- operator - who, on any instance with unstamped posts, is the only company that
-- has ever existed on it.
DO $$
DECLARE v_sys integer; v_gen integer;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM "audit_log"
                 WHERE "actor" = 'schema-sync' AND "entity_type" = 'discussion' AND "entity_id" = 'tenant-stamp') THEN
    UPDATE "discussion_posts" p SET "tenant_org_id" = i."tenant_org_id"
    FROM "instruments" i
    WHERE p."instrument_id" = i."id" AND p."tenant_org_id" IS NULL;
    GET DIAGNOSTICS v_sys = ROW_COUNT;

    UPDATE "discussion_posts" SET "tenant_org_id" = COALESCE(
      (SELECT COALESCE(o."parent_org_id", o."id") FROM "orgs" o WHERE o."id" = "discussion_posts"."room_org_id"),
      (SELECT "operator_org_id" FROM "app_settings" WHERE "id" = 1))
    WHERE "tenant_org_id" IS NULL;
    GET DIAGNOSTICS v_gen = ROW_COUNT;

    INSERT INTO "audit_log" ("actor","entity_type","entity_id","action")
    VALUES ('schema-sync','discussion','tenant-stamp',
            'stamped ' || v_sys || ' system post(s) with their system''s workspace and ' || v_gen || ' other post(s) with the operator whose board they sit on');
  END IF;
END $$;

-- ── Migration: everybody already here has finished setting themselves up ─────
-- The welcome step is for somebody arriving for the first time. Running it at
-- people who have been using the instance for months would be a form in the way
-- of their work, so they are stamped as done on the way past. New rows have a
-- null onboarded_at and get the form.
DO $$
DECLARE v_users integer;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM "audit_log"
                 WHERE "actor" = 'schema-sync' AND "entity_type" = 'auth' AND "entity_id" = 'welcome-backfill') THEN
    UPDATE "users" SET "onboarded_at" = now() WHERE "onboarded_at" IS NULL;
    GET DIAGNOSTICS v_users = ROW_COUNT;
    INSERT INTO "audit_log" ("actor","entity_type","entity_id","action")
    VALUES ('schema-sync','auth','welcome-backfill',
            'marked ' || v_users || ' existing sign-in(s) as already set up, so only new people meet the welcome step');
  END IF;
END $$;

-- ── Every deploy: claim any stage the seed added after the tenancy backfill ──
-- The built-in seed runs on every deploy; the backfill that stamps rows with the
-- operator that owns them is one-shot and ran long ago. So a stage added to the
-- built-in list later - "In service", "Maintenance due" - lands with no tenant
-- and belongs to no workspace. Repeatable rather than guarded, so the next
-- built-in added does not reintroduce this.
UPDATE "stage_defs" SET "tenant_org_id" = (SELECT "operator_org_id" FROM "app_settings" WHERE "id" = 1)
WHERE "tenant_org_id" IS NULL
  AND (SELECT "operator_org_id" FROM "app_settings" WHERE "id" = 1) IS NOT NULL;

-- ── Work orders: one job, from the ask to the close-out ─────────────────────
-- The parent that tasks, hours and files were missing. Before it, a client's
-- request became a task dated today and there was nothing to close, nothing to
-- report a state on, and no number to quote on the phone.
--
-- The three work_order_id columns are ON DELETE SET NULL, not cascade: a work
-- order is a wrapper around work that actually happened, and deleting the
-- wrapper must never delete the record of the hours somebody worked.
CREATE TABLE IF NOT EXISTS "work_orders" (
  "id" serial PRIMARY KEY NOT NULL,
  "tenant_org_id" integer,
  "number" text NOT NULL DEFAULT '',
  "instrument_id" integer,
  "asset_id" integer,
  "org_id" integer,
  "requested_by" text NOT NULL DEFAULT '',
  "requested_by_email" text NOT NULL DEFAULT '',
  "title" text NOT NULL,
  "body" text NOT NULL DEFAULT '',
  "severity" text NOT NULL DEFAULT 'Degraded',
  "state" text NOT NULL DEFAULT 'open',
  "assignee" text NOT NULL DEFAULT '',
  "opened_on" text NOT NULL DEFAULT '',
  "origin" text NOT NULL DEFAULT '',
  "close_summary" text NOT NULL DEFAULT '',
  "closed_by" text NOT NULL DEFAULT '',
  "resolved_at" timestamp,
  "closed_at" timestamp,
  "created_at" timestamp NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "work_orders_instrument_idx" ON "work_orders" ("instrument_id");
CREATE INDEX IF NOT EXISTS "work_orders_asset_idx" ON "work_orders" ("asset_id");
CREATE INDEX IF NOT EXISTS "work_orders_state_idx" ON "work_orders" ("state");

ALTER TABLE "tasks" ADD COLUMN IF NOT EXISTS "work_order_id" integer;
ALTER TABLE "time_entries" ADD COLUMN IF NOT EXISTS "work_order_id" integer;
ALTER TABLE "attachments" ADD COLUMN IF NOT EXISTS "work_order_id" integer;
CREATE INDEX IF NOT EXISTS "tasks_work_order_idx" ON "tasks" ("work_order_id");
CREATE INDEX IF NOT EXISTS "time_work_order_idx" ON "time_entries" ("work_order_id");

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'work_orders_tenant_org_id_orgs_id_fk') THEN
    ALTER TABLE "work_orders" ADD CONSTRAINT "work_orders_tenant_org_id_orgs_id_fk"
      FOREIGN KEY ("tenant_org_id") REFERENCES "orgs"("id") ON DELETE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'work_orders_instrument_id_fk') THEN
    ALTER TABLE "work_orders" ADD CONSTRAINT "work_orders_instrument_id_fk"
      FOREIGN KEY ("instrument_id") REFERENCES "instruments"("id") ON DELETE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'work_orders_asset_id_fk') THEN
    ALTER TABLE "work_orders" ADD CONSTRAINT "work_orders_asset_id_fk"
      FOREIGN KEY ("asset_id") REFERENCES "assets"("id") ON DELETE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'work_orders_org_id_orgs_id_fk') THEN
    ALTER TABLE "work_orders" ADD CONSTRAINT "work_orders_org_id_orgs_id_fk"
      FOREIGN KEY ("org_id") REFERENCES "orgs"("id") ON DELETE SET NULL;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tasks_work_order_id_fk') THEN
    ALTER TABLE "tasks" ADD CONSTRAINT "tasks_work_order_id_fk"
      FOREIGN KEY ("work_order_id") REFERENCES "work_orders"("id") ON DELETE SET NULL;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'time_entries_work_order_id_fk') THEN
    ALTER TABLE "time_entries" ADD CONSTRAINT "time_entries_work_order_id_fk"
      FOREIGN KEY ("work_order_id") REFERENCES "work_orders"("id") ON DELETE SET NULL;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'attachments_work_order_id_fk') THEN
    ALTER TABLE "attachments" ADD CONSTRAINT "attachments_work_order_id_fk"
      FOREIGN KEY ("work_order_id") REFERENCES "work_orders"("id") ON DELETE SET NULL;
  END IF;
END $$;

-- One work-order number per workspace, so the race between reading the highest
-- number and writing the next one fails loudly instead of quietly handing WO-1042
-- to two different jobs. Partial, because a blank number is not a number; and
-- COALESCE, because a NULL tenant is the single-house instance that never
-- onboarded - one house, one series - and a plain index would treat every one of
-- its rows as distinct and enforce nothing at all.
CREATE UNIQUE INDEX IF NOT EXISTS "work_orders_tenant_number_unique"
  ON "work_orders" (COALESCE("tenant_org_id", 0), "number") WHERE "number" <> '';

-- ── Scope a system-level procedure to system categories ─────────────────────
-- System procedures existed but applied to EVERY system in the workspace, so an
-- annual LC-MS PM would also land on every GC. Nobody could use them, and each
-- system's upkeep got written out by hand instead. Empty = every system, which
-- is what the ones already defined meant, so this changes nothing on deploy.
ALTER TABLE "procedures" ADD COLUMN IF NOT EXISTS "category_scope" text[] NOT NULL DEFAULT '{}';

-- ── Where a company is, and where its instruments actually are ──────────────
-- Billing is one per company; labs are not. A client can have three sites and a
-- system lives at exactly one of them, so the sites are rows and the invoice
-- address is a column. access_notes is the field that earns the table: the
-- parking garage, the loading dock, who to ask for - facts about a BUILDING,
-- which on the company record would be noise and would be wrong the day they
-- open a second lab.
ALTER TABLE "orgs" ADD COLUMN IF NOT EXISTS "billing_address" text NOT NULL DEFAULT '';

CREATE TABLE IF NOT EXISTS "org_sites" (
  "id" serial PRIMARY KEY NOT NULL,
  "tenant_org_id" integer,
  "org_id" integer NOT NULL,
  "name" text NOT NULL DEFAULT '',
  "address" text NOT NULL DEFAULT '',
  "access_notes" text NOT NULL DEFAULT '',
  "contact_name" text NOT NULL DEFAULT '',
  "contact_phone" text NOT NULL DEFAULT '',
  "archived" boolean NOT NULL DEFAULT false,
  "created_by" text NOT NULL DEFAULT '',
  "created_at" timestamp NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "org_sites_org_idx" ON "org_sites" ("org_id");
ALTER TABLE "instruments" ADD COLUMN IF NOT EXISTS "site_id" integer;

-- ── The part catalog: what a part number IS ─────────────────────────────────
-- Part numbers were bare strings in five tables with normalizePn as the only
-- thing making them agree, so the same number got a different name typed
-- against it every time and a kit could not say what was in it. Deliberately
-- not a foreign key from those five: a part fitted at 2am must be recordable
-- before anybody has catalogued it.
CREATE TABLE IF NOT EXISTS "part_catalog" (
  "id" serial PRIMARY KEY NOT NULL,
  "tenant_org_id" integer,
  "part_number" text NOT NULL,
  "name" text NOT NULL DEFAULT '',
  "manufacturer" text NOT NULL DEFAULT '',
  "mfr_part_number" text NOT NULL DEFAULT '',
  "kind" text NOT NULL DEFAULT 'part',
  "asset_types" text[] NOT NULL DEFAULT '{}',
  "note" text NOT NULL DEFAULT '',
  "archived" boolean NOT NULL DEFAULT false,
  "created_by" text NOT NULL DEFAULT '',
  "created_at" timestamp NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "part_catalog_pn_idx" ON "part_catalog" ("part_number");
-- One row per number per workspace, matched exactly the way lib/priceBook's
-- normalizePn matches: lowercased, spaces stripped, HYPHENS KEPT. Hyphens are
-- load-bearing in part numbers - 5181-3323 and 51813-323 are different parts -
-- so an index that folded them would refuse to store one of the two. COALESCE
-- for the null tenant, which is the single-house instance and still one catalog.
CREATE UNIQUE INDEX IF NOT EXISTS "part_catalog_tenant_pn_unique"
  ON "part_catalog" (COALESCE("tenant_org_id", 0), lower(replace("part_number", ' ', '')));

CREATE TABLE IF NOT EXISTS "part_kit_lines" (
  "id" serial PRIMARY KEY NOT NULL,
  "kit_id" integer NOT NULL,
  "part_number" text NOT NULL,
  "name" text NOT NULL DEFAULT '',
  "qty" integer NOT NULL DEFAULT 1,
  "sort_order" integer NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS "part_kit_lines_kit_idx" ON "part_kit_lines" ("kit_id");

-- ── Service agreements ──────────────────────────────────────────────────────
-- The contract and what it entitles somebody to. What has been DRAWN DOWN is
-- deliberately not a column: it is summed from parts.cost_cents and closed work
-- orders. A stored balance is a second copy of a number the ledger already has,
-- and the disagreement always surfaces in front of the customer.
CREATE TABLE IF NOT EXISTS "agreements" (
  "id" serial PRIMARY KEY NOT NULL,
  "tenant_org_id" integer,
  "org_id" integer NOT NULL,
  "kind" text NOT NULL DEFAULT 'contract',
  "number" text NOT NULL DEFAULT '',
  "title" text NOT NULL DEFAULT '',
  "status" text NOT NULL DEFAULT 'active',
  "starts_on" text NOT NULL DEFAULT '',
  "ends_on" text NOT NULL DEFAULT '',
  "renew_notice_days" integer NOT NULL DEFAULT 60,
  "visits_included" integer NOT NULL DEFAULT 0,
  "parts_allowance_cents" integer NOT NULL DEFAULT 0,
  "labor_included_minutes" integer NOT NULL DEFAULT 0,
  "value_cents" integer,
  "note" text NOT NULL DEFAULT '',
  "created_by" text NOT NULL DEFAULT '',
  "created_at" timestamp NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "agreements_org_idx" ON "agreements" ("org_id");
CREATE INDEX IF NOT EXISTS "agreements_ends_idx" ON "agreements" ("ends_on");

-- ── Buying for a job rather than for a shelf ────────────────────────────────
-- A PO could only ever be raised against a stockroom, so "why did we buy this"
-- was unrecorded. With a work order it is "we bought this to fix THAT" - and it
-- is what lets a client's parts allowance be defended with a receipt.
ALTER TABLE "purchase_orders" ADD COLUMN IF NOT EXISTS "work_order_id" integer;
ALTER TABLE "parts" ADD COLUMN IF NOT EXISTS "po_id" integer;
ALTER TABLE "attachments" ADD COLUMN IF NOT EXISTS "agreement_id" integer;
ALTER TABLE "attachments" ADD COLUMN IF NOT EXISTS "po_id" integer;
CREATE INDEX IF NOT EXISTS "po_work_order_idx" ON "purchase_orders" ("work_order_id");
CREATE INDEX IF NOT EXISTS "parts_po_idx" ON "parts" ("po_id");
CREATE INDEX IF NOT EXISTS "attachments_agreement_idx" ON "attachments" ("agreement_id");

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'org_sites_org_id_orgs_id_fk') THEN
    ALTER TABLE "org_sites" ADD CONSTRAINT "org_sites_org_id_orgs_id_fk"
      FOREIGN KEY ("org_id") REFERENCES "orgs"("id") ON DELETE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'org_sites_tenant_org_id_orgs_id_fk') THEN
    ALTER TABLE "org_sites" ADD CONSTRAINT "org_sites_tenant_org_id_orgs_id_fk"
      FOREIGN KEY ("tenant_org_id") REFERENCES "orgs"("id") ON DELETE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'instruments_site_id_fk') THEN
    ALTER TABLE "instruments" ADD CONSTRAINT "instruments_site_id_fk"
      FOREIGN KEY ("site_id") REFERENCES "org_sites"("id") ON DELETE SET NULL;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'part_catalog_tenant_org_id_orgs_id_fk') THEN
    ALTER TABLE "part_catalog" ADD CONSTRAINT "part_catalog_tenant_org_id_orgs_id_fk"
      FOREIGN KEY ("tenant_org_id") REFERENCES "orgs"("id") ON DELETE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'part_kit_lines_kit_id_fk') THEN
    ALTER TABLE "part_kit_lines" ADD CONSTRAINT "part_kit_lines_kit_id_fk"
      FOREIGN KEY ("kit_id") REFERENCES "part_catalog"("id") ON DELETE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'agreements_org_id_orgs_id_fk') THEN
    ALTER TABLE "agreements" ADD CONSTRAINT "agreements_org_id_orgs_id_fk"
      FOREIGN KEY ("org_id") REFERENCES "orgs"("id") ON DELETE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'agreements_tenant_org_id_orgs_id_fk') THEN
    ALTER TABLE "agreements" ADD CONSTRAINT "agreements_tenant_org_id_orgs_id_fk"
      FOREIGN KEY ("tenant_org_id") REFERENCES "orgs"("id") ON DELETE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'purchase_orders_work_order_id_fk') THEN
    ALTER TABLE "purchase_orders" ADD CONSTRAINT "purchase_orders_work_order_id_fk"
      FOREIGN KEY ("work_order_id") REFERENCES "work_orders"("id") ON DELETE SET NULL;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'parts_po_id_fk') THEN
    ALTER TABLE "parts" ADD CONSTRAINT "parts_po_id_fk"
      FOREIGN KEY ("po_id") REFERENCES "purchase_orders"("id") ON DELETE SET NULL;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'attachments_agreement_id_fk') THEN
    ALTER TABLE "attachments" ADD CONSTRAINT "attachments_agreement_id_fk"
      FOREIGN KEY ("agreement_id") REFERENCES "agreements"("id") ON DELETE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'attachments_po_id_fk') THEN
    ALTER TABLE "attachments" ADD CONSTRAINT "attachments_po_id_fk"
      FOREIGN KEY ("po_id") REFERENCES "purchase_orders"("id") ON DELETE SET NULL;
  END IF;
END $$;

-- ── Per-model parts, per-system-type procedures, richer contracts ───────────
-- A part number can name the MODELS it suits (an LC-20 seal kit is not an
-- LC-30 seal kit); a contract can be unlimited, carry an hourly rate, and
-- cover specific systems so one client can run several at once.
ALTER TABLE "part_catalog" ADD COLUMN IF NOT EXISTS "models" text[] NOT NULL DEFAULT '{}';
ALTER TABLE "agreements" ADD COLUMN IF NOT EXISTS "visits_unlimited" boolean NOT NULL DEFAULT false;
ALTER TABLE "agreements" ADD COLUMN IF NOT EXISTS "parts_unlimited" boolean NOT NULL DEFAULT false;
ALTER TABLE "agreements" ADD COLUMN IF NOT EXISTS "hourly_rate_cents" integer;
ALTER TABLE "agreements" ADD COLUMN IF NOT EXISTS "instrument_ids" integer[] NOT NULL DEFAULT '{}';

-- ── Catalog reference library ───────────────────────────────────────────────
-- Manuals, links and field notes filed on a model or module type, surfacing on
-- every system and unit with matching equipment. See db/schema catalog_refs.
CREATE TABLE IF NOT EXISTS "catalog_refs" (
  "id" serial PRIMARY KEY,
  "tenant_org_id" integer,
  "asset_type" text NOT NULL,
  "model" text NOT NULL DEFAULT '',
  "kind" text NOT NULL DEFAULT 'link',
  "title" text NOT NULL DEFAULT '',
  "url" text NOT NULL DEFAULT '',
  "body" text NOT NULL DEFAULT '',
  "created_by" text NOT NULL DEFAULT '',
  "created_at" timestamp NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "catalog_refs_type_idx" ON "catalog_refs" ("asset_type");
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'catalog_refs_tenant_org_id_orgs_id_fk') THEN
    ALTER TABLE "catalog_refs" ADD CONSTRAINT "catalog_refs_tenant_org_id_orgs_id_fk"
      FOREIGN KEY ("tenant_org_id") REFERENCES "orgs"("id") ON DELETE CASCADE;
  END IF;
END $$;

-- ── PM parts are part of the PM ─────────────────────────────────────────────
-- A part requested from a maintenance job carries the schedule it came from,
-- so a contract that includes its PM's parts can keep them off the client's
-- parts allowance instead of billing the same thing twice.
ALTER TABLE "parts" ADD COLUMN IF NOT EXISTS "pm_schedule_id" integer;
ALTER TABLE "agreements" ADD COLUMN IF NOT EXISTS "pm_parts_included" boolean NOT NULL DEFAULT false;
CREATE INDEX IF NOT EXISTS "parts_pm_schedule_idx" ON "parts" ("pm_schedule_id");
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'parts_pm_schedule_id_fk') THEN
    ALTER TABLE "parts" ADD CONSTRAINT "parts_pm_schedule_id_fk"
      FOREIGN KEY ("pm_schedule_id") REFERENCES "pm_schedules"("id") ON DELETE SET NULL;
  END IF;
END $$;

-- ── Contracts that include kits, not a sum of money ─────────────────────────
-- "Two PMs, each with its kit" is how a PM contract is sold; a dollar figure
-- is a proxy that drifts the moment a kit's price moves.
ALTER TABLE "agreements" ADD COLUMN IF NOT EXISTS "included_kits" text NOT NULL DEFAULT '';

-- ── Gas requirements declared on the catalog ────────────────────────────────
-- What a kind of equipment needs, so a new system does not have its gases
-- typed out again: applied to matching units and systems on creation.
ALTER TABLE "vocab_terms" ADD COLUMN IF NOT EXISTS "gases" text[] NOT NULL DEFAULT '{}';

-- ── What a test actually read ───────────────────────────────────────────────
-- A test used to be completed with a checkbox while the number it produced had
-- nowhere to live. One row per task: a test task is one performance of a test,
-- so the history is the tasks rather than versions of a row. The spec is copied
-- in so re-tuning a target later cannot restate what an old reading meant.
CREATE TABLE IF NOT EXISTS "task_results" (
  "id" serial PRIMARY KEY,
  "task_id" integer NOT NULL,
  "result_type" text NOT NULL DEFAULT 'pass_fail',
  "value" text NOT NULL DEFAULT '',
  "passed" boolean,
  "target" text NOT NULL DEFAULT '',
  "tolerance_pct" text NOT NULL DEFAULT '',
  "note" text NOT NULL DEFAULT '',
  "recorded_by" text NOT NULL DEFAULT '',
  "recorded_at" timestamp NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "task_results_task_idx" ON "task_results" ("task_id");
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'task_result_task') THEN
    ALTER TABLE "task_results" ADD CONSTRAINT "task_result_task" UNIQUE ("task_id");
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'task_results_task_id_fk') THEN
    ALTER TABLE "task_results" ADD CONSTRAINT "task_results_task_id_fk"
      FOREIGN KEY ("task_id") REFERENCES "tasks"("id") ON DELETE CASCADE;
  END IF;
END $$;

-- ── Regulated (GxP) systems ─────────────────────────────────────────────────
-- One opt-in switch per system that every compliance surface hangs off, an
-- IQ/OQ/PQ grouping on procedures, and a validity date on documents so an
-- expiring cert is noticed before an auditor notices it.
ALTER TABLE "instruments" ADD COLUMN IF NOT EXISTS "gxp" boolean NOT NULL DEFAULT false;
ALTER TABLE "procedures" ADD COLUMN IF NOT EXISTS "qualification" text NOT NULL DEFAULT '';
ALTER TABLE "attachments" ADD COLUMN IF NOT EXISTS "expires_on" text NOT NULL DEFAULT '';

-- ── The validation shelf ────────────────────────────────────────────────────
-- Validation documents with a lifecycle (Draft -> Approved -> Executed ->
-- Superseded), role signatures behind them, and the package a kind of
-- equipment owes declared once on the catalog. Nothing current is ever
-- deleted: revisions supersede, and only an unsigned Draft may be removed.
CREATE TABLE IF NOT EXISTS "validation_docs" (
  "id" serial PRIMARY KEY,
  "tenant_org_id" integer,
  "instrument_id" integer NOT NULL,
  "doc_type" text NOT NULL,
  "title" text NOT NULL,
  "state" text NOT NULL DEFAULT 'Draft',
  "version" integer NOT NULL DEFAULT 1,
  "supersedes_id" integer,
  "attachment_id" integer,
  "review_on" text NOT NULL DEFAULT '',
  "note" text NOT NULL DEFAULT '',
  "created_by" text NOT NULL DEFAULT '',
  "created_at" timestamp NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "validation_docs_instrument_idx" ON "validation_docs" ("instrument_id");
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'validation_docs_instrument_id_fk') THEN
    ALTER TABLE "validation_docs" ADD CONSTRAINT "validation_docs_instrument_id_fk"
      FOREIGN KEY ("instrument_id") REFERENCES "instruments"("id") ON DELETE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'validation_docs_supersedes_id_fk') THEN
    ALTER TABLE "validation_docs" ADD CONSTRAINT "validation_docs_supersedes_id_fk"
      FOREIGN KEY ("supersedes_id") REFERENCES "validation_docs"("id") ON DELETE SET NULL;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'validation_docs_attachment_id_fk') THEN
    ALTER TABLE "validation_docs" ADD CONSTRAINT "validation_docs_attachment_id_fk"
      FOREIGN KEY ("attachment_id") REFERENCES "attachments"("id") ON DELETE SET NULL;
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS "validation_signatures" (
  "id" serial PRIMARY KEY,
  "doc_id" integer NOT NULL,
  "role" text NOT NULL DEFAULT 'Approved',
  "signed_by" text NOT NULL,
  "signer_name" text NOT NULL,
  "signer_title" text NOT NULL DEFAULT '',
  "note" text NOT NULL DEFAULT '',
  "created_at" timestamp NOT NULL DEFAULT now(),
  "revoked_at" timestamp,
  "revoke_reason" text NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS "validation_signatures_doc_idx" ON "validation_signatures" ("doc_id");
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'validation_signatures_doc_id_fk') THEN
    ALTER TABLE "validation_signatures" ADD CONSTRAINT "validation_signatures_doc_id_fk"
      FOREIGN KEY ("doc_id") REFERENCES "validation_docs"("id") ON DELETE CASCADE;
  END IF;
END $$;

ALTER TABLE "vocab_terms" ADD COLUMN IF NOT EXISTS "doc_types" text[] NOT NULL DEFAULT '{}';

-- ── Per-person agreement privilege, and parts asked of a client ─────────────
-- Who at a client organization may read its contracts, and which needed parts
-- have been handed to a client's own purchasing department to order.
ALTER TABLE "client_allowlist" ADD COLUMN IF NOT EXISTS "can_see_agreements" boolean NOT NULL DEFAULT true;
ALTER TABLE "parts" ADD COLUMN IF NOT EXISTS "requested_org_id" integer;
ALTER TABLE "parts" ADD COLUMN IF NOT EXISTS "requested_at" timestamp;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'parts_requested_org_id_fk') THEN
    ALTER TABLE "parts" ADD CONSTRAINT "parts_requested_org_id_fk"
      FOREIGN KEY ("requested_org_id") REFERENCES "orgs"("id") ON DELETE SET NULL;
  END IF;
END $$;

-- ── Direct messages ─────────────────────────────────────────────────────────
-- Person-to-person and small-group conversations, as opposed to the
-- system-attached discussion posts. Membership is by email, which is what this
-- app's identity actually is.
CREATE TABLE IF NOT EXISTS "message_threads" (
  "id" serial PRIMARY KEY,
  "tenant_org_id" integer,
  "title" text NOT NULL DEFAULT '',
  "created_by" text NOT NULL,
  "created_at" timestamp NOT NULL DEFAULT now(),
  "last_message_at" timestamp NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS "thread_members" (
  "id" serial PRIMARY KEY,
  "thread_id" integer NOT NULL,
  "email" text NOT NULL,
  "name" text NOT NULL DEFAULT '',
  "org_name" text NOT NULL DEFAULT '',
  "last_read_at" timestamp,
  "added_by" text NOT NULL DEFAULT '',
  "created_at" timestamp NOT NULL DEFAULT now(),
  "left_at" timestamp
);
CREATE INDEX IF NOT EXISTS "thread_members_thread_idx" ON "thread_members" ("thread_id");
CREATE INDEX IF NOT EXISTS "thread_members_email_idx" ON "thread_members" ("email");
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'thread_member_unique') THEN
    ALTER TABLE "thread_members" ADD CONSTRAINT "thread_member_unique" UNIQUE ("thread_id", "email");
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'thread_members_thread_id_fk') THEN
    ALTER TABLE "thread_members" ADD CONSTRAINT "thread_members_thread_id_fk"
      FOREIGN KEY ("thread_id") REFERENCES "message_threads"("id") ON DELETE CASCADE;
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS "messages" (
  "id" serial PRIMARY KEY,
  "thread_id" integer NOT NULL,
  "author_email" text NOT NULL,
  "author_name" text NOT NULL DEFAULT '',
  "body" text NOT NULL,
  "created_at" timestamp NOT NULL DEFAULT now(),
  "deleted_at" timestamp
);
CREATE INDEX IF NOT EXISTS "messages_thread_idx" ON "messages" ("thread_id", "created_at");
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'messages_thread_id_fk') THEN
    ALTER TABLE "messages" ADD CONSTRAINT "messages_thread_id_fk"
      FOREIGN KEY ("thread_id") REFERENCES "message_threads"("id") ON DELETE CASCADE;
  END IF;
END $$;

-- A support unit (roughing pump, chiller) names the module it serves. A flat
-- self-pointer, not a hierarchy - see the column comment in db/schema.ts.
ALTER TABLE "assets" ADD COLUMN IF NOT EXISTS "serves_asset_id" integer;
ALTER TABLE "assets" ADD COLUMN IF NOT EXISTS "serves_role" text NOT NULL DEFAULT '';
CREATE INDEX IF NOT EXISTS "assets_serves_idx" ON "assets" ("serves_asset_id");
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'assets_serves_asset_id_fk') THEN
    ALTER TABLE "assets" ADD CONSTRAINT "assets_serves_asset_id_fk"
      FOREIGN KEY ("serves_asset_id") REFERENCES "assets"("id") ON DELETE SET NULL;
  END IF;
END $$;

-- A checklist written once on a procedure and stamped onto every task it makes,
-- with section headings ("Remove & Sonicate:") that are labels, not boxes.
ALTER TABLE "procedures" ADD COLUMN IF NOT EXISTS "checklist" text NOT NULL DEFAULT '';
ALTER TABLE "checklist_items" ADD COLUMN IF NOT EXISTS "heading" boolean NOT NULL DEFAULT false;
ALTER TABLE "pm_schedules" ADD COLUMN IF NOT EXISTS "checklist" text NOT NULL DEFAULT '';

-- The other numbers one part answers to (ours and the makers'), and what it
-- looks like. Both hang off a catalog entry and die with it.
CREATE TABLE IF NOT EXISTS "part_numbers" (
  "id" serial PRIMARY KEY,
  "catalog_id" integer NOT NULL,
  "kind" text NOT NULL DEFAULT 'oem',
  "part_number" text NOT NULL,
  "manufacturer" text NOT NULL DEFAULT '',
  "note" text NOT NULL DEFAULT '',
  "sort_order" integer NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS "part_numbers_catalog_idx" ON "part_numbers" ("catalog_id");
CREATE INDEX IF NOT EXISTS "part_numbers_pn_idx" ON "part_numbers" ("part_number");
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'part_numbers_catalog_id_fk') THEN
    ALTER TABLE "part_numbers" ADD CONSTRAINT "part_numbers_catalog_id_fk"
      FOREIGN KEY ("catalog_id") REFERENCES "part_catalog"("id") ON DELETE CASCADE;
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS "part_photos" (
  "id" serial PRIMARY KEY,
  "catalog_id" integer NOT NULL,
  "url" text NOT NULL,
  "caption" text NOT NULL DEFAULT '',
  "sort_order" integer NOT NULL DEFAULT 0,
  "uploaded_by" text NOT NULL DEFAULT '',
  "created_at" timestamp NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "part_photos_catalog_idx" ON "part_photos" ("catalog_id");
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'part_photos_catalog_id_fk') THEN
    ALTER TABLE "part_photos" ADD CONSTRAINT "part_photos_catalog_id_fk"
      FOREIGN KEY ("catalog_id") REFERENCES "part_catalog"("id") ON DELETE CASCADE;
  END IF;
END $$;

-- Resale is a business a handful of organizations are in and clutter for the
-- rest, so the controls are off unless somebody turns them on.
ALTER TABLE "orgs" ADD COLUMN IF NOT EXISTS "resale_enabled" boolean NOT NULL DEFAULT false;

-- Folders in a file store. Scoped to loose files; a file on a record is
-- already filed. Deleting a folder never deletes files - they surface at root.
CREATE TABLE IF NOT EXISTS "folders" (
  "id" serial PRIMARY KEY,
  "tenant_org_id" integer,
  "org_id" integer,
  "parent_id" integer,
  "name" text NOT NULL,
  "created_by" text NOT NULL DEFAULT '',
  "created_at" timestamp NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "folders_org_idx" ON "folders" ("org_id");
CREATE INDEX IF NOT EXISTS "folders_parent_idx" ON "folders" ("parent_id");
ALTER TABLE "attachments" ADD COLUMN IF NOT EXISTS "folder_id" integer;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'folders_org_id_fk') THEN
    ALTER TABLE "folders" ADD CONSTRAINT "folders_org_id_fk"
      FOREIGN KEY ("org_id") REFERENCES "orgs"("id") ON DELETE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'folders_parent_id_fk') THEN
    ALTER TABLE "folders" ADD CONSTRAINT "folders_parent_id_fk"
      FOREIGN KEY ("parent_id") REFERENCES "folders"("id") ON DELETE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'folders_tenant_org_id_fk') THEN
    ALTER TABLE "folders" ADD CONSTRAINT "folders_tenant_org_id_fk"
      FOREIGN KEY ("tenant_org_id") REFERENCES "orgs"("id") ON DELETE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'attachments_folder_id_fk') THEN
    ALTER TABLE "attachments" ADD CONSTRAINT "attachments_folder_id_fk"
      FOREIGN KEY ("folder_id") REFERENCES "folders"("id") ON DELETE SET NULL;
  END IF;
END $$;

-- Bearer links into (drop) and out of (share) a file store. See lib/dropShare.
CREATE TABLE IF NOT EXISTS "drop_links" (
  "id" serial PRIMARY KEY,
  "tenant_org_id" integer,
  "org_id" integer,
  "folder_id" integer,
  "token" text NOT NULL,
  "label" text NOT NULL DEFAULT '',
  "expires_on" text NOT NULL,
  "used_count" integer NOT NULL DEFAULT 0,
  "last_upload_at" timestamp,
  "created_by" text NOT NULL,
  "created_at" timestamp NOT NULL DEFAULT now(),
  "revoked_at" timestamp
);
CREATE UNIQUE INDEX IF NOT EXISTS "drop_links_token_unique" ON "drop_links" ("token");
CREATE INDEX IF NOT EXISTS "drop_links_org_idx" ON "drop_links" ("org_id");
CREATE TABLE IF NOT EXISTS "share_links" (
  "id" serial PRIMARY KEY,
  "tenant_org_id" integer,
  "token" text NOT NULL,
  "label" text NOT NULL DEFAULT '',
  "expires_on" text NOT NULL,
  "created_by" text NOT NULL,
  "created_at" timestamp NOT NULL DEFAULT now(),
  "revoked_at" timestamp
);
CREATE UNIQUE INDEX IF NOT EXISTS "share_links_token_unique" ON "share_links" ("token");
CREATE TABLE IF NOT EXISTS "share_link_files" (
  "id" serial PRIMARY KEY,
  "share_id" integer NOT NULL,
  "attachment_id" integer NOT NULL
);
CREATE INDEX IF NOT EXISTS "share_link_files_share_idx" ON "share_link_files" ("share_id");
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'drop_links_org_id_fk') THEN
    ALTER TABLE "drop_links" ADD CONSTRAINT "drop_links_org_id_fk"
      FOREIGN KEY ("org_id") REFERENCES "orgs"("id") ON DELETE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'drop_links_folder_id_fk') THEN
    ALTER TABLE "drop_links" ADD CONSTRAINT "drop_links_folder_id_fk"
      FOREIGN KEY ("folder_id") REFERENCES "folders"("id") ON DELETE SET NULL;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'drop_links_tenant_org_id_fk') THEN
    ALTER TABLE "drop_links" ADD CONSTRAINT "drop_links_tenant_org_id_fk"
      FOREIGN KEY ("tenant_org_id") REFERENCES "orgs"("id") ON DELETE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'share_links_tenant_org_id_fk') THEN
    ALTER TABLE "share_links" ADD CONSTRAINT "share_links_tenant_org_id_fk"
      FOREIGN KEY ("tenant_org_id") REFERENCES "orgs"("id") ON DELETE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'share_link_files_share_id_fk') THEN
    ALTER TABLE "share_link_files" ADD CONSTRAINT "share_link_files_share_id_fk"
      FOREIGN KEY ("share_id") REFERENCES "share_links"("id") ON DELETE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'share_link_files_attachment_id_fk') THEN
    ALTER TABLE "share_link_files" ADD CONSTRAINT "share_link_files_attachment_id_fk"
      FOREIGN KEY ("attachment_id") REFERENCES "attachments"("id") ON DELETE CASCADE;
  END IF;
END $$;

-- Where a piece of reference material came from, and therefore whether it may
-- travel with a licensed library: '' (unreviewed) | original | facts | oem.
-- Default '' on purpose - unclassified is treated as not-ours-to-sell.
-- See lib/provenance.
ALTER TABLE "catalog_refs" ADD COLUMN IF NOT EXISTS "provenance" text NOT NULL DEFAULT '';
ALTER TABLE "procedures" ADD COLUMN IF NOT EXISTS "provenance" text NOT NULL DEFAULT '';

-- A model's specification sheet: JSON [{name, value}] rows on the catalog
-- entry ("Max pressure: 1300 bar"), so pump-vs-pump questions stop being a
-- manual lookup. See lib/specs.
ALTER TABLE "vocab_terms" ADD COLUMN IF NOT EXISTS "specs" text NOT NULL DEFAULT '';

-- The public, indexable face of a catalog model (lib/publicCatalog): an
-- explicit publish flag, the slug its page lives at, and the original summary
-- that earns the page its place in an index.
ALTER TABLE "vocab_terms" ADD COLUMN IF NOT EXISTS "published" boolean NOT NULL DEFAULT false;
ALTER TABLE "vocab_terms" ADD COLUMN IF NOT EXISTS "public_slug" text NOT NULL DEFAULT '';
ALTER TABLE "vocab_terms" ADD COLUMN IF NOT EXISTS "public_summary" text NOT NULL DEFAULT '';
CREATE UNIQUE INDEX IF NOT EXISTS "vocab_public_slug_idx" ON "vocab_terms" ("public_slug") WHERE "public_slug" <> '';

-- The public, indexable equipment library (app/equipment). Off by default:
-- being on the open web is a decision an operator makes, not a default.
ALTER TABLE "app_settings" ADD COLUMN IF NOT EXISTS "public_catalog_enabled" boolean NOT NULL DEFAULT false;

-- A PM kit recorded as one line, with the parts it contained beneath it.
-- Contents carry the kit's id and zero cost: the kit holds the money, so an
-- allowance is never charged twice for one box.
ALTER TABLE "parts" ADD COLUMN IF NOT EXISTS "parent_part_id" integer;
CREATE INDEX IF NOT EXISTS "parts_parent_idx" ON "parts" ("parent_part_id");
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'parts_parent_part_id_fk') THEN
    ALTER TABLE "parts" ADD CONSTRAINT "parts_parent_part_id_fk"
      FOREIGN KEY ("parent_part_id") REFERENCES "parts"("id") ON DELETE CASCADE;
  END IF;
END $$;

-- Who signs in, when, and through which door. The password path sends no mail,
-- so without this a service provider running the instance has no way to know
-- whether anybody is using it. Append-only; see lib/loginLog.
CREATE TABLE IF NOT EXISTS "login_events" (
  "id" serial PRIMARY KEY,
  "user_id" text,
  "email" text NOT NULL,
  "method" text NOT NULL DEFAULT 'code',
  "role" text NOT NULL DEFAULT '',
  "org_id" integer,
  "org_name" text NOT NULL DEFAULT '',
  "operator_org_id" integer,
  "ip" text NOT NULL DEFAULT '',
  "user_agent" text NOT NULL DEFAULT '',
  "created_at" timestamp NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "login_events_email_idx" ON "login_events" ("email");
CREATE INDEX IF NOT EXISTS "login_events_created_idx" ON "login_events" ("created_at");
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'login_events_user_id_fk') THEN
    ALTER TABLE "login_events" ADD CONSTRAINT "login_events_user_id_fk"
      FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE SET NULL;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'login_events_org_id_fk') THEN
    ALTER TABLE "login_events" ADD CONSTRAINT "login_events_org_id_fk"
      FOREIGN KEY ("org_id") REFERENCES "orgs"("id") ON DELETE SET NULL;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'login_events_operator_org_id_fk') THEN
    ALTER TABLE "login_events" ADD CONSTRAINT "login_events_operator_org_id_fk"
      FOREIGN KEY ("operator_org_id") REFERENCES "orgs"("id") ON DELETE SET NULL;
  END IF;
END $$;

-- Last time somebody actually used the app, not last time they signed in.
-- A month-long session means the two are nothing like the same number.
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "last_seen_at" timestamp;

-- Scheduled vs advisory maintenance per system. '' follows the owning org's
-- resale flag; an explicit value overrides it. See lib/pmPosture.
ALTER TABLE "instruments" ADD COLUMN IF NOT EXISTS "pm_posture" text NOT NULL DEFAULT '';

-- The newest "What's new" card each person has dismissed. See lib/whatsNew.
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "whats_new_seen" text NOT NULL DEFAULT '';

-- A hand-made task can demand an outcome: pass/fail, a number, or a note,
-- gated exactly like a procedure's test. See lib/testResult and lib/taskTests.
ALTER TABLE "tasks" ADD COLUMN IF NOT EXISTS "result_type" text NOT NULL DEFAULT '';

-- The conversation on a work order: comments above any one task.
CREATE TABLE IF NOT EXISTS "work_order_notes" (
  "id" serial PRIMARY KEY,
  "work_order_id" integer NOT NULL,
  "author" text NOT NULL,
  "text" text NOT NULL,
  "created_at" timestamp NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "wo_notes_wo_idx" ON "work_order_notes" ("work_order_id");
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'work_order_notes_work_order_id_fk') THEN
    ALTER TABLE "work_order_notes" ADD CONSTRAINT "work_order_notes_work_order_id_fk"
      FOREIGN KEY ("work_order_id") REFERENCES "work_orders"("id") ON DELETE CASCADE;
  END IF;
END $$;

-- Parts recorded from a work order carry the job, like tasks and hours do.
ALTER TABLE "parts" ADD COLUMN IF NOT EXISTS "work_order_id" integer;
CREATE INDEX IF NOT EXISTS "parts_work_order_idx" ON "parts" ("work_order_id");
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'parts_work_order_id_fk') THEN
    ALTER TABLE "parts" ADD CONSTRAINT "parts_work_order_id_fk"
      FOREIGN KEY ("work_order_id") REFERENCES "work_orders"("id") ON DELETE SET NULL;
  END IF;
END $$;

-- Who wrote a work-order comment, and whether it has been edited since.
-- Identity by email because that is what decides who may change it.
ALTER TABLE "work_order_notes" ADD COLUMN IF NOT EXISTS "author_email" text NOT NULL DEFAULT '';
ALTER TABLE "work_order_notes" ADD COLUMN IF NOT EXISTS "edited_at" timestamp;

-- Partner edition of the daily digest: who at each organization receives
-- their engagement's section. Blank = internal only. See lib/digest.
ALTER TABLE "orgs" ADD COLUMN IF NOT EXISTS "digest_recipients" text NOT NULL DEFAULT '';

-- When each organization's daily digest goes out, and whether it already has
-- today. The cron runs hourly and sends what is due, so the hour is a setting
-- rather than a cron expression in vercel.json. See lib/digest.
ALTER TABLE "orgs" ADD COLUMN IF NOT EXISTS "digest_hour" integer NOT NULL DEFAULT 7;
ALTER TABLE "orgs" ADD COLUMN IF NOT EXISTS "digest_last_sent_on" text NOT NULL DEFAULT '';
-- The same pair for an instance that has named no operator org.
ALTER TABLE "app_settings" ADD COLUMN IF NOT EXISTS "digest_hour" integer NOT NULL DEFAULT 7;
ALTER TABLE "app_settings" ADD COLUMN IF NOT EXISTS "digest_last_sent_on" text NOT NULL DEFAULT '';

-- Why a system is blocked, required at the moment of blocking. See lib/stages
-- and actions.toggleStage; blank on rows blocked before it was demanded.
ALTER TABLE "instruments" ADD COLUMN IF NOT EXISTS "blocked_reason" text NOT NULL DEFAULT '';
ALTER TABLE "instruments" ADD COLUMN IF NOT EXISTS "blocked_since" timestamp;
ALTER TABLE "instruments" ADD COLUMN IF NOT EXISTS "blocked_by" text NOT NULL DEFAULT '';
ALTER TABLE "instruments" ADD COLUMN IF NOT EXISTS "blocked_org_id" integer;

-- Platform appearance: the header colour and the spectrum bar above it, so a
-- rebrand is a settings change rather than a deploy. Blank/default = the look
-- the app ships with. See lib/appearance.
ALTER TABLE "app_settings" ADD COLUMN IF NOT EXISTS "header_color" text NOT NULL DEFAULT '';
ALTER TABLE "app_settings" ADD COLUMN IF NOT EXISTS "spectrum_height" integer NOT NULL DEFAULT 3;
ALTER TABLE "app_settings" ADD COLUMN IF NOT EXISTS "spectrum_stops" text NOT NULL DEFAULT '';

-- Which weekdays each digest fires (comma list of 0-6, blank = every day).
-- The window covers everything since the last send, so skipped days fold
-- into the next edition instead of vanishing. See lib/digestDays.
ALTER TABLE "orgs" ADD COLUMN IF NOT EXISTS "digest_days" text NOT NULL DEFAULT '';
ALTER TABLE "app_settings" ADD COLUMN IF NOT EXISTS "digest_days" text NOT NULL DEFAULT '';

-- ── Structured test acceptance (Prompt B3) ──────────────────────────────────
-- Tests grow a structured spec: measured values carry criteria rows
-- ({op, value, unit, center?} joined by OR), pass/fail carries its guidance
-- and attach-a-reading flag, readings their unit and typical range, notes
-- their prompt. The prose target/tolerance stay as the legacy spec - a test
-- with prose limits and no criteria shows in Needs review for hand migration,
-- never parsed automatically. Results freeze the spec they were judged
-- against, same rule as target.
ALTER TABLE "procedures" ADD COLUMN IF NOT EXISTS "acceptance" text NOT NULL DEFAULT '';
ALTER TABLE "task_results" ADD COLUMN IF NOT EXISTS "acceptance" text NOT NULL DEFAULT '';

-- "Needs a report attached" splits out of "required": a test can gate
-- sign-off on being done without demanding paper. Backfilled once from the
-- old coupling (required tests always demanded a report), marker-guarded so
-- a shop that later unchecks it is not re-checked on the next boot.
ALTER TABLE "procedures" ADD COLUMN IF NOT EXISTS "needs_report" boolean NOT NULL DEFAULT false;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM "audit_log"
                 WHERE "actor" = 'schema-sync' AND "entity_type" = 'procedure' AND "entity_id" = 'needs-report-backfill') THEN
    UPDATE "procedures" SET "needs_report" = true WHERE "kind" = 'test' AND "required";
    INSERT INTO "audit_log" ("actor","entity_type","entity_id","action")
    VALUES ('schema-sync','procedure','needs-report-backfill',
            'split the report requirement out of required - backfilled needs_report on required tests');
  END IF;
END $$;

-- Usage-based cadence ("every 2000 injections"): display and intake-stamp
-- only - the calendar cron schedules interval_days, and nothing counts
-- injections for us. Unit '' = no usage cadence.
ALTER TABLE "procedures" ADD COLUMN IF NOT EXISTS "usage_every" integer;
ALTER TABLE "procedures" ADD COLUMN IF NOT EXISTS "usage_unit" text NOT NULL DEFAULT '';

-- ── Internal EOD lines ──────────────────────────────────────────────────────
-- An update written for our own bench rather than for the client. Client-
-- facing renders (the EOD report, the partner digest) skip these; the system
-- page and the internal digest still show them. Anything generated about our
-- own bookkeeping - the sheet sync, the parity check - is internal by
-- default, because nobody chose to say it to a client.
ALTER TABLE "eod_updates" ADD COLUMN IF NOT EXISTS "internal" boolean NOT NULL DEFAULT false;
UPDATE "eod_updates" SET "internal" = true
 WHERE "internal" = false AND "updated_by" IN ('sheet-sync', 'parity');

-- ═══ BILLING ═══════════════════════════════════════════════════════════════
-- Additive only, like everything else in this file. Nothing here stores a
-- balance: invoice totals, drawdown, aging and hold status are all summed from
-- rows at render time by the pure functions in src/lib (see lib/billing).

-- What an hour costs. Three rungs, most specific first: agreement, then org,
-- then the platform default with both ids null. Multipliers are integer
-- percentages of the base rate - 150 is time-and-a-half, 50 is half - because
-- a float multiplier on money is how a $160 hour becomes $239.99999997.
CREATE TABLE IF NOT EXISTS "rate_cards" (
  "id" serial PRIMARY KEY NOT NULL,
  "tenant_org_id" integer,
  "org_id" integer,
  "agreement_id" integer,
  "hourly_cents" integer NOT NULL DEFAULT 0,
  "after_hours_pct" integer NOT NULL DEFAULT 150,
  "travel_pct" integer NOT NULL DEFAULT 50,
  "min_increment_min" integer NOT NULL DEFAULT 15,
  "label" text NOT NULL DEFAULT '',
  "created_by" text NOT NULL DEFAULT '',
  "created_at" timestamp NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "rate_cards_org_idx" ON "rate_cards" ("org_id");

-- Money on a job that is neither a part nor an hour: mileage, freight, a night
-- in a motel. Against the work order, because that is what it bills against.
CREATE TABLE IF NOT EXISTS "expenses" (
  "id" serial PRIMARY KEY NOT NULL,
  "tenant_org_id" integer,
  "work_order_id" integer NOT NULL,
  "kind" text NOT NULL DEFAULT 'other',
  "description" text NOT NULL DEFAULT '',
  "amount_cents" integer NOT NULL DEFAULT 0,
  "incurred_on" text NOT NULL DEFAULT '',
  "logged_by" text NOT NULL DEFAULT '',
  "created_at" timestamp NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "expenses_wo_idx" ON "expenses" ("work_order_id");

-- Is this hour billable, and which kind of hour is it. Billable defaults true
-- and is defaulted again at the panel from the agreement's coverage, so hours
-- on a covered system arrive unticked without anybody remembering.
ALTER TABLE "time_entries" ADD COLUMN IF NOT EXISTS "billable" boolean NOT NULL DEFAULT true;
ALTER TABLE "time_entries" ADD COLUMN IF NOT EXISTS "category" text NOT NULL DEFAULT 'onsite';

-- How a client is billed, and who the paper goes to. billing_policy overrides
-- the platform defaults in app_settings, the same layering the digest schedule
-- uses. A blank po_number is one of the two silent AP rejections (the other is
-- an exhausted one) - both are warned about at draft, never blocked.
ALTER TABLE "orgs" ADD COLUMN IF NOT EXISTS "terms_days" integer NOT NULL DEFAULT 30;
ALTER TABLE "orgs" ADD COLUMN IF NOT EXISTS "ap_email" text NOT NULL DEFAULT '';
ALTER TABLE "orgs" ADD COLUMN IF NOT EXISTS "po_number" text NOT NULL DEFAULT '';
ALTER TABLE "orgs" ADD COLUMN IF NOT EXISTS "po_balance_cents" integer NOT NULL DEFAULT 0;
ALTER TABLE "orgs" ADD COLUMN IF NOT EXISTS "billing_policy" jsonb;

-- Sales tax on PARTS at the address the goods landed at, in basis points
-- (775 = 7.75%). Tax belongs to the place, not the client. Zero draws no line.
ALTER TABLE "org_sites" ADD COLUMN IF NOT EXISTS "tax_rate_bps" integer NOT NULL DEFAULT 0;

-- ── Invoices: the bill, its lines, and the money that arrived ───────────────
-- No balance column anywhere. What is owed is lines + fees - payments, summed
-- at render by lib/billing.invoiceBalance. `status` is a lifecycle word (sent,
-- voided, referred), not an arithmetic result.
CREATE TABLE IF NOT EXISTS "invoices" (
  "id" serial PRIMARY KEY NOT NULL,
  "tenant_org_id" integer,
  "org_id" integer NOT NULL,
  "work_order_id" integer,
  "agreement_id" integer,
  "number" text NOT NULL,
  "status" text NOT NULL DEFAULT 'draft',
  "issued_on" text NOT NULL DEFAULT '',
  "due_on" text NOT NULL DEFAULT '',
  "po_number" text NOT NULL DEFAULT '',
  "note" text NOT NULL DEFAULT '',
  "created_by" text NOT NULL DEFAULT '',
  "created_at" timestamp NOT NULL DEFAULT now(),
  "updated_at" timestamp NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "invoices_org_idx" ON "invoices" ("org_id");
CREATE INDEX IF NOT EXISTS "invoices_wo_idx" ON "invoices" ("work_order_id");

-- Two invoices filed in the same second both read the same highest number.
-- This index is what makes that a failed insert rather than two bills called
-- INV-0094; the action retries, exactly as fileWorkOrder does.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'invoice_number_unique') THEN
    ALTER TABLE "invoices" ADD CONSTRAINT "invoice_number_unique" UNIQUE ("tenant_org_id", "number");
  END IF;
END $$;

-- qty is thousandths, so 4.5 hours is 4500 and nothing about a bill is ever a
-- float. `covered` prices the line at zero while keeping its real quantity and
-- unit price - that is what makes the $0 invoice readable.
CREATE TABLE IF NOT EXISTS "invoice_lines" (
  "id" serial PRIMARY KEY NOT NULL,
  "invoice_id" integer NOT NULL,
  "kind" text NOT NULL DEFAULT 'part',
  "description" text NOT NULL DEFAULT '',
  "detail" text NOT NULL DEFAULT '',
  "qty" integer NOT NULL DEFAULT 1000,
  "unit_cents" integer NOT NULL DEFAULT 0,
  "covered" boolean NOT NULL DEFAULT false,
  "covered_by" text NOT NULL DEFAULT '',
  "source_id" integer,
  "position" integer NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS "invoice_lines_invoice_idx" ON "invoice_lines" ("invoice_id");

CREATE TABLE IF NOT EXISTS "payments" (
  "id" serial PRIMARY KEY NOT NULL,
  "tenant_org_id" integer,
  "invoice_id" integer NOT NULL,
  "method" text NOT NULL DEFAULT 'check',
  "amount_cents" integer NOT NULL DEFAULT 0,
  "reference" text NOT NULL DEFAULT '',
  "received_on" text NOT NULL DEFAULT '',
  "recorded_by" text NOT NULL DEFAULT '',
  "created_at" timestamp NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "payments_invoice_idx" ON "payments" ("invoice_id");

-- A share link now knows what is on the other side of it, and remembers being
-- opened. That open IS the Viewed signal on an invoice timeline: one answer to
-- "did they see it", recorded where the link already lives.
ALTER TABLE "share_links" ADD COLUMN IF NOT EXISTS "kind" text NOT NULL DEFAULT 'files';
ALTER TABLE "share_links" ADD COLUMN IF NOT EXISTS "org_id" integer;
ALTER TABLE "share_links" ADD COLUMN IF NOT EXISTS "invoice_id" integer;
ALTER TABLE "share_links" ADD COLUMN IF NOT EXISTS "opened_at" timestamp;
ALTER TABLE "share_links" ADD COLUMN IF NOT EXISTS "last_opened_at" timestamp;
ALTER TABLE "share_links" ADD COLUMN IF NOT EXISTS "open_count" integer NOT NULL DEFAULT 0;

-- Invoice numbering and the one cost input a margin needs. loaded_labor_cents
-- at zero means nobody has said - the costing view reports that rather than a
-- flattering 100% margin.
ALTER TABLE "app_settings" ADD COLUMN IF NOT EXISTS "invoice_prefix" text NOT NULL DEFAULT 'INV-';
ALTER TABLE "app_settings" ADD COLUMN IF NOT EXISTS "loaded_labor_cents" integer NOT NULL DEFAULT 0;
ALTER TABLE "app_settings" ADD COLUMN IF NOT EXISTS "billing_policy" jsonb;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'invoices_tenant_org_id_orgs_id_fk') THEN
    ALTER TABLE "invoices" ADD CONSTRAINT "invoices_tenant_org_id_orgs_id_fk"
      FOREIGN KEY ("tenant_org_id") REFERENCES "orgs"("id") ON DELETE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'invoices_org_id_orgs_id_fk') THEN
    ALTER TABLE "invoices" ADD CONSTRAINT "invoices_org_id_orgs_id_fk"
      FOREIGN KEY ("org_id") REFERENCES "orgs"("id") ON DELETE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'invoices_work_order_id_fk') THEN
    ALTER TABLE "invoices" ADD CONSTRAINT "invoices_work_order_id_fk"
      FOREIGN KEY ("work_order_id") REFERENCES "work_orders"("id") ON DELETE SET NULL;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'invoices_agreement_id_fk') THEN
    ALTER TABLE "invoices" ADD CONSTRAINT "invoices_agreement_id_fk"
      FOREIGN KEY ("agreement_id") REFERENCES "agreements"("id") ON DELETE SET NULL;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'invoice_lines_invoice_id_fk') THEN
    ALTER TABLE "invoice_lines" ADD CONSTRAINT "invoice_lines_invoice_id_fk"
      FOREIGN KEY ("invoice_id") REFERENCES "invoices"("id") ON DELETE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'payments_tenant_org_id_orgs_id_fk') THEN
    ALTER TABLE "payments" ADD CONSTRAINT "payments_tenant_org_id_orgs_id_fk"
      FOREIGN KEY ("tenant_org_id") REFERENCES "orgs"("id") ON DELETE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'payments_invoice_id_fk') THEN
    ALTER TABLE "payments" ADD CONSTRAINT "payments_invoice_id_fk"
      FOREIGN KEY ("invoice_id") REFERENCES "invoices"("id") ON DELETE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'share_links_org_id_orgs_id_fk') THEN
    ALTER TABLE "share_links" ADD CONSTRAINT "share_links_org_id_orgs_id_fk"
      FOREIGN KEY ("org_id") REFERENCES "orgs"("id") ON DELETE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'share_links_invoice_id_fk') THEN
    ALTER TABLE "share_links" ADD CONSTRAINT "share_links_invoice_id_fk"
      FOREIGN KEY ("invoice_id") REFERENCES "invoices"("id") ON DELETE CASCADE;
  END IF;
END $$;

-- ── Collections: fees, promises, disputes, the ladder log, hold overrides ───
-- A fee is its own row and never edits the invoice it belongs to: an invoice
-- that changed after it was sent is one nobody can reconcile against the copy
-- in their inbox. Waiving keeps the row - the record of having charged and
-- then waived is the part worth anything.
CREATE TABLE IF NOT EXISTS "invoice_fees" (
  "id" serial PRIMARY KEY NOT NULL,
  "tenant_org_id" integer,
  "invoice_id" integer NOT NULL,
  "amount_cents" integer NOT NULL DEFAULT 0,
  "basis" text NOT NULL DEFAULT '',
  "posted_on" text NOT NULL DEFAULT '',
  "posted_by" text NOT NULL DEFAULT '',
  "waived" boolean NOT NULL DEFAULT false,
  "waived_by" text NOT NULL DEFAULT '',
  "waived_reason" text NOT NULL DEFAULT '',
  "created_at" timestamp NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "invoice_fees_invoice_idx" ON "invoice_fees" ("invoice_id");

CREATE TABLE IF NOT EXISTS "promises" (
  "id" serial PRIMARY KEY NOT NULL,
  "tenant_org_id" integer,
  "invoice_id" integer NOT NULL,
  "promised_on" text NOT NULL DEFAULT '',
  "by_name" text NOT NULL DEFAULT '',
  "note" text NOT NULL DEFAULT '',
  "kept_on" text,
  "logged_by" text NOT NULL DEFAULT '',
  "created_at" timestamp NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "promises_invoice_idx" ON "promises" ("invoice_id");

CREATE TABLE IF NOT EXISTS "disputes" (
  "id" serial PRIMARY KEY NOT NULL,
  "tenant_org_id" integer,
  "invoice_id" integer NOT NULL,
  "line_id" integer,
  "reason" text NOT NULL DEFAULT '',
  "opened_on" text NOT NULL DEFAULT '',
  "opened_by" text NOT NULL DEFAULT '',
  "resolved_on" text,
  "resolution" text NOT NULL DEFAULT '',
  "resolved_by" text NOT NULL DEFAULT '',
  "created_at" timestamp NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "disputes_invoice_idx" ON "disputes" ("invoice_id");

-- Which rungs have actually been climbed. The ladder is data in lib/dunning;
-- this is the log nextAction reads, and what the demand letter cites when it
-- says "we have since sent 3 reminders and a statement".
CREATE TABLE IF NOT EXISTS "dunning_events" (
  "id" serial PRIMARY KEY NOT NULL,
  "tenant_org_id" integer,
  "invoice_id" integer NOT NULL,
  "rung" text NOT NULL DEFAULT '',
  "to_name" text NOT NULL DEFAULT '',
  "to_email" text NOT NULL DEFAULT '',
  "sent_by" text NOT NULL DEFAULT 'auto',
  "note" text NOT NULL DEFAULT '',
  "sent_on" text NOT NULL DEFAULT '',
  "created_at" timestamp NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "dunning_events_invoice_idx" ON "dunning_events" ("invoice_id");

CREATE TABLE IF NOT EXISTS "credit_overrides" (
  "id" serial PRIMARY KEY NOT NULL,
  "tenant_org_id" integer,
  "org_id" integer NOT NULL,
  "reason" text NOT NULL DEFAULT '',
  "until_on" text NOT NULL DEFAULT '',
  "granted_by" text NOT NULL DEFAULT '',
  "lifted_at" timestamp,
  "created_at" timestamp NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "credit_overrides_org_idx" ON "credit_overrides" ("org_id");

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'invoice_fees_invoice_id_fk') THEN
    ALTER TABLE "invoice_fees" ADD CONSTRAINT "invoice_fees_invoice_id_fk"
      FOREIGN KEY ("invoice_id") REFERENCES "invoices"("id") ON DELETE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'invoice_fees_tenant_org_id_orgs_id_fk') THEN
    ALTER TABLE "invoice_fees" ADD CONSTRAINT "invoice_fees_tenant_org_id_orgs_id_fk"
      FOREIGN KEY ("tenant_org_id") REFERENCES "orgs"("id") ON DELETE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'promises_invoice_id_fk') THEN
    ALTER TABLE "promises" ADD CONSTRAINT "promises_invoice_id_fk"
      FOREIGN KEY ("invoice_id") REFERENCES "invoices"("id") ON DELETE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'promises_tenant_org_id_orgs_id_fk') THEN
    ALTER TABLE "promises" ADD CONSTRAINT "promises_tenant_org_id_orgs_id_fk"
      FOREIGN KEY ("tenant_org_id") REFERENCES "orgs"("id") ON DELETE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'disputes_invoice_id_fk') THEN
    ALTER TABLE "disputes" ADD CONSTRAINT "disputes_invoice_id_fk"
      FOREIGN KEY ("invoice_id") REFERENCES "invoices"("id") ON DELETE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'disputes_line_id_fk') THEN
    ALTER TABLE "disputes" ADD CONSTRAINT "disputes_line_id_fk"
      FOREIGN KEY ("line_id") REFERENCES "invoice_lines"("id") ON DELETE SET NULL;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'disputes_tenant_org_id_orgs_id_fk') THEN
    ALTER TABLE "disputes" ADD CONSTRAINT "disputes_tenant_org_id_orgs_id_fk"
      FOREIGN KEY ("tenant_org_id") REFERENCES "orgs"("id") ON DELETE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'dunning_events_invoice_id_fk') THEN
    ALTER TABLE "dunning_events" ADD CONSTRAINT "dunning_events_invoice_id_fk"
      FOREIGN KEY ("invoice_id") REFERENCES "invoices"("id") ON DELETE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'dunning_events_tenant_org_id_orgs_id_fk') THEN
    ALTER TABLE "dunning_events" ADD CONSTRAINT "dunning_events_tenant_org_id_orgs_id_fk"
      FOREIGN KEY ("tenant_org_id") REFERENCES "orgs"("id") ON DELETE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'credit_overrides_org_id_orgs_id_fk') THEN
    ALTER TABLE "credit_overrides" ADD CONSTRAINT "credit_overrides_org_id_orgs_id_fk"
      FOREIGN KEY ("org_id") REFERENCES "orgs"("id") ON DELETE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'credit_overrides_tenant_org_id_orgs_id_fk') THEN
    ALTER TABLE "credit_overrides" ADD CONSTRAINT "credit_overrides_tenant_org_id_orgs_id_fk"
      FOREIGN KEY ("tenant_org_id") REFERENCES "orgs"("id") ON DELETE CASCADE;
  END IF;
END $$;

-- ── Quotes: a price, offered ───────────────────────────────────────────────
-- Composed by the same lib/billing function that composes an invoice, from the
-- same rows, so what was quoted and what gets billed cannot drift apart. What
-- a quote adds is a date it stops being true and a deposit owed on yes.
CREATE TABLE IF NOT EXISTS "quotes" (
  "id" serial PRIMARY KEY NOT NULL,
  "tenant_org_id" integer,
  "org_id" integer NOT NULL,
  "work_order_id" integer,
  "agreement_id" integer,
  "number" text NOT NULL,
  "status" text NOT NULL DEFAULT 'draft',
  "title" text NOT NULL DEFAULT '',
  "sent_on" text NOT NULL DEFAULT '',
  "expires_on" text NOT NULL DEFAULT '',
  "deposit_pct" integer NOT NULL DEFAULT 0,
  "answered_on" text,
  "answered_by" text NOT NULL DEFAULT '',
  "answer_note" text NOT NULL DEFAULT '',
  "deposit_invoice_id" integer,
  "note" text NOT NULL DEFAULT '',
  "created_by" text NOT NULL DEFAULT '',
  "created_at" timestamp NOT NULL DEFAULT now(),
  "updated_at" timestamp NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "quotes_org_idx" ON "quotes" ("org_id");
CREATE INDEX IF NOT EXISTS "quotes_wo_idx" ON "quotes" ("work_order_id");

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'quote_number_unique') THEN
    ALTER TABLE "quotes" ADD CONSTRAINT "quote_number_unique" UNIQUE ("tenant_org_id", "number");
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS "quote_lines" (
  "id" serial PRIMARY KEY NOT NULL,
  "quote_id" integer NOT NULL,
  "kind" text NOT NULL DEFAULT 'part',
  "description" text NOT NULL DEFAULT '',
  "detail" text NOT NULL DEFAULT '',
  "qty" integer NOT NULL DEFAULT 1000,
  "unit_cents" integer NOT NULL DEFAULT 0,
  "covered" boolean NOT NULL DEFAULT false,
  "covered_by" text NOT NULL DEFAULT '',
  "source_id" integer,
  "position" integer NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS "quote_lines_quote_idx" ON "quote_lines" ("quote_id");

ALTER TABLE "share_links" ADD COLUMN IF NOT EXISTS "quote_id" integer;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'quotes_tenant_org_id_orgs_id_fk') THEN
    ALTER TABLE "quotes" ADD CONSTRAINT "quotes_tenant_org_id_orgs_id_fk"
      FOREIGN KEY ("tenant_org_id") REFERENCES "orgs"("id") ON DELETE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'quotes_org_id_orgs_id_fk') THEN
    ALTER TABLE "quotes" ADD CONSTRAINT "quotes_org_id_orgs_id_fk"
      FOREIGN KEY ("org_id") REFERENCES "orgs"("id") ON DELETE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'quotes_work_order_id_fk') THEN
    ALTER TABLE "quotes" ADD CONSTRAINT "quotes_work_order_id_fk"
      FOREIGN KEY ("work_order_id") REFERENCES "work_orders"("id") ON DELETE SET NULL;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'quotes_agreement_id_fk') THEN
    ALTER TABLE "quotes" ADD CONSTRAINT "quotes_agreement_id_fk"
      FOREIGN KEY ("agreement_id") REFERENCES "agreements"("id") ON DELETE SET NULL;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'quotes_deposit_invoice_id_fk') THEN
    ALTER TABLE "quotes" ADD CONSTRAINT "quotes_deposit_invoice_id_fk"
      FOREIGN KEY ("deposit_invoice_id") REFERENCES "invoices"("id") ON DELETE SET NULL;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'quote_lines_quote_id_fk') THEN
    ALTER TABLE "quote_lines" ADD CONSTRAINT "quote_lines_quote_id_fk"
      FOREIGN KEY ("quote_id") REFERENCES "quotes"("id") ON DELETE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'share_links_quote_id_fk') THEN
    ALTER TABLE "share_links" ADD CONSTRAINT "share_links_quote_id_fk"
      FOREIGN KEY ("quote_id") REFERENCES "quotes"("id") ON DELETE CASCADE;
  END IF;
END $$;

-- ── Payments: the operator's own Stripe account, and the platform's cut ────
-- The connected account belongs to the SERVICE COMPANY, not to Ridgeline.
-- Money moves bank to bank; the platform never holds funds and never sees a
-- card number. Blank means nobody has connected one and the pay buttons do
-- not render at all.
ALTER TABLE "orgs" ADD COLUMN IF NOT EXISTS "stripe_account_id" text NOT NULL DEFAULT '';
ALTER TABLE "orgs" ADD COLUMN IF NOT EXISTS "stripe_ready" boolean NOT NULL DEFAULT false;

-- Zero, and it stays zero until somebody decides otherwise: a platform that
-- silently starts taking a percentage of an operator's revenue is a platform
-- they leave.
ALTER TABLE "app_settings" ADD COLUMN IF NOT EXISTS "platform_fee_bps" integer NOT NULL DEFAULT 0;

-- ── People: the structured profile an owner can edit ───────────────────────
-- first/last are the structured halves of "name" (which stays the display
-- name everywhere); title is who they are at their company; site_id is which
-- of their organization's sites they sit at.
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "first_name" text NOT NULL DEFAULT '';
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "last_name" text NOT NULL DEFAULT '';
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "title" text NOT NULL DEFAULT '';
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "site_id" integer;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'users_site_id_fk') THEN
    ALTER TABLE "users" ADD CONSTRAINT "users_site_id_fk"
      FOREIGN KEY ("site_id") REFERENCES "org_sites"("id") ON DELETE SET NULL;
  END IF;
END $$;

-- ── Sourcing: the facts "cheapest or fastest" is decided on ────────────────
-- lead_days is the vendor's business days to ship (null = nobody asked, which
-- sorts slower than any number); drop_ships is whether they ship to a client
-- site under our paperwork; expedite_ok is whether they overnight on request.
ALTER TABLE "part_prices" ADD COLUMN IF NOT EXISTS "lead_days" integer;
ALTER TABLE "part_prices" ADD COLUMN IF NOT EXISTS "drop_ships" boolean NOT NULL DEFAULT false;
ALTER TABLE "part_prices" ADD COLUMN IF NOT EXISTS "expedite_ok" boolean NOT NULL DEFAULT false;

-- Days a non-drop-shipped part spends turning around at the shop, and the
-- brand parts ship under (packing slips, blind-ship instructions).
ALTER TABLE "app_settings" ADD COLUMN IF NOT EXISTS "cross_dock_days" integer NOT NULL DEFAULT 1;
ALTER TABLE "app_settings" ADD COLUMN IF NOT EXISTS "parts_brand" text NOT NULL DEFAULT 'Ridgeline';

-- ── Drop-ship and urgency on purchase orders ───────────────────────────────
-- ship_to_site_id null = ships to the stockroom as always; set = the vendor
-- ships straight to that client site under our paperwork (blind ship), and
-- receiving confirms delivery instead of shelving. urgent = overnight it.
ALTER TABLE "purchase_orders" ADD COLUMN IF NOT EXISTS "ship_to_site_id" integer;
ALTER TABLE "purchase_orders" ADD COLUMN IF NOT EXISTS "urgent" boolean NOT NULL DEFAULT false;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'po_ship_to_site_fk') THEN
    ALTER TABLE "purchase_orders" ADD CONSTRAINT "po_ship_to_site_fk"
      FOREIGN KEY ("ship_to_site_id") REFERENCES "org_sites"("id") ON DELETE SET NULL;
  END IF;
END $$;

-- Work that happened off the board: a call answered, an engineer walked
-- through a problem. Both instrument_id and asset_id stay null on these rows,
-- so the title is what identifies the line. See eod_updates.title.
ALTER TABLE "eod_updates" ADD COLUMN IF NOT EXISTS "title" text NOT NULL DEFAULT '';
ALTER TABLE "eod_updates" ADD COLUMN IF NOT EXISTS "person" text NOT NULL DEFAULT '';
ALTER TABLE "eod_updates" ADD COLUMN IF NOT EXISTS "minutes" integer NOT NULL DEFAULT 0;

-- Where an enquiry from the public landing page goes. See app_settings.publicContactEmail.
ALTER TABLE "app_settings" ADD COLUMN IF NOT EXISTS "public_contact_email" text NOT NULL DEFAULT '';

-- Expenses grow two facts and lose a constraint. billable: whether the row
-- reaches the client's invoice (cost either way - see schema.ts). person: who
-- gets reimbursed, for overhead rows. work_order_id nullable: an overhead
-- expense (an engineer's internet bill) is money no job caused, and it lives
-- in this table with NULL where the job would be. DROP NOT NULL is additive in
-- the sense that matters: no data changes shape and no old row can break.
ALTER TABLE "expenses" ADD COLUMN IF NOT EXISTS "billable" boolean NOT NULL DEFAULT true;
ALTER TABLE "expenses" ADD COLUMN IF NOT EXISTS "person" text NOT NULL DEFAULT '';
ALTER TABLE "expenses" ALTER COLUMN "work_order_id" DROP NOT NULL;

-- The shop's travel rules: radius, per diems, lodging cap. See lib/expensePolicy.
ALTER TABLE "app_settings" ADD COLUMN IF NOT EXISTS "expense_policy" jsonb;

-- The trip knows where it went. Sites carry their one-way road miles from the
-- shop (0 = never measured) so the travel-rules strip answers from the site;
-- expenses stamp which lab the trip served, surviving the site's closure.
ALTER TABLE "org_sites" ADD COLUMN IF NOT EXISTS "oneway_miles" integer NOT NULL DEFAULT 0;
ALTER TABLE "expenses" ADD COLUMN IF NOT EXISTS "site_id" integer;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'expenses_site_id_fk') THEN
    ALTER TABLE "expenses" ADD CONSTRAINT "expenses_site_id_fk"
      FOREIGN KEY ("site_id") REFERENCES "org_sites"("id") ON DELETE SET NULL;
  END IF;
END $$;

-- Each workspace's own expense vocabulary. Rows are the pickers' options;
-- expense rows store the name as text, so deleting a category never touches
-- history. See lib/expenseCategories for the starter set.
CREATE TABLE IF NOT EXISTS "expense_categories" (
  "id" serial PRIMARY KEY,
  "tenant_org_id" integer,
  "name" text NOT NULL,
  "sort_order" integer NOT NULL DEFAULT 0,
  "created_by" text NOT NULL DEFAULT '',
  "created_at" timestamp NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "expense_categories_tenant_idx" ON "expense_categories" ("tenant_org_id");
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'expense_categories_tenant_org_id_orgs_id_fk') THEN
    ALTER TABLE "expense_categories" ADD CONSTRAINT "expense_categories_tenant_org_id_orgs_id_fk"
      FOREIGN KEY ("tenant_org_id") REFERENCES "orgs"("id") ON DELETE CASCADE;
  END IF;
END $$;

-- Dynamic mileage: sites and engineer homes carry coordinates (geocoded
-- best-effort on save, never blocking), and routed distances are remembered
-- per (engineer, site) so no page ever waits on a maps provider.
ALTER TABLE "org_sites" ADD COLUMN IF NOT EXISTS "lat" double precision;
ALTER TABLE "org_sites" ADD COLUMN IF NOT EXISTS "lng" double precision;
ALTER TABLE "house_members" ADD COLUMN IF NOT EXISTS "home_address" text NOT NULL DEFAULT '';
ALTER TABLE "house_members" ADD COLUMN IF NOT EXISTS "home_lat" double precision;
ALTER TABLE "house_members" ADD COLUMN IF NOT EXISTS "home_lng" double precision;
CREATE TABLE IF NOT EXISTS "drive_cache" (
  "id" serial PRIMARY KEY,
  "member_email" text NOT NULL,
  "site_id" integer NOT NULL,
  "miles" double precision NOT NULL,
  "from_lat" double precision NOT NULL,
  "from_lng" double precision NOT NULL,
  "to_lat" double precision NOT NULL,
  "to_lng" double precision NOT NULL,
  "estimated" boolean NOT NULL DEFAULT false,
  "computed_at" timestamp NOT NULL DEFAULT now()
);
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'drive_cache_member_site') THEN
    ALTER TABLE "drive_cache" ADD CONSTRAINT "drive_cache_member_site" UNIQUE ("member_email","site_id");
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'drive_cache_site_id_fk') THEN
    ALTER TABLE "drive_cache" ADD CONSTRAINT "drive_cache_site_id_fk"
      FOREIGN KEY ("site_id") REFERENCES "org_sites"("id") ON DELETE CASCADE;
  END IF;
END $$;

-- A part order that is really a UNIT on order: module_kind names what it
-- becomes ("Pump", "Autosampler"), and Received offers an intake into the
-- asset list instead of ending the story. Blank = ordinary part.
ALTER TABLE "parts" ADD COLUMN IF NOT EXISTS "module_kind" text NOT NULL DEFAULT '';
ALTER TABLE "parts" ADD COLUMN IF NOT EXISTS "maker_org_id" integer;
ALTER TABLE "parts" ADD COLUMN IF NOT EXISTS "made_at" text NOT NULL DEFAULT '';

-- Who to tell we are coming: the en-route email's recipient, per site.
ALTER TABLE "org_sites" ADD COLUMN IF NOT EXISTS "contact_email" text NOT NULL DEFAULT '';


-- ── Recurring billing on an agreement ───────────────────────────────────────
-- A retainer bills the same amount every cycle with no work order behind it.
-- bill_every_months is the standing instruction (0 = not recurring, the same
-- reading the entitlement columns use); bill_next_on is the cursor, and the
-- only thing that stops a re-run raising the same month twice.
ALTER TABLE "agreements" ADD COLUMN IF NOT EXISTS "bill_every_months" integer NOT NULL DEFAULT 0;
ALTER TABLE "agreements" ADD COLUMN IF NOT EXISTS "bill_amount_cents" integer NOT NULL DEFAULT 0;
ALTER TABLE "agreements" ADD COLUMN IF NOT EXISTS "bill_description" text NOT NULL DEFAULT '';
ALTER TABLE "agreements" ADD COLUMN IF NOT EXISTS "bill_day_of_month" integer NOT NULL DEFAULT 1;
ALTER TABLE "agreements" ADD COLUMN IF NOT EXISTS "bill_lead_days" integer NOT NULL DEFAULT 7;
ALTER TABLE "agreements" ADD COLUMN IF NOT EXISTS "bill_next_on" text NOT NULL DEFAULT '';
ALTER TABLE "agreements" ADD COLUMN IF NOT EXISTS "bill_last_on" text NOT NULL DEFAULT '';

-- ── Expense reports ─────────────────────────────────────────────────────────
-- An engineer's reimbursement claim: a batch of their expenses submitted as
-- one thing to be paid as one thing. The total is summed from the rows at
-- render, never stored. Returning a report sends its rows back to the pool.
CREATE TABLE IF NOT EXISTS "expense_reports" (
  "id" serial PRIMARY KEY NOT NULL,
  "tenant_org_id" integer,
  "person" text NOT NULL,
  "status" text NOT NULL DEFAULT 'submitted',
  "submitted_by" text NOT NULL DEFAULT '',
  "submitted_at" timestamp NOT NULL DEFAULT now(),
  "paid_on" text NOT NULL DEFAULT '',
  "paid_by" text NOT NULL DEFAULT '',
  "paid_ref" text NOT NULL DEFAULT '',
  "returned_reason" text NOT NULL DEFAULT '',
  "note" text NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS "expense_reports_person_idx" ON "expense_reports" ("person");
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'expense_reports_tenant_org_id_orgs_id_fk') THEN
    ALTER TABLE "expense_reports" ADD CONSTRAINT "expense_reports_tenant_org_id_orgs_id_fk"
      FOREIGN KEY ("tenant_org_id") REFERENCES "orgs"("id") ON DELETE CASCADE;
  END IF;
END $$;
ALTER TABLE "expenses" ADD COLUMN IF NOT EXISTS "report_id" integer;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'expenses_report_id_expense_reports_id_fk') THEN
    ALTER TABLE "expenses" ADD CONSTRAINT "expenses_report_id_expense_reports_id_fk"
      FOREIGN KEY ("report_id") REFERENCES "expense_reports"("id") ON DELETE SET NULL;
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS "expenses_report_idx" ON "expenses" ("report_id");

-- The receipt on an expense row: a photo shot at the counter, or an emailed
-- PDF. Draft expense reports ride on the existing status column.
ALTER TABLE "expenses" ADD COLUMN IF NOT EXISTS "receipt_url" text NOT NULL DEFAULT '';
ALTER TABLE "expenses" ADD COLUMN IF NOT EXISTS "receipt_name" text NOT NULL DEFAULT '';

-- The maintenance appointment: the day the client agreed to have us in.
-- Distinct from next_due on purpose - "due Aug 12, booked Sep 12" is the
-- truth, and rewriting the due date to hide the nag would erase it.
ALTER TABLE "pm_schedules" ADD COLUMN IF NOT EXISTS "booked_on" text NOT NULL DEFAULT '';
ALTER TABLE "pm_schedules" ADD COLUMN IF NOT EXISTS "booked_note" text NOT NULL DEFAULT '';

-- The company calendar's feed secret. Blank = no feed; regenerate to rotate.
ALTER TABLE "app_settings" ADD COLUMN IF NOT EXISTS "calendar_token" text NOT NULL DEFAULT '';

-- A password an owner set for somebody else, and when it stops working. Null
-- for a password the person chose themselves, which never expires.
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "password_temp_until" timestamp;

-- What an organization pays its own people. Read only by that organization's
-- own administrators - never by the operator hosting them. See lib/payroll.
CREATE TABLE IF NOT EXISTS "payroll" (
  "id" serial PRIMARY KEY NOT NULL,
  "tenant_org_id" integer,
  "org_id" integer NOT NULL,
  "person_email" text NOT NULL DEFAULT '',
  "name" text NOT NULL DEFAULT '',
  "title" text NOT NULL DEFAULT '',
  "kind" text NOT NULL DEFAULT 'salary',
  "amount_cents" integer NOT NULL DEFAULT 0,
  "hours_per_week" integer NOT NULL DEFAULT 40,
  "fte_pct" integer NOT NULL DEFAULT 100,
  "burden_pct" integer NOT NULL DEFAULT 0,
  "effective_on" text NOT NULL DEFAULT '',
  "ends_on" text NOT NULL DEFAULT '',
  "note" text NOT NULL DEFAULT '',
  "created_by" text NOT NULL DEFAULT '',
  "created_at" timestamp NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "payroll_org_idx" ON "payroll" ("org_id");
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'payroll_org_id_orgs_id_fk') THEN
    ALTER TABLE "payroll" ADD CONSTRAINT "payroll_org_id_orgs_id_fk"
      FOREIGN KEY ("org_id") REFERENCES "orgs"("id") ON DELETE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'payroll_tenant_org_id_orgs_id_fk') THEN
    ALTER TABLE "payroll" ADD CONSTRAINT "payroll_tenant_org_id_orgs_id_fk"
      FOREIGN KEY ("tenant_org_id") REFERENCES "orgs"("id") ON DELETE CASCADE;
  END IF;
END $$;

-- Who at an organization may read its payroll. Off until somebody says so.
ALTER TABLE "client_allowlist" ADD COLUMN IF NOT EXISTS "can_see_payroll" boolean NOT NULL DEFAULT false;
ALTER TABLE "client_allowlist" ADD COLUMN IF NOT EXISTS "can_see_money" boolean NOT NULL DEFAULT true;
ALTER TABLE "client_allowlist" ADD COLUMN IF NOT EXISTS "start_view" text NOT NULL DEFAULT '';

-- po_lines has always DECLARED a cascading parent in schema.ts and never had
-- the constraint here, so nothing enforced it: deleting an order would have
-- left its lines behind forever. Orphans are unreachable garbage by
-- definition - no order names them - so they go before the key goes on.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'po_lines_po_id_purchase_orders_id_fk') THEN
    DELETE FROM "po_lines" l WHERE NOT EXISTS (
      SELECT 1 FROM "purchase_orders" p WHERE p.id = l.po_id
    );
    ALTER TABLE "po_lines" ADD CONSTRAINT "po_lines_po_id_purchase_orders_id_fk"
      FOREIGN KEY ("po_id") REFERENCES "purchase_orders"("id") ON DELETE CASCADE;
  END IF;
END $$;

-- Whoever holds a system can dismiss the handback line once they have read it.
-- Nullable rather than a boolean: the timestamp and the name are the record
-- that the handback landed, which is worth more to the shop than a flag.
ALTER TABLE "instruments" ADD COLUMN IF NOT EXISTS "queue_ack_at" timestamp;
ALTER TABLE "instruments" ADD COLUMN IF NOT EXISTS "queue_ack_by" text NOT NULL DEFAULT '';

-- Who provides the service an agreement covers. Null = the tenant on the row,
-- which is what every agreement written before this column meant, so there is
-- nothing to backfill.
ALTER TABLE "agreements" ADD COLUMN IF NOT EXISTS "provider_org_id" integer;

-- What somebody did and what went wrong while they did it. Off by default:
-- this is the one module that watches people rather than machines.
ALTER TABLE "app_settings" ADD COLUMN IF NOT EXISTS "trail_enabled" boolean NOT NULL DEFAULT false;

CREATE TABLE IF NOT EXISTS "trail_events" (
  "id" serial PRIMARY KEY NOT NULL,
  "kind" text NOT NULL DEFAULT 'page',
  "email" text NOT NULL DEFAULT '',
  "role" text NOT NULL DEFAULT '',
  "org_id" integer,
  "org_name" text NOT NULL DEFAULT '',
  "operator_org_id" integer,
  "viewing_as" text NOT NULL DEFAULT '',
  "route" text NOT NULL DEFAULT '',
  "query" text NOT NULL DEFAULT '',
  "message" text NOT NULL DEFAULT '',
  "detail" text NOT NULL DEFAULT '',
  "user_agent" text NOT NULL DEFAULT '',
  "at" timestamp NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "trail_events_at_idx" ON "trail_events" ("at");
CREATE INDEX IF NOT EXISTS "trail_events_kind_idx" ON "trail_events" ("kind");
CREATE INDEX IF NOT EXISTS "trail_events_email_idx" ON "trail_events" ("email");

-- HR, as a capability rather than a role. Whether this house member may file a
-- reimbursement claim for a colleague and read their workspace's payroll
-- register. Not the books: lib/books stays owner-only.
ALTER TABLE "house_members" ADD COLUMN IF NOT EXISTS "can_admin_people" boolean NOT NULL DEFAULT false;

-- What a client is owed in preventive maintenance, per class of system:
-- "two PMs a year on every mass spec, one on every LC". A count per year, not
-- a cadence - see src/db/schema.ts. category '' is that client's catch-all.
CREATE TABLE IF NOT EXISTS "pm_plans" (
  "id" serial PRIMARY KEY NOT NULL,
  "tenant_org_id" integer,
  "org_id" integer NOT NULL,
  "category" text NOT NULL DEFAULT '',
  "per_year" integer NOT NULL DEFAULT 1,
  "note" text NOT NULL DEFAULT '',
  "created_by" text NOT NULL DEFAULT '',
  "created_at" timestamp NOT NULL DEFAULT now()
);
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'pm_plans_org_id_orgs_id_fk') THEN
    ALTER TABLE "pm_plans" ADD CONSTRAINT "pm_plans_org_id_orgs_id_fk"
      FOREIGN KEY ("org_id") REFERENCES "orgs"("id") ON DELETE cascade;
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS "pm_plans_org_idx" ON "pm_plans" ("org_id");
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'pm_plan_org_category_unique') THEN
    ALTER TABLE "pm_plans" ADD CONSTRAINT "pm_plan_org_category_unique"
      UNIQUE ("tenant_org_id", "org_id", "category");
  END IF;
END $$;

-- A workspace's own spectrum: the thin gradient above the header. Blank stops
-- and a null height each mean "inherit the platform's", independently - see
-- src/db/schema.ts and lib/appearance.resolveLook.
ALTER TABLE "orgs" ADD COLUMN IF NOT EXISTS "spectrum_stops" text NOT NULL DEFAULT '';
ALTER TABLE "orgs" ADD COLUMN IF NOT EXISTS "spectrum_height" integer;

-- What an expense report IS and why it happened, in the filer's words. Both
-- optional: a report with no name reads as it always did (person + the span of
-- its rows). See src/db/schema.ts.
ALTER TABLE "expense_reports" ADD COLUMN IF NOT EXISTS "title" text NOT NULL DEFAULT '';
ALTER TABLE "expense_reports" ADD COLUMN IF NOT EXISTS "purpose" text NOT NULL DEFAULT '';

-- How a service company numbers its paper, as JSON. Blank = the stock shape
-- (PO-1042, INV-1043). See src/lib/docNumber.ts.
ALTER TABLE "orgs" ADD COLUMN IF NOT EXISTS "doc_scheme" text NOT NULL DEFAULT '';

-- How long a catalog procedure takes, in minutes. 0 = never estimated, which
-- an estimate reports rather than counting as free. See src/lib/pmKit.ts.
ALTER TABLE "procedures" ADD COLUMN IF NOT EXISTS "est_minutes" integer NOT NULL DEFAULT 0;

-- A multi-year award: one engagement, several separately-priced 12-month terms,
-- of which only the base year is committed. Each period stays an ordinary
-- agreements row - see src/db/schema.ts and src/lib/award.ts.
CREATE TABLE IF NOT EXISTS "awards" (
  "id" serial PRIMARY KEY,
  "tenant_org_id" integer REFERENCES "orgs"("id") ON DELETE CASCADE,
  "org_id" integer NOT NULL REFERENCES "orgs"("id") ON DELETE CASCADE,
  "number" text NOT NULL DEFAULT '',
  "title" text NOT NULL DEFAULT '',
  "awarded_on" text NOT NULL DEFAULT '',
  "option_notice_days" integer NOT NULL DEFAULT 60,
  "quote_id" integer REFERENCES "quotes"("id") ON DELETE SET NULL,
  "note" text NOT NULL DEFAULT '',
  "created_by" text NOT NULL DEFAULT '',
  "created_at" timestamp NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "awards_org_idx" ON "awards" ("org_id");

ALTER TABLE "agreements" ADD COLUMN IF NOT EXISTS "award_id" integer;
ALTER TABLE "agreements" ADD COLUMN IF NOT EXISTS "period_index" integer NOT NULL DEFAULT 0;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'agreements_award_id_fk') THEN
    ALTER TABLE "agreements" ADD CONSTRAINT "agreements_award_id_fk"
      FOREIGN KEY ("award_id") REFERENCES "awards"("id") ON DELETE SET NULL;
  END IF;
END $$;

-- Which systems a fleet share names. The twin of share_link_files: membership
-- frozen at creation, content live, and every id re-checked against the link's
-- own org and tenant before it renders. See src/lib/fleetBrief.ts.
CREATE TABLE IF NOT EXISTS "share_link_systems" (
  "id" serial PRIMARY KEY,
  "share_id" integer NOT NULL REFERENCES "share_links"("id") ON DELETE CASCADE,
  "instrument_id" integer NOT NULL REFERENCES "instruments"("id") ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS "share_link_systems_share_idx" ON "share_link_systems" ("share_id");

-- The service-company directory, one workspace's shortlist of peers, and one
-- client offered to one of them. See src/lib/clientShare.ts.
CREATE TABLE IF NOT EXISTS "provider_profiles" (
  "id" serial PRIMARY KEY,
  "org_id" integer NOT NULL UNIQUE REFERENCES "orgs"("id") ON DELETE CASCADE,
  "listed" boolean NOT NULL DEFAULT false,
  "blurb" text NOT NULL DEFAULT '',
  "services" text[] NOT NULL DEFAULT '{}',
  "regions" text[] NOT NULL DEFAULT '{}',
  "contact_name" text NOT NULL DEFAULT '',
  "contact_email" text NOT NULL DEFAULT '',
  "contact_phone" text NOT NULL DEFAULT '',
  "website" text NOT NULL DEFAULT '',
  "updated_by" text NOT NULL DEFAULT '',
  "updated_at" timestamp NOT NULL DEFAULT now(),
  "created_at" timestamp NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS "provider_links" (
  "id" serial PRIMARY KEY,
  "tenant_org_id" integer REFERENCES "orgs"("id") ON DELETE CASCADE,
  "provider_org_id" integer NOT NULL REFERENCES "orgs"("id") ON DELETE CASCADE,
  "note" text NOT NULL DEFAULT '',
  "created_by" text NOT NULL DEFAULT '',
  "created_at" timestamp NOT NULL DEFAULT now()
);
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'provider_link_unique') THEN
    ALTER TABLE "provider_links" ADD CONSTRAINT "provider_link_unique"
      UNIQUE ("tenant_org_id", "provider_org_id");
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS "client_shares" (
  "id" serial PRIMARY KEY,
  "tenant_org_id" integer REFERENCES "orgs"("id") ON DELETE CASCADE,
  "to_org_id" integer NOT NULL REFERENCES "orgs"("id") ON DELETE CASCADE,
  "source_org_id" integer NOT NULL REFERENCES "orgs"("id") ON DELETE CASCADE,
  "dest_org_id" integer REFERENCES "orgs"("id") ON DELETE SET NULL,
  "payload" text NOT NULL DEFAULT '',
  "status" text NOT NULL DEFAULT 'pending',
  "note" text NOT NULL DEFAULT '',
  "created_by" text NOT NULL DEFAULT '',
  "created_at" timestamp NOT NULL DEFAULT now(),
  "decided_by" text NOT NULL DEFAULT '',
  "decided_at" timestamp
);
CREATE INDEX IF NOT EXISTS "client_shares_to_idx" ON "client_shares" ("to_org_id");

-- The other shop's tag for a machine that arrived by a client share.
ALTER TABLE "instruments" ADD COLUMN IF NOT EXISTS "source_ref" text NOT NULL DEFAULT '';

-- A client's name is unique WITHIN a workspace, not across the instance.
--
-- The old UNIQUE(name) was invisible while one company ran the app and wrong
-- the moment two did: two service companies servicing the same lab both have a
-- client called "Emery Pharma", and the second one could not be created at all
-- - by hand or by a client share. The replacement buckets every operator under
-- 0, so operator names stay unique among themselves, and scopes client names to
-- their parent.
--
-- Strictly LOOSER than what it replaces (same case sensitivity, fewer rows
-- compared), so it cannot fail on data the old constraint already accepted.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'org_name_unique') THEN
    ALTER TABLE "orgs" DROP CONSTRAINT "org_name_unique";
  END IF;
END $$;
CREATE UNIQUE INDEX IF NOT EXISTS "org_name_per_tenant"
  ON "orgs" (COALESCE("parent_org_id", 0), "name");

-- What a referrer asks for, frozen into the offer so the recipient sees the
-- price before accepting. See src/lib/referral.ts.
ALTER TABLE "client_shares" ADD COLUMN IF NOT EXISTS "fee_kind" text NOT NULL DEFAULT 'none';
ALTER TABLE "client_shares" ADD COLUMN IF NOT EXISTS "fee_cents" integer NOT NULL DEFAULT 0;
ALTER TABLE "client_shares" ADD COLUMN IF NOT EXISTS "fee_bps" integer NOT NULL DEFAULT 0;
ALTER TABLE "client_shares" ADD COLUMN IF NOT EXISTS "fee_window_months" integer NOT NULL DEFAULT 12;
ALTER TABLE "client_shares" ADD COLUMN IF NOT EXISTS "fee_note" text NOT NULL DEFAULT '';

-- The fee itself, once somebody has accepted. Money between two service
-- companies, paid through the payee's own Stripe Connect account.
CREATE TABLE IF NOT EXISTS "referral_fees" (
  "id" serial PRIMARY KEY,
  "tenant_org_id" integer REFERENCES "orgs"("id") ON DELETE CASCADE,
  "share_id" integer NOT NULL REFERENCES "client_shares"("id") ON DELETE CASCADE,
  "payee_org_id" integer NOT NULL REFERENCES "orgs"("id") ON DELETE CASCADE,
  "payer_org_id" integer NOT NULL REFERENCES "orgs"("id") ON DELETE CASCADE,
  "client_org_id" integer REFERENCES "orgs"("id") ON DELETE SET NULL,
  "kind" text NOT NULL DEFAULT 'flat',
  "fee_cents" integer NOT NULL DEFAULT 0,
  "fee_bps" integer NOT NULL DEFAULT 0,
  "starts_on" text NOT NULL DEFAULT '',
  "ends_on" text NOT NULL DEFAULT '',
  "billed_cents" integer NOT NULL DEFAULT 0,
  "billed_from" text NOT NULL DEFAULT 'invoices',
  "billed_at" timestamp,
  "paid_cents" integer NOT NULL DEFAULT 0,
  "status" text NOT NULL DEFAULT 'open',
  "note" text NOT NULL DEFAULT '',
  "created_at" timestamp NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "referral_fees_payer_idx" ON "referral_fees" ("payer_org_id");
CREATE INDEX IF NOT EXISTS "referral_fees_payee_idx" ON "referral_fees" ("payee_org_id");

-- What the recipient proposed instead. Same five fields as the offer, so
-- agreeing to a counter is a copy rather than a translation, and the offer's
-- own fields stay true. See src/lib/clientShare.ts.
ALTER TABLE "client_shares" ADD COLUMN IF NOT EXISTS "counter_kind" text NOT NULL DEFAULT '';
ALTER TABLE "client_shares" ADD COLUMN IF NOT EXISTS "counter_cents" integer NOT NULL DEFAULT 0;
ALTER TABLE "client_shares" ADD COLUMN IF NOT EXISTS "counter_bps" integer NOT NULL DEFAULT 0;
ALTER TABLE "client_shares" ADD COLUMN IF NOT EXISTS "counter_window_months" integer NOT NULL DEFAULT 12;
ALTER TABLE "client_shares" ADD COLUMN IF NOT EXISTS "counter_note" text NOT NULL DEFAULT '';
ALTER TABLE "client_shares" ADD COLUMN IF NOT EXISTS "countered_by" text NOT NULL DEFAULT '';
ALTER TABLE "client_shares" ADD COLUMN IF NOT EXISTS "countered_at" timestamp;

-- The invoice raised for a referral fee, in the payee's books. From then on the
-- invoice is how it is collected and the fee stops keeping its own count - see
-- src/lib/referralData.ts.
ALTER TABLE "referral_fees" ADD COLUMN IF NOT EXISTS "invoice_id" integer;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'referral_fees_invoice_id_fk') THEN
    ALTER TABLE "referral_fees" ADD CONSTRAINT "referral_fees_invoice_id_fk"
      FOREIGN KEY ("invoice_id") REFERENCES "invoices"("id") ON DELETE SET NULL;
  END IF;
END $$;

-- A floor and a cap on a percentage referral fee. The floor waits for the
-- first dollar billed - see src/lib/referral.ts accruedCents.
ALTER TABLE "client_shares" ADD COLUMN IF NOT EXISTS "fee_min_cents" integer NOT NULL DEFAULT 0;
ALTER TABLE "client_shares" ADD COLUMN IF NOT EXISTS "fee_max_cents" integer NOT NULL DEFAULT 0;
ALTER TABLE "client_shares" ADD COLUMN IF NOT EXISTS "counter_min_cents" integer NOT NULL DEFAULT 0;
ALTER TABLE "client_shares" ADD COLUMN IF NOT EXISTS "counter_max_cents" integer NOT NULL DEFAULT 0;
ALTER TABLE "referral_fees" ADD COLUMN IF NOT EXISTS "min_cents" integer NOT NULL DEFAULT 0;
ALTER TABLE "referral_fees" ADD COLUMN IF NOT EXISTS "max_cents" integer NOT NULL DEFAULT 0;

-- Show the work without showing whose it is, until they accept. The snapshot is
-- never redacted at rest - only the rendering before the deal is struck. See
-- src/lib/clientShare.ts redactPayload.
ALTER TABLE "client_shares" ADD COLUMN IF NOT EXISTS "blind" boolean NOT NULL DEFAULT false;

-- An enquiry nobody has taken, offered to service companies for a finder's fee.
-- Blind until claimed, first claim wins. See src/lib/lead.ts.
CREATE TABLE IF NOT EXISTS "leads" (
  "id" serial PRIMARY KEY,
  "tenant_org_id" integer REFERENCES "orgs"("id") ON DELETE CASCADE,
  "contact_name" text NOT NULL DEFAULT '',
  "contact_email" text NOT NULL DEFAULT '',
  "contact_phone" text NOT NULL DEFAULT '',
  "org_name" text NOT NULL DEFAULT '',
  "address" text NOT NULL DEFAULT '',
  "region" text NOT NULL DEFAULT '',
  "blurb" text NOT NULL DEFAULT '',
  "systems" text NOT NULL DEFAULT '',
  "fee_kind" text NOT NULL DEFAULT 'flat',
  "fee_cents" integer NOT NULL DEFAULT 0,
  "fee_bps" integer NOT NULL DEFAULT 0,
  "fee_window_months" integer NOT NULL DEFAULT 12,
  "fee_min_cents" integer NOT NULL DEFAULT 0,
  "fee_max_cents" integer NOT NULL DEFAULT 0,
  "fee_note" text NOT NULL DEFAULT '',
  "status" text NOT NULL DEFAULT 'open',
  "claimed_by_org_id" integer REFERENCES "orgs"("id") ON DELETE SET NULL,
  "claimed_by" text NOT NULL DEFAULT '',
  "claimed_at" timestamp,
  "created_by" text NOT NULL DEFAULT '',
  "created_at" timestamp NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS "lead_offers" (
  "id" serial PRIMARY KEY,
  "lead_id" integer NOT NULL REFERENCES "leads"("id") ON DELETE CASCADE,
  "to_org_id" integer NOT NULL REFERENCES "orgs"("id") ON DELETE CASCADE,
  "created_at" timestamp NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "lead_offers_to_idx" ON "lead_offers" ("to_org_id");
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'lead_offer_unique') THEN
    ALTER TABLE "lead_offers" ADD CONSTRAINT "lead_offer_unique" UNIQUE ("lead_id", "to_org_id");
  END IF;
END $$;

-- A lead's finder's fee is the same debt as a handover's, so it is the same
-- row: share_id gives way to "one of the two", and both are now nullable.
-- DROP NOT NULL is safe on an existing column with every row filled.
ALTER TABLE "referral_fees" ALTER COLUMN "share_id" DROP NOT NULL;
ALTER TABLE "referral_fees" ADD COLUMN IF NOT EXISTS "lead_id" integer;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'referral_fees_lead_id_fk') THEN
    ALTER TABLE "referral_fees" ADD CONSTRAINT "referral_fees_lead_id_fk"
      FOREIGN KEY ("lead_id") REFERENCES "leads"("id") ON DELETE CASCADE;
  END IF;
END $$;

-- Where a received unit came from. Mirrors parts.po_id, which has answered
-- "where is the receipt for this" for consumables since purchasing existed.
ALTER TABLE "assets" ADD COLUMN IF NOT EXISTS "po_id" integer;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'assets_po_id_fk') THEN
    ALTER TABLE "assets" ADD CONSTRAINT "assets_po_id_fk"
      FOREIGN KEY ("po_id") REFERENCES "purchase_orders"("id") ON DELETE SET NULL;
  END IF;
END $$;

-- Recovered from the reimbursements merge: schema.ts gained these two columns
-- and the merge resolution on this file dropped their DDL, so main shipped a
-- schema.ts the deploy could not produce. (Guard test: check-schema-mirror.)
ALTER TABLE "expenses" ADD COLUMN IF NOT EXISTS "allowance_state" text NOT NULL DEFAULT '';
ALTER TABLE "expenses" ADD COLUMN IF NOT EXISTS "allowance_note" text NOT NULL DEFAULT '';
ALTER TABLE "expenses" ADD COLUMN IF NOT EXISTS "allowance_at" timestamp;
ALTER TABLE "expenses" ADD COLUMN IF NOT EXISTS "allowance_nights" integer NOT NULL DEFAULT 0;
ALTER TABLE "expenses" ADD COLUMN IF NOT EXISTS "allowance_by" text NOT NULL DEFAULT '';

ALTER TABLE "expense_reports" ADD COLUMN IF NOT EXISTS "opened_by" text NOT NULL DEFAULT '';
ALTER TABLE "expense_reports" ADD COLUMN IF NOT EXISTS "work_order_id" integer;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'expense_reports_work_order_id_fk') THEN
    ALTER TABLE "expense_reports" ADD CONSTRAINT "expense_reports_work_order_id_fk"
      FOREIGN KEY ("work_order_id") REFERENCES "work_orders"("id") ON DELETE SET NULL;
  END IF;
END $$;

-- The person file: the half of an employee record that is not pay.
ALTER TABLE "house_members" ADD COLUMN IF NOT EXISTS "phone" text NOT NULL DEFAULT '';
ALTER TABLE "house_members" ADD COLUMN IF NOT EXISTS "emergency_name" text NOT NULL DEFAULT '';
ALTER TABLE "house_members" ADD COLUMN IF NOT EXISTS "emergency_phone" text NOT NULL DEFAULT '';
ALTER TABLE "house_members" ADD COLUMN IF NOT EXISTS "started_on" text NOT NULL DEFAULT '';

-- Perks: compensation that is not wages. Same access family as payroll.
CREATE TABLE IF NOT EXISTS "perks" (
  "id" serial PRIMARY KEY,
  "tenant_org_id" integer REFERENCES "orgs"("id") ON DELETE CASCADE,
  "org_id" integer NOT NULL REFERENCES "orgs"("id") ON DELETE CASCADE,
  "person_email" text NOT NULL DEFAULT '',
  "name" text NOT NULL DEFAULT '',
  "title" text NOT NULL DEFAULT '',
  "amount_cents" integer NOT NULL DEFAULT 0,
  "cadence" text NOT NULL DEFAULT 'monthly',
  "starts_on" text NOT NULL DEFAULT '',
  "ends_on" text NOT NULL DEFAULT '',
  "note" text NOT NULL DEFAULT '',
  "created_by" text NOT NULL DEFAULT '',
  "created_at" timestamp NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "perks_org_idx" ON "perks" ("org_id");

-- Something a person noticed and said out loud. The trail records what the
-- machine noticed; this is the other half, and most of it.
CREATE TABLE IF NOT EXISTS "bug_reports" (
  "id" serial PRIMARY KEY,
  "tenant_org_id" integer REFERENCES "orgs"("id") ON DELETE CASCADE,
  "kind" text NOT NULL DEFAULT 'bug',
  "title" text NOT NULL DEFAULT '',
  "body" text NOT NULL DEFAULT '',
  "blocking" boolean NOT NULL DEFAULT false,
  "status" text NOT NULL DEFAULT 'new',
  "route" text NOT NULL DEFAULT '',
  "query" text NOT NULL DEFAULT '',
  "user_agent" text NOT NULL DEFAULT '',
  "viewport" text NOT NULL DEFAULT '',
  "build_sha" text NOT NULL DEFAULT '',
  "breadcrumbs" text NOT NULL DEFAULT '',
  "reported_by" text NOT NULL DEFAULT '',
  "reported_by_name" text NOT NULL DEFAULT '',
  "resolution" text NOT NULL DEFAULT '',
  "resolved_by" text NOT NULL DEFAULT '',
  "resolved_at" timestamp,
  "created_at" timestamp NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "bug_reports_status_idx" ON "bug_reports" ("status");
CREATE INDEX IF NOT EXISTS "bug_reports_tenant_idx" ON "bug_reports" ("tenant_org_id");
