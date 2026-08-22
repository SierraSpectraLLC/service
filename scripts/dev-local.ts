/**
 * A real run with a throwaway database: `npm run dev:local`.
 *
 * Seeds an in-process PGlite Postgres from drizzle/schema-sync.sql (the same
 * idempotent DDL every deploy applies), plants a small fixture so every list
 * page has rows, forges an owner session, and boots `next dev` with LOCAL_DB=1
 * so src/db swaps in the PGlite client. Nothing here can touch a real
 * database: no DATABASE_URL is read, and the swap in src/db/index.ts is gated
 * on NODE_ENV=development.
 *
 * Sign in by cookie, not by email: `authjs.session-token=devtoken`.
 * Wipe and reseed by deleting the data dir (printed on boot).
 */
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";

const DATA_DIR = process.env.PGLITE_DIR
  || path.join(process.cwd(), "node_modules", ".cache", "ridgeline-pglite");
const PORT = process.env.PORT || "3100";
const OWNER = "dev@local.test";

const FIXTURE = `
  INSERT INTO app_settings (id, client_access_enabled) VALUES (1, true);
  UPDATE app_settings SET sheet_sync_enabled = true, eod_enabled = true,
    digest_enabled = true, remote_enabled = true, public_catalog_enabled = true
    WHERE id = 1;

  INSERT INTO orgs (name, kind) VALUES
    ('Lab Zen', 'client'),
    ('Coastal Analytical', 'client');

  INSERT INTO users (id, name, email, role, onboarded_at) VALUES
    ('dev-user', 'Dev Owner', '${OWNER}', 'owner', now()),
    ('dev-new', '', 'new@local.test', 'tech', NULL);
  INSERT INTO sessions (session_token, user_id, expires) VALUES
    ('devtoken', 'dev-user', now() + interval '30 days'),
    ('newtoken', 'dev-new', now() + interval '30 days');

  INSERT INTO instruments (external_id, client, model, manufacturer, serial, priority, stages, notes) VALUES
    ('LZ-001', 'Lab Zen', 'Agilent 6495C LC-MS', 'Agilent', 'US2405111', 1, '{"Checkout"}', 'Reserpine test and tune.'),
    ('LZ-002', 'Lab Zen', 'Thermo ISQ 7000 GC-MS', 'Thermo', 'ISQ70233', 2, '{"Refurbishment","System setup"}', 'Turbo replaced, pumping down.'),
    ('LZ-003', 'Lab Zen', 'Shimadzu LCMS-8060', 'Shimadzu', 'SH806014', 3, '{"Sign-off"}', 'Awaiting client sign-off.'),
    ('CA-001', 'Coastal Analytical', 'PerkinElmer Optima 8300 ICP-OES', 'PerkinElmer', 'PE83007', 4, '{"Intake"}', ''),
    ('CA-002', 'Coastal Analytical', 'Agilent 7890B GC', 'Agilent', 'CN14320', 5, '{"Waiting / blocked"}', 'HED fault - part on order.'),
    ('CA-003', 'Coastal Analytical', 'Waters Xevo TQ-S', 'Waters', 'WAT5521', 6, '{"In service"}', '');

  INSERT INTO assets (instrument_id, kind, model, serial, manufacturer, status, location) VALUES
    (1, 'Mass spec', '6495C', 'US2405111', 'Agilent', 'In service', 'Bench 4'),
    (1, 'Pump', '1290 Quat Pump', 'DEBA2201', 'Agilent', 'In service', 'Bench 4'),
    (2, 'Mass spec', 'ISQ 7000', 'ISQ70233', 'Thermo', 'Needs attention', 'Bay 2'),
    (2, 'Autosampler', 'TriPlus RSH', 'TP99120', 'Thermo', 'Needs attention', 'Bay 2'),
    (3, 'Mass spec', 'LCMS-8060', 'SH806014', 'Shimadzu', 'In service', 'Bay 1'),
    (4, 'Spectrometer', 'Optima 8300', 'PE83007', 'PerkinElmer', 'Needs attention', 'Receiving'),
    (5, 'GC', '7890B', 'CN14320', 'Agilent', 'Down', 'Bay 3'),
    (NULL, 'N2 generator', 'Peak Genius 1051', 'PG105188', 'Peak', 'In service', 'Utility room'),
    (NULL, 'Vacuum pump', 'Edwards nXDS10i', 'ED22981', 'Edwards', 'Spare', 'Shelf C'),
    (NULL, 'Computer', 'Z2 Mini G9', 'HPZ29910', 'HP', 'Spare', 'Shelf A');

  INSERT INTO work_orders (number, instrument_id, org_id, title, severity, state, assignee, opened_on, requested_by) VALUES
    ('WO-0401', 1, 1, 'Annual PM and checkout',            'Routine',  'open',     '',    '2026-08-18', 'Rita Alvarez'),
    ('WO-0402', 2, 1, 'Replace turbo and recertify',       'Down',     'active',   'joe', '2026-08-11', 'Rita Alvarez'),
    ('WO-0403', 5, 2, 'No signal at detector',             'Down',     'waiting',  'joe', '2026-08-04', 'Sam Okafor'),
    ('WO-0404', 3, 1, 'Carryover on blank injections',     'Degraded', 'resolved', 'joe', '2026-07-28', 'Rita Alvarez'),
    ('WO-0405', 4, 2, 'Intake inspection and quote',       'Routine',  'closed',   'joe', '2026-07-14', 'Sam Okafor');

  INSERT INTO stockrooms (name, kind, keeper, location) VALUES
    ('Main stockroom', 'shop', 'joe', 'Back wall');

  INSERT INTO stock_items (stockroom_id, part_number, name, qty, min_qty, bin, unit_cost_cents) VALUES
    (1, 'G1960-80039', 'Oil mist filter',            2, 1, 'A1', 18500),
    (1, '5188-5365',   'Septa, 11 mm, 50/pk',        0, 2, 'A2', 4200),
    (1, '0100-1847',   'PTFE ferrule, 10/pk',        6, 2, 'A3', 2900),
    (1, 'ED-A72401',   'nXDS tip seal kit',          1, 1, 'B1', 21000),
    (1, 'WAT271066',   'ESI capillary',              0, 1, 'B2', 68000),
    (1, '221-48601',   'Desolvation line, LCMS-8060', 3, 1, 'B3', 45500);

  INSERT INTO purchase_orders (number, vendor, stockroom_id, org_id, status, expected_at, created_by) VALUES
    ('PO-0118', 'Agilent', 1, 1, 'sent', '2026-08-29', '${OWNER}');
  INSERT INTO po_lines (po_id, part_number, name, qty_ordered, qty_received, unit_cents) VALUES
    (1, '5188-5365', 'Septa, 11 mm, 50/pk', 4, 0, 4200),
    (1, 'G1960-80039', 'Oil mist filter', 2, 0, 18500),
    (1, 'WAT271066', 'ESI capillary', 1, 0, 68000);

  INSERT INTO agreements (org_id, kind, number, title, status, starts_on, ends_on, visits_included, parts_allowance_cents, labor_included_minutes, value_cents, created_by) VALUES
    (1, 'contract', 'AGR-2026-01', 'Lab Zen full service', 'active', '2026-01-01', '2026-12-31', 6, 500000, 4800, 3600000, '${OWNER}');

  INSERT INTO instruments (external_id, client, model, manufacturer, serial, priority, stages, archived, archived_at, archived_by) VALUES
    ('LZ-000', 'Lab Zen', 'Agilent 5975C GC-MSD', 'Agilent', 'US83221', 99, '{"Shipped"}', true, now() - interval '40 days', 'joe');

  INSERT INTO pm_schedules (instrument_id, title, assignee, every_days, next_due, last_done) VALUES
    (1, 'Quarterly source clean', 'joe', 90, to_char(now() - interval '5 days', 'YYYY-MM-DD'), to_char(now() - interval '95 days', 'YYYY-MM-DD')),
    (3, 'Annual desolvation line swap', '', 365, to_char(now() + interval '200 days', 'YYYY-MM-DD'), ''),
    (6, 'Rough pump oil change', 'joe', 180, to_char(now() + interval '20 days', 'YYYY-MM-DD'), '');

  INSERT INTO sheet_diffs (external_id, field, sheet_value, db_value) VALUES
    ('LZ-002', 'stage', 'Checkout', 'Refurbishment, System setup'),
    ('CA-001', 'notes', 'Waiting on quote approval', '');

  INSERT INTO discussion_posts (instrument_id, author, author_email, body) VALUES
    (1, 'Rita Alvarez', 'rita@labzen.test', 'Any word on the checkout date? The lab is planning validation runs.'),
    (1, 'Dev Owner', '${OWNER}', 'Tune passed this morning; sign-off packet goes out tomorrow.');

  INSERT INTO vocab_terms (kind, asset_type, name, categories) VALUES
    ('category', '', 'LC-MS', '{}'),
    ('category', '', 'GC-MS', '{}'),
    ('asset_type', '', 'Mass spec', '{}'),
    ('asset_type', '', 'Pump', '{}'),
    ('asset_type', '', 'Autosampler', '{}'),
    ('model', 'Mass spec', '6495C', '{"LC-MS"}'),
    ('model', 'Mass spec', 'LCMS-8060', '{"LC-MS"}'),
    ('model', 'Mass spec', 'ISQ 7000', '{"GC-MS"}'),
    ('model', 'Pump', '1290 Quat Pump', '{"LC-MS"}'),
    ('model', 'Autosampler', 'TriPlus RSH', '{"GC-MS"}')
    ON CONFLICT DO NOTHING;

  INSERT INTO procedures (asset_type, kind, name, notes, position, runs_at_intake, interval_days, model_scope) VALUES
    ('system', 'task', 'Incoming inspection and photos', 'Every system, on arrival.', 0, true, NULL, '{}'),
    ('system', 'test', 'Leak check', '', 1, true, NULL, '{}'),
    ('Mass spec', 'task', 'Quarterly source clean', '', 0, false, 90, '{}'),
    ('Mass spec', 'task', 'Desolvation line swap', 'LCMS-8060 only.', 1, false, 365, '{"LCMS-8060"}'),
    ('Pump', 'task', 'Seal replacement', '', 0, false, 180, '{}'),
    ('Autosampler', 'task', 'Needle and septum check', '', 0, true, NULL, '{}');

  INSERT INTO notifications (email, kind, title, href, created_at, read_at) VALUES
    ('${OWNER}', 'task_assigned', 'Rita assigned you: Replace turbo and recertify', '/work/2', now() - interval '3 hours', NULL),
    ('${OWNER}', 'discussion', 'Rita Alvarez posted on LZ-001', '/instruments/1', now() - interval '1 day', NULL),
    ('${OWNER}', 'gas_empty', 'Helium marked empty on CA-003', '/instruments/6', now() - interval '2 days', now() - interval '1 day');

  INSERT INTO message_threads (title, created_by, last_message_at) VALUES
    ('Sign-off scheduling', '${OWNER}', now() - interval '2 hours');
  INSERT INTO thread_members (thread_id, email, name, org_name, added_by) VALUES
    (1, '${OWNER}', 'Dev Owner', '', '${OWNER}'),
    (1, 'rita@labzen.test', 'Rita Alvarez', 'Lab Zen', '${OWNER}');
  INSERT INTO messages (thread_id, author_email, author_name, body) VALUES
    (1, 'rita@labzen.test', 'Rita Alvarez', 'Could we do Thursday morning for the sign-off?'),
    (1, '${OWNER}', 'Dev Owner', 'Thursday 9am works. I will bring the packet.');

  INSERT INTO folders (org_id, name) VALUES (NULL, 'Manuals');
  INSERT INTO attachments (org_id, instrument_id, asset_id, folder_id, file_name, kind, description, url, size, uploaded_by) VALUES
    (NULL, NULL, NULL, NULL, 'Site prep checklist.pdf', 'Reference', 'What a lab needs ready before install day', 'https://blob.local/site-prep.pdf', 482133, '${OWNER}'),
    (NULL, NULL, NULL, 1, '6495C site guide.pdf', 'Manual', '', 'https://blob.local/6495c-guide.pdf', 2831554, '${OWNER}'),
    (NULL, 1, NULL, NULL, 'Reserpine tune report.pdf', 'Report', 'Post-PM verification', 'https://blob.local/tune-report.pdf', 194227, 'rita@labzen.test'),
    (NULL, 2, NULL, NULL, 'Turbo swap photos.zip', 'Other', '', 'https://blob.local/turbo-photos.zip', 8112003, '${OWNER}');

  INSERT INTO engagement_records (instrument_id, org_id, kind, external_id, label, revoked_by, revoked_at, data) VALUES
    (NULL, 1, 'revoked', 'LZ-000', 'GC-MS - 8890 GC', '${OWNER}', now() - interval '30 days', '${JSON.stringify({
      version: 1,
      system: { externalId: "LZ-000", client: "Lab Zen", category: "GC-MS", location: "Annex bench 2", lead: "Rita Alvarez", notes: "Decommissioned unit kept for parts.", stages: ["Decommissioned"] },
      label: "GC-MS - 8890 GC",
      assets: [{ kind: "GC", model: "8890 GC", serial: "GC-0090", manufacturer: "Agilent", status: "Decommissioned", asFound: "", note: "" }],
      gases: [{ gas: "Helium", status: "OK", note: "" }],
      tasks: [{ title: "Final decontamination wipe-down", body: "", state: "Done", assignee: "Rita Alvarez", dueDate: "", origin: "", createdAt: "2026-06-20T15:00:00Z", completedAt: "2026-06-21T18:00:00Z", checklist: [], notes: [] }],
      parts: [{ kind: "part", name: "Inlet liner", partNumber: "5190-2293", serial: "", qty: "1", specs: "", vendor: "Agilent", status: "Installed", installedAt: "2026-05-02", removedAt: "", note: "", createdAt: "2026-05-02T12:00:00Z" }],
      attachments: [],
      discussion: [{ author: "Rita Alvarez", body: "Confirming the unit is off the books.", createdAt: "2026-06-21T19:00:00Z" }],
      activity: [{ actor: "Dev Owner", action: "archived", field: "", newValue: "", createdAt: "2026-06-22T09:00:00Z" }],
    })}'::jsonb);
`;

