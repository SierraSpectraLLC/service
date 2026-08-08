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
CREATE TABLE IF NOT EXISTS "engagement_records" (
  "id" serial PRIMARY KEY NOT NULL,
  "instrument_id" integer,
  "org_id" integer NOT NULL,
  "external_id" text NOT NULL DEFAULT '',
  "label" text NOT NULL DEFAULT '',
  "revoked_by" text NOT NULL DEFAULT '',
  "revoked_at" timestamp NOT NULL DEFAULT now(),
  "data" jsonb NOT NULL
);
CREATE TABLE IF NOT EXISTS "access_requests" (
  "id" serial PRIMARY KEY NOT NULL,
  "instrument_id" integer NOT NULL,
  "org_id" integer NOT NULL,
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

-- ── Indexes ───────────────────────────────────────────────────────────────
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
CREATE INDEX IF NOT EXISTS "time_instrument_idx" ON "time_entries" ("instrument_id");
CREATE INDEX IF NOT EXISTS "assets_instrument_idx" ON "assets" ("instrument_id");
CREATE INDEX IF NOT EXISTS "asset_events_asset_idx" ON "asset_events" ("asset_id");
CREATE INDEX IF NOT EXISTS "discussion_instrument_idx" ON "discussion_posts" ("instrument_id");
CREATE INDEX IF NOT EXISTS "discussion_created_idx" ON "discussion_posts" ("created_at");
CREATE INDEX IF NOT EXISTS "template_items_task_idx" ON "template_items" ("template_task_id");

CREATE INDEX IF NOT EXISTS "system_shares_org_idx" ON "system_shares" ("org_id");
CREATE INDEX IF NOT EXISTS "engagement_records_org_idx" ON "engagement_records" ("org_id");
CREATE INDEX IF NOT EXISTS "access_requests_instrument_idx" ON "access_requests" ("instrument_id");

-- ── Optional owners (widening only; no data is touched) ───────────────────
-- Tasks, parts, files and gases can belong to a standalone asset - a spare
-- being refurbished on the bench - so their instrument_id is optional. DROP
-- NOT NULL only ever accepts more rows than before, and each is guarded so a
-- re-run is a no-op.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['tasks','parts','attachments','instrument_gases'] LOOP
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
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'instruments_owner_org_id_orgs_id_fk') THEN
    ALTER TABLE "instruments" ADD CONSTRAINT "instruments_owner_org_id_orgs_id_fk"
      FOREIGN KEY ("owner_org_id") REFERENCES "orgs"("id") ON DELETE SET NULL;
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
  ('Shipped','#38761D','#D9EAD3',9,true)
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

-- ── Invariant: only client organizations own things ─────────────────────────
-- A service provider records a client's instrument; it never becomes theirs.
-- An ownership stamp on a provider org would outlive a revoked share and hand
-- back the access the unshare removed, so heal any that exist. Naturally
-- idempotent: by this rule a provider is never a legitimate owner.
UPDATE "assets" SET "owner_org_id" = NULL
  WHERE "owner_org_id" IN (SELECT "id" FROM "orgs" WHERE "kind" = 'provider');
UPDATE "instruments" SET "owner_org_id" = NULL
  WHERE "owner_org_id" IN (SELECT "id" FROM "orgs" WHERE "kind" = 'provider');

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
