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
    ('Coastal Analytical', 'client'),
    -- The company that does the work. Its own organization, like any other -
    -- that is what makes an invoice carry ITS name rather than the platform's.
    ('Sierra Spectra', 'provider'),
    -- Last on purpose: the ids above are referenced by number further down.
    -- A client with nothing of theirs on our bench, so the EOD page has to
    -- prove it can report a day whose only work was a phone call. Before
    -- off-system lines a client like this had no report at all.
    ('Harbor Biotech', 'client');
  UPDATE orgs SET is_operator = true WHERE name = 'Sierra Spectra';
  UPDATE app_settings SET operator_org_id = (SELECT id FROM orgs WHERE name = 'Sierra Spectra') WHERE id = 1;
  UPDATE app_settings SET public_contact_email = 'hello@ridgelinefield.test' WHERE id = 1;

  INSERT INTO users (id, name, email, role, onboarded_at) VALUES
    ('dev-user', 'Dev Owner', '${OWNER}', 'owner', now()),
    ('dev-new', '', 'new@local.test', 'tech', NULL);
  INSERT INTO sessions (session_token, user_id, expires) VALUES
    ('devtoken', 'dev-user', now() + interval '30 days'),
    ('newtoken', 'dev-new', now() + interval '30 days');

  -- The directory is assembled from these, never typed in: staff are house
  -- members of the operator, clients are allowlist rows on their org.
  INSERT INTO house_members (email, org_id, role, name) VALUES
    ('${OWNER}', 3, 'owner', 'Dev Owner'),
    ('sam@sierraspectra.test', 3, 'staff', 'Sam Ortiz'),
    ('bill@sierraspectra.test', 3, 'staff', 'Bill Reyes');
  INSERT INTO client_allowlist (entry, org_id, can_edit) VALUES
    ('maria@labzen.test', 1, true),
    ('accounts@coastal.test', 2, false);
  -- Role and org resolve at session time from the allowlist row above.
  INSERT INTO users (id, name, email, role, onboarded_at) VALUES
    ('dev-maria', 'Maria Chen', 'maria@labzen.test', 'client_editor', now());
  INSERT INTO sessions (session_token, user_id, expires) VALUES
    ('clienttoken', 'dev-maria', now() + interval '30 days');

  INSERT INTO instruments (external_id, client, model, manufacturer, serial, priority, stages, notes) VALUES
    ('LZ-001', 'Lab Zen', 'Agilent 6495C LC-MS', 'Agilent', 'US2405111', 1, '{"Checkout"}', 'Reserpine test and tune.'),
    ('LZ-002', 'Lab Zen', 'Thermo ISQ 7000 GC-MS', 'Thermo', 'ISQ70233', 2, '{"Refurbishment","System setup"}', 'Turbo replaced, pumping down.'),
    ('LZ-003', 'Lab Zen', 'Shimadzu LCMS-8060', 'Shimadzu', 'SH806014', 3, '{"Sign-off"}', 'Awaiting client sign-off.'),
    ('CA-001', 'Coastal Analytical', 'PerkinElmer Optima 8300 ICP-OES', 'PerkinElmer', 'PE83007', 4, '{"Intake"}', ''),
    ('CA-002', 'Coastal Analytical', 'Agilent 7890B GC', 'Agilent', 'CN14320', 5, '{"Waiting / blocked"}', 'HED fault - part on order.'),
    ('CA-003', 'Coastal Analytical', 'Waters Xevo TQ-S', 'Waters', 'WAT5521', 6, '{"In service"}', '');

  -- Work with no system behind it: a LabZen engineer rang and got talked
  -- through a problem. It belongs on their report and nowhere else in the app
  -- could hold it, which is the whole point of the row.
  INSERT INTO eod_updates (instrument_id, asset_id, date, owner_org_id, title, person, minutes,
                           system_update, action_item, updated_by)
  SELECT NULL, NULL, to_char(now(), 'YYYY-MM-DD'), o.id,
         'Phone support - tune report question', 'Bill Reyes', 35,
         'Their engineer called about a failing reserpine tune. Walked through the report: source was fine, the carrier gas regulator was drifting.',
         'Send them the regulator check SOP',
         'dev@local.test'
  FROM orgs o WHERE o.name = 'Lab Zen';

  INSERT INTO eod_updates (instrument_id, asset_id, date, owner_org_id, title, person, minutes,
                           system_update, action_item, updated_by)
  SELECT NULL, NULL, to_char(now(), 'YYYY-MM-DD'), o.id,
         'Method advice - headspace carryover', 'Bill Reyes', 20,
         'Talked their chemist through a carryover problem on a headspace method. Nothing of theirs is with us.',
         '', 'dev@local.test'
  FROM orgs o WHERE o.name = 'Harbor Biotech';

  -- Blocking is the one stage that demands a written reason, so the fixture's
  -- blocked system carries one - and an age, so the board can say how long.
  UPDATE instruments
     SET blocked_reason = 'Waiting on HED board from Agilent - no ETA.',
         blocked_since  = now() - interval '12 days'
   WHERE external_id = 'CA-002';

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
    ('WO-0405', 4, 2, 'Intake inspection and quote',       'Routine',  'closed',   'joe', '2026-07-14', 'Sam Okafor'),
    -- Two closed jobs with nothing billed against them: the leak the Billing
    -- overview exists to show. One is covered (the $0 invoice that still
    -- documents the visit), one is straight time and materials.
    ('WO-0406', 3, 1, 'Quarterly PM, visit 6 of 6',        'Routine',  'closed',   'joe', '2026-08-05', 'Rita Alvarez'),
    ('WO-0407', 5, 2, 'ICP-OES ignition fault',            'Down',     'closed',   'joe', '2026-07-30', 'Sam Okafor');
  UPDATE work_orders SET closed_at = now() - interval '9 days',
    close_summary = 'Intake inspection done, quote sent.' WHERE number = 'WO-0405';
  UPDATE work_orders SET closed_at = now() - interval '3 days',
    close_summary = 'PM run to the checklist; all readings in band.' WHERE number = 'WO-0406';
  UPDATE work_orders SET closed_at = now() - interval '6 days',
    close_summary = 'Torch and injector replaced, ignition verified.' WHERE number = 'WO-0407';

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
    (1, 'contract', 'AGR-2026-01', 'Lab Zen full service', 'active', '2026-01-01', '2026-12-31', 6, 500000, 4800, 3600000, '${OWNER}'),
    -- A second contract inside its 60-day notice window, so the renewals cron
    -- has something to draft against and the Contracts screen shows what a
    -- term coming to an end looks like.
    (1, 'contract', 'AGR-2025-04', 'Lab Zen GC-MS coverage', 'active',
      to_char(now() - interval '320 days', 'YYYY-MM-DD'),
      to_char(now() + interval '39 days', 'YYYY-MM-DD'), 4, 250000, 2400, 1800000, '${OWNER}');

  -- ── Billing ───────────────────────────────────────────────────────────────
  -- Three rungs of rate card so resolveRate's precedence is visible in the app:
  -- the agreement wins for Lab Zen contract work, the org card covers Lab Zen's
  -- uncovered hours, and the platform default (both ids null) catches everyone
  -- else - Coastal Analytical bills off it.
  INSERT INTO rate_cards (org_id, agreement_id, hourly_cents, after_hours_pct, travel_pct, min_increment_min, label, created_by) VALUES
    (NULL, NULL, 16500, 150, 50, 15, 'Standard field service', '${OWNER}'),
    (1, NULL, 15500, 150, 50, 15, 'Lab Zen negotiated', '${OWNER}'),
    (1, 1, 14000, 125, 0, 30, 'AGR-2026-01 contract rate', '${OWNER}');

  -- Expenses on the turbo job, one of each shape that reads differently on an
  -- invoice: a mileage line, freight, and a bare "other" with the description
  -- doing the work.
  INSERT INTO expenses (work_order_id, kind, description, amount_cents, incurred_on, logged_by) VALUES
    (2, 'mileage', '84 miles round trip at 0.67', 5628, to_char(now() - interval '5 days', 'YYYY-MM-DD'), '${OWNER}'),
    (2, 'shipping', 'Overnight freight, turbo from Edwards', 21400, to_char(now() - interval '6 days', 'YYYY-MM-DD'), '${OWNER}'),
    (2, 'other', 'Crane rental, half day', 45000, to_char(now() - interval '5 days', 'YYYY-MM-DD'), 'Sam Ortiz'),
    (7, 'mileage', '212 miles round trip at 0.67', 14204, to_char(now() - interval '6 days', 'YYYY-MM-DD'), '${OWNER}');

  -- Lab Zen pays on paper and has a live PO with room on it. Coastal has no PO
  -- at all and a punitive policy - short grace, a flat late fee, a hold that
  -- trips early - so the credit-hold and dunning paths have something to fire
  -- on without editing settings by hand.
  UPDATE orgs SET terms_days = 30, ap_email = 'ap@labzen.test',
    po_number = 'PO-88213', po_balance_cents = 1200000 WHERE id = 1;
  UPDATE orgs SET terms_days = 15, ap_email = 'accounts@coastal.test',
    po_number = '', po_balance_cents = 0,
    billing_policy = '{"graceDays":3,"feeType":"flat","flatCents":7500,"appliesTo":"all","holdDays":20,"holdAmountCents":50000,"dunningAuto":true,"taxParts":true}'::jsonb
    WHERE id = 2;

  -- Two sites so parts tax has an address to belong to: Lab Zen's bench is in a
  -- taxing county, Coastal's dock is not.
  -- The parts book the store sells from. Models match Lab Zen's bench so the
  -- "For your systems" facet has something to say; one row has no price so
  -- "priced on request" renders too.
  INSERT INTO part_catalog (part_number, name, manufacturer, kind, asset_types, models, created_by) VALUES
    ('5188-5365', 'Septa, 11 mm, 50/pk',      'Agilent', 'consumable', '{"GC"}', '{"7890B"}', 'dev@local.test'),
    ('G1960-80039', 'Oil mist filter',        'Agilent', 'part', '{"Vacuum pump"}', '{}', 'dev@local.test'),
    ('WAT271066', 'ESI capillary',            'Waters',  'part', '{"Mass spec"}', '{"6495C"}', 'dev@local.test'),
    ('ED-A72401', 'nXDS tip seal kit',        'Edwards', 'kit',  '{"Vacuum pump"}', '{"Edwards nXDS10i"}', 'dev@local.test'),
    ('228-45703-91', 'LC-30 plunger seal',    'Shimadzu','consumable', '{"Pump"}', '{"LC-30AD"}', 'dev@local.test');

  -- Photos on two rows, so the shelf thumbnail and the part page's hero and
  -- thumbnail strip have something to show. Inline SVG: no blob store to run.
  INSERT INTO part_photos (catalog_id, url, caption, sort_order, uploaded_by)
  SELECT c.id, p.url, p.caption, p.ord, 'dev@local.test'
  FROM part_catalog c JOIN (VALUES
    ('WAT271066', 'data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" width="480" height="320"><rect width="480" height="320" fill="%23DCE6F2"/><text x="240" y="170" font-family="sans-serif" font-size="28" fill="%231B2A44" text-anchor="middle">ESI capillary</text></svg>', 'The capillary', 1),
    ('WAT271066', 'data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" width="320" height="320"><rect width="320" height="320" fill="%23EEF3F9"/><text x="160" y="170" font-family="sans-serif" font-size="22" fill="%231B2A44" text-anchor="middle">Label</text></svg>', 'The label', 2),
    ('5188-5365', 'data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" width="480" height="320"><rect width="480" height="320" fill="%23E7F0E8"/><text x="240" y="170" font-family="sans-serif" font-size="28" fill="%231B2A44" text-anchor="middle">Septa, 50/pk</text></svg>', 'The pack', 1)
  ) AS p(pn, url, caption, ord) ON p.pn = c.part_number;

  -- What the tip seal kit is made of, so the part page's kit panel has rows -
  -- one of them a number the shelf also sells on its own, for the cross-link.
  INSERT INTO part_kit_lines (kit_id, part_number, name, qty, sort_order)
  SELECT c.id, k.pn, k.name, k.qty, k.ord
  FROM part_catalog c JOIN (VALUES
    ('G1960-80039', 'Oil mist filter', 1, 1),
    ('ED-A70501',   'Tip seal, pair',  2, 2),
    ('ED-A70502',   'O-ring set',      1, 3)
  ) AS k(pn, name, qty, ord) ON TRUE
  WHERE c.part_number = 'ED-A72401';

  -- Vendor offers with the sourcing facts, arranged so cheapest and fastest
  -- disagree: the OEM is quick but must cross-dock; the reseller drop-ships.
  INSERT INTO part_prices (part_number, vendor, is_oem, price_cents, lead_days, drop_ships, expedite_ok, url, updated_by) VALUES
    ('5188-5365', 'Agilent',        true,  5200, 2, false, true,  '', 'dev@local.test'),
    ('5188-5365', 'Frit & Ferrule', false, 3900, 3, true,  true,  '', 'dev@local.test'),
    ('WAT271066', 'Waters',         true,  71000, 5, false, false, '', 'dev@local.test'),
    ('WAT271066', 'Frit & Ferrule', false, 64000, 2, true,  true,  '', 'dev@local.test'),
    ('ED-A72401', 'Edwards',        true,  23500, 10, false, false, '', 'dev@local.test');
  -- One price nobody has confirmed in an age, for the stale pill.
  UPDATE part_prices SET updated_at = now() - interval '120 days' WHERE part_number = 'ED-A72401';

  INSERT INTO org_sites (org_id, name, address, contact_name, created_by) VALUES
    (1, 'Lab Zen - Building C', '1400 Harbor Way, Richmond, CA 94804', 'Rita Alvarez', '${OWNER}'),
    (2, 'Coastal Analytical - Dock 2', '88 Pier Road, Astoria, OR 97103', 'Sam Okafor', '${OWNER}');
  UPDATE org_sites SET tax_rate_bps = 1025 WHERE org_id = 1;

  -- Three invoices so /money has an open one, an overdue one and a settled
  -- one, and so the $0 covered invoice is on screen rather than only in a test.
  INSERT INTO invoices (org_id, work_order_id, agreement_id, number, status, issued_on, due_on, po_number, created_by) VALUES
    (1, 3, NULL, 'INV-0091', 'paid',  to_char(now() - interval '38 days', 'YYYY-MM-DD'), to_char(now() - interval '8 days', 'YYYY-MM-DD'), 'PO-88213', '${OWNER}'),
    (1, 2, 1,    'INV-0092', 'sent',  to_char(now() - interval '9 days', 'YYYY-MM-DD'),  to_char(now() + interval '21 days', 'YYYY-MM-DD'), 'PO-88213', '${OWNER}'),
    (2, 5, NULL, 'INV-0087', 'sent',  to_char(now() - interval '72 days', 'YYYY-MM-DD'), to_char(now() - interval '42 days', 'YYYY-MM-DD'), '', '${OWNER}');
  INSERT INTO invoice_lines (invoice_id, kind, description, detail, qty, unit_cents, covered, covered_by, position) VALUES
    (1, 'labor', 'Labor, on site - Dev Owner', 'Tune and verify', 3000, 15500, false, '', 0),
    (1, 'part', 'G7100-60001 Capillary kit', 'price book, 30% markup', 1000, 27300, false, '', 1),
    (2, 'labor', 'Labor, on site - Dev Owner', 'Turbo replacement', 7000, 14000, true, 'AGR-2026-01', 0),
    (2, 'travel', 'Travel - Sam Ortiz', '', 4000, 0, true, 'AGR-2026-01', 1),
    (2, 'part', 'EXT255H Turbo pump', 'drawn from the parts allowance', 1000, 630500, true, 'AGR-2026-01', 2),
    (2, 'expense', 'Crane rental, half day', '', 1000, 45000, false, '', 3),
    (3, 'part', '05971-80059 HED supply', '', 1000, 390000, false, '', 0),
    (3, 'labor', 'Labor, on site - Sam Ortiz', 'Intake inspection', 2000, 19500, false, '', 1);
  INSERT INTO payments (invoice_id, method, amount_cents, reference, received_on, recorded_by) VALUES
    (1, 'check', 73800, '4417', to_char(now() - interval '12 days', 'YYYY-MM-DD'), '${OWNER}');

  -- The $0 invoice, which is a feature: WO-0406's PM was covered end to end,
  -- and the bill still goes out so the visit is on the record and the client
  -- can see the contract working.
  INSERT INTO invoices (org_id, work_order_id, agreement_id, number, status, issued_on, due_on, po_number, note, created_by) VALUES
    (1, 6, 1, 'INV-0093', 'sent', to_char(now() - interval '2 days', 'YYYY-MM-DD'),
      to_char(now() + interval '28 days', 'YYYY-MM-DD'), 'PO-88213',
      'Covered under AGR-2026-01 - nothing to pay.', '${OWNER}');
  INSERT INTO invoice_lines (invoice_id, kind, description, detail, qty, unit_cents, covered, covered_by, position) VALUES
    (4, 'labor', 'Labor, on site - Dev Owner', 'Quarterly PM', 4000, 15500, true, 'AGR-2026-01', 0),
    (4, 'part', 'SH-DL-8060 Desolvation line', 'drawn from the parts allowance', 1000, 83200, true, 'AGR-2026-01', 1);

  -- The live link the client reads INV-0092 through, already opened twice:
  -- the Viewed line on the invoice timeline comes off this row.
  INSERT INTO share_links (token, kind, org_id, invoice_id, label, expires_on, created_by, opened_at, last_opened_at, open_count) VALUES
    ('devinvoicetoken12345', 'invoice', 1, 2, 'Invoice INV-0092',
      to_char(now() + interval '300 days', 'YYYY-MM-DD'), '${OWNER}',
      now() - interval '8 days', now() - interval '6 days', 2);

  -- Collections: the Coastal invoice is 42 days past due, has been up three
  -- rungs of the ladder, carries a posted fee, a promise that was broken, and
  -- a disputed line on the Lab Zen invoice so the pause is visible somewhere.
  INSERT INTO dunning_events (invoice_id, rung, to_name, to_email, sent_by, sent_on) VALUES
    (3, 'nudge', 'K. Osei', 'k.osei@coastal.test', 'auto', to_char(now() - interval '49 days', 'YYYY-MM-DD')),
    (3, 'due', 'K. Osei', 'k.osei@coastal.test', 'auto', to_char(now() - interval '42 days', 'YYYY-MM-DD')),
    (3, 'statement', 'K. Osei', 'accounts@coastal.test', 'auto', to_char(now() - interval '27 days', 'YYYY-MM-DD'));
  INSERT INTO invoice_fees (invoice_id, amount_cents, basis, posted_on, posted_by) VALUES
    (3, 5800, '1.50% per month on $3,900 undisputed, 39 days past the 3-day grace period.',
      to_char(now() - interval '11 days', 'YYYY-MM-DD'), '${OWNER}');
  INSERT INTO promises (invoice_id, promised_on, by_name, note, logged_by) VALUES
    (3, to_char(now() - interval '2 days', 'YYYY-MM-DD'), 'K. Osei', 'Check going out Friday', '${OWNER}');
  INSERT INTO disputes (invoice_id, line_id, reason, opened_on, opened_by) VALUES
    (2, 6, 'Adam: thought the crane was inside the retainer',
      to_char(now() - interval '3 days', 'YYYY-MM-DD'), '${OWNER}');

  -- Coastal's escalation contacts, so the ladder names a new person at each
  -- rung instead of mailing the same desk seven times.
  UPDATE orgs SET billing_policy = jsonb_set(billing_policy, '{escalation}', '[
    {"name":"K. Osei","role":"Lab manager","email":"k.osei@coastal.test"},
    {"name":"R. Chen","role":"Purchasing director","email":"r.chen@coastal.test"},
    {"name":"M. Vance","role":"Controller","email":"m.vance@coastal.test"}
  ]'::jsonb) WHERE id = 2;

  -- What an hour costs the shop, so the job-cost panel has a margin to show
  -- instead of saying nobody has told it.
  UPDATE app_settings SET loaded_labor_cents = 9500 WHERE id = 1;

  -- Coastal's reminders go out THIS hour, so the dunning cron can be run by
  -- hand the moment the harness boots instead of at seven tomorrow morning.
  -- Everyone else keeps the ordinary 7am.
  UPDATE orgs SET digest_hour = EXTRACT(hour FROM now() AT TIME ZONE 'America/Los_Angeles')::int
    WHERE id = 2;

  -- A quote out with the client, viewed twice and a week from lapsing, so the
  -- portal's approve path and the digest's "unanswered" line both have a row.
  -- WO-0401 waits on it; approving moves that job to active.
  UPDATE work_orders SET state = 'waiting' WHERE number = 'WO-0401';
  INSERT INTO quotes (org_id, work_order_id, number, status, title, sent_on, expires_on, deposit_pct, created_by) VALUES
    (1, 1, 'Q-1001', 'sent', 'Annual PM and checkout',
      to_char(now() - interval '4 days', 'YYYY-MM-DD'),
      to_char(now() + interval '5 days', 'YYYY-MM-DD'), 50, '${OWNER}');
  INSERT INTO quote_lines (quote_id, kind, description, detail, qty, unit_cents, position) VALUES
    (1, 'part', 'G7100-60001 Capillary kit', 'price book, 30% markup', 1000, 27300, 0),
    (1, 'labor', 'Labor, on site', 'estimated 6.0 h at the Lab Zen rate card', 6000, 15500, 1),
    (1, 'travel', 'Travel', 'half rate', 1000, 7750, 2);
  -- The overdue Coastal bill, as the client sees it: three reminders have
  -- pointed at this link, and its view receipts are what the demand letter
  -- cites when it says the invoice was opened.
  INSERT INTO share_links (token, kind, org_id, invoice_id, label, expires_on, created_by, opened_at, last_opened_at, open_count) VALUES
    ('devoverduetoken12345', 'invoice', 2, 3, 'Invoice INV-0087',
      to_char(now() + interval '250 days', 'YYYY-MM-DD'), '${OWNER}',
      now() - interval '71 days', now() - interval '27 days', 4);

  INSERT INTO share_links (token, kind, org_id, quote_id, label, expires_on, created_by, opened_at, last_opened_at, open_count) VALUES
    ('devquotetoken123456', 'quote', 1, 1, 'Quote Q-1001',
      to_char(now() + interval '35 days', 'YYYY-MM-DD'), '${OWNER}',
      now() - interval '4 days', now() - interval '2 days', 2);

  -- Everything billing belongs to the operator's workspace, which is what lets
  -- an invoice resolve THEIR letterhead and THEIR Stripe account.
  UPDATE invoices SET tenant_org_id = 3;
  UPDATE quotes SET tenant_org_id = 3;
  UPDATE payments SET tenant_org_id = 3;
  UPDATE invoice_fees SET tenant_org_id = 3;
  UPDATE promises SET tenant_org_id = 3;
  UPDATE disputes SET tenant_org_id = 3;
  UPDATE dunning_events SET tenant_org_id = 3;
  UPDATE share_links SET tenant_org_id = 3 WHERE kind <> 'files';

  -- A Stripe account in TEST MODE, so the portal's pay buttons render against
  -- the harness. Fixture only, and obviously fake: nothing here can move money.
  UPDATE orgs SET stripe_account_id = 'acct_devlocaltest0001', stripe_ready = true
    WHERE id = 3;
  UPDATE instruments SET site_id = 1 WHERE client = 'Lab Zen';
  UPDATE instruments SET site_id = 2 WHERE client = 'Coastal Analytical';

  INSERT INTO instruments (external_id, client, model, manufacturer, serial, priority, stages, archived, archived_at, archived_by) VALUES
    ('LZ-000', 'Lab Zen', 'Agilent 5975C GC-MSD', 'Agilent', 'US83221', 99, '{"Shipped"}', true, now() - interval '40 days', 'joe');

  -- Whose systems these are. Without it nothing draws down against a
  -- contract - lib/agreementUsage counts by owner_org_id, not by the client
  -- name on the row - and the whole entitlement half of the app reads empty.
  UPDATE instruments SET owner_org_id = 1 WHERE client = 'Lab Zen';
  UPDATE instruments SET owner_org_id = 2 WHERE client = 'Coastal Analytical';
  -- Parts follow whose money bought them, stamped at purchase - that is what
  -- lib/agreementUsage draws a parts allowance down against.
  UPDATE parts SET owner_org_id = i.owner_org_id FROM instruments i
    WHERE parts.instrument_id = i.id;


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
  UPDATE vocab_terms SET manufacturer = 'Agilent',
    specs = '[{"name":"Mass range","value":"5-1400 m/z"},{"name":"Scan speed","value":"5000 Da/s"},{"name":"Polarity switching","value":"20 ms"}]'
    WHERE kind = 'model' AND name = '6495C';

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

  INSERT INTO time_entries (instrument_id, person, date, minutes, note, logged_by, work_order_id) VALUES
    (1, 'Dev Owner', to_char(now() - interval '2 days', 'YYYY-MM-DD'), 180, 'Tune and verify', '${OWNER}', NULL),
    (2, 'Dev Owner', to_char(now() - interval '5 days', 'YYYY-MM-DD'), 420, 'Turbo replacement', '${OWNER}', 2),
    (2, 'Sam Ortiz', to_char(now() - interval '4 days', 'YYYY-MM-DD'), 240, 'Pump-down watch', '${OWNER}', 2),
    (4, 'Sam Ortiz', to_char(now() - interval '9 days', 'YYYY-MM-DD'), 120, 'Intake inspection', '${OWNER}', NULL),
    (3, 'Dev Owner', to_char(now() - interval '3 days', 'YYYY-MM-DD'), 240, 'Quarterly PM', '${OWNER}', 6),
    (5, 'Dev Owner', to_char(now() - interval '6 days', 'YYYY-MM-DD'), 540, 'Torch and injector', '${OWNER}', 7),
    (5, 'Dev Owner', to_char(now() - interval '6 days', 'YYYY-MM-DD'), 90,  'Drive to Astoria',  '${OWNER}', 7);

  -- Hours that are not all alike: travel and remote next to onsite, and one
  -- entry already marked not billable because the agreement covers it.
  UPDATE time_entries SET category = 'travel', billable = true WHERE id = 3;
  UPDATE time_entries SET category = 'onsite', billable = false WHERE id = 2;
  UPDATE time_entries SET category = 'remote' WHERE id = 4;
  UPDATE time_entries SET category = 'travel' WHERE id = 7;

  INSERT INTO parts (instrument_id, name, part_number, vendor, cost, cost_cents, status, installed_at) VALUES
    (2, 'Turbo pump', 'EXT255H', 'Edwards', '$4,850.00', 485000, 'Installed', to_char(now() - interval '5 days', 'YYYY-MM-DD')),
    (1, 'Capillary kit', 'G7100-60001', 'Agilent', '$210.00', 21000, 'Installed', to_char(now() - interval '2 days', 'YYYY-MM-DD')),
    (5, 'HED supply', '05971-80059', 'Agilent', 'call for quote', NULL, 'Ordered', '');
  INSERT INTO parts (instrument_id, work_order_id, name, part_number, vendor, cost, cost_cents, status, installed_at) VALUES
    (3, 6, 'Desolvation line', 'SH-DL-8060', 'Shimadzu', '$640.00', 64000, 'Installed', to_char(now() - interval '3 days', 'YYYY-MM-DD')),
    (5, 7, 'Torch, quartz', 'N0790456', 'PerkinElmer', '$1,180.00', 118000, 'Installed', to_char(now() - interval '6 days', 'YYYY-MM-DD'));

  INSERT INTO folders (org_id, name) VALUES (NULL, 'Manuals');
  INSERT INTO attachments (org_id, instrument_id, asset_id, folder_id, file_name, kind, description, url, size, uploaded_by) VALUES
    (NULL, NULL, NULL, NULL, 'Site prep checklist.pdf', 'Reference', 'What a lab needs ready before install day', 'https://blob.local/site-prep.pdf', 482133, '${OWNER}'),
    (NULL, NULL, NULL, 1, '6495C site guide.pdf', 'Manual', '', 'https://blob.local/6495c-guide.pdf', 2831554, '${OWNER}'),
    (NULL, 1, NULL, NULL, 'Reserpine tune report.pdf', 'Report', 'Post-PM verification', 'https://blob.local/tune-report.pdf', 194227, 'rita@labzen.test'),
    (NULL, 2, NULL, NULL, 'Turbo swap photos.zip', 'Other', '', 'https://blob.local/turbo-photos.zip', 8112003, '${OWNER}');

  INSERT INTO drop_links (org_id, folder_id, token, label, expires_on, created_by) VALUES
    (1, NULL, 'devdroptoken12345678', 'Method files from Rita', to_char(now() + interval '14 days', 'YYYY-MM-DD'), '${OWNER}');

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
    console.log("[dev:local] seeded fixture (1 operator + 2 clients, 6 systems, 10 assets, 7 WOs, 1 PO, 1 stockroom, 4 invoices, 1 quote)");
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
      // So the cron routes can be run by hand against the throwaway database:
      //   curl -H "Authorization: Bearer dev-local-cron" localhost:3100/api/cron/dunning
      CRON_SECRET: process.env.CRON_SECRET || "dev-local-cron",
      // Stripe, if the shell has it. Absent is the ordinary case and a
      // supported one: the pay buttons do not render and the portal explains
      // how to send a check. Set a TEST key to exercise the other path.
      ...(process.env.STRIPE_SECRET_KEY ? { STRIPE_SECRET_KEY: process.env.STRIPE_SECRET_KEY } : {}),
      ...(process.env.STRIPE_WEBHOOK_SECRET ? { STRIPE_WEBHOOK_SECRET: process.env.STRIPE_WEBHOOK_SECRET } : {}),
    },
  });
  child.on("exit", (code) => process.exit(code ?? 0));
}

main().catch((e) => { console.error(e); process.exit(1); });