async function seed() {
  const { PGlite } = await import("@electric-sql/pglite");
  const pg = new PGlite(DATA_DIR);
  await pg.exec(readFileSync("drizzle/schema-sync.sql", "utf8"));
  const seeded = await pg.query("SELECT 1 FROM orgs LIMIT 1");
  if (seeded.rows.length === 0) {
    await pg.exec(FIXTURE);
    console.log("[dev:local] seeded fixture (2 orgs, 6 systems, 10 assets, 5 WOs, 1 PO, 1 stockroom)");
  } else {
    console.log("[dev:local] existing data kept - delete the data dir to reseed");
  }
  await pg.close();
}

async function main() {
  console.log(`[dev:local] database: ${DATA_DIR}`);
  await seed();
  console.log(`[dev:local] session cookie: authjs.session-token=devtoken (owner ${OWNER})`);
  const child = spawn("npx", ["next", "dev", "-p", PORT], {
    stdio: "inherit",
    env: {
      ...process.env,
      LOCAL_DB: "1",
      PGLITE_DIR: DATA_DIR,
      AUTH_SECRET: process.env.AUTH_SECRET || "dev-local-secret-not-for-production",
      STAFF_EMAILS: process.env.STAFF_EMAILS || OWNER,
      EMAIL_FROM: process.env.EMAIL_FROM || OWNER,
    },
  });
  child.on("exit", (code) => process.exit(code ?? 0));
}

main().catch((e) => { console.error(e); process.exit(1); });
