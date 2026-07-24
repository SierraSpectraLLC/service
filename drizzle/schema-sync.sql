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
CREATE TABLE IF NOT EXISTS "instruments" (
  "id" serial PRIMARY KEY NOT NULL,
  "external_id" text NOT NULL,
  "client" text NOT NULL,
  "model" text NOT NULL,
  "priority" integer NOT NULL DEFAULT 99,
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
  "name" text NOT NULL,
  "part_number" text NOT NULL DEFAULT '',
  "serial" text NOT NULL DEFAULT '',
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
  "client_can_edit" boolean NOT NULL DEFAULT false
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
ALTER TABLE "eod_updates" ADD COLUMN IF NOT EXISTS "skipped" boolean NOT NULL DEFAULT false;

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
