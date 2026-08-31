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
import { STARTER_CATEGORIES } from "../src/lib/expenseCategories";
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

  -- A second service company on the instance, listed in the directory, so the
  -- network page has somebody to find and a client has somewhere to be handed
  -- (see lib/clientShare). Its own workspace: is_operator, no parent.
  INSERT INTO orgs (id, name, kind, is_operator) VALUES
    (30, 'Northwest Instrument Services', 'provider', true) ON CONFLICT DO NOTHING;
  INSERT INTO provider_profiles (org_id, listed, blurb, services, regions, contact_name, contact_email, website)
    VALUES (30, true, 'Sciex and Agilent specialists, 20 years on triple quads.',
      '{"LC-MS","GC-MS","Dissolution"}', '{"Seattle metro","WA","OR"}',
      'Dana Whitfield', 'dana@nwinstrument.test', 'nwinstrument.test')
    ON CONFLICT DO NOTHING;

  -- A THIRD shop, and the state that has no other way of being looked at: one
  -- that arrived by accepting a hand-off rather than by being sold to. Free
  -- tier, holding the single client it was handed - so the wall, the plan pill
  -- on the tenant console and what a limited workspace actually feels like are
  -- all reachable locally. See lib/plan.
  INSERT INTO orgs (id, name, kind, is_operator, plan, plan_since) VALUES
    (40, 'Cascade Instrument Works', 'provider', true, 'free', to_char(now() - interval '9 days', 'YYYY-MM-DD'));
  INSERT INTO orgs (id, name, kind, parent_org_id) VALUES
    (41, 'Puget Diagnostics', 'client', 40);
  INSERT INTO instruments (external_id, client, model, manufacturer, serial, owner_org_id, tenant_org_id, source_ref, notes)
    VALUES ('CIW-001', 'Puget Diagnostics', 'Agilent 6470 LC-MS', 'Agilent', 'US2409881', 41, 40,
      'SS-014', 'Copied from Sierra Spectra on handover - this snapshot does not update.');

  UPDATE app_settings SET operator_org_id = (SELECT id FROM orgs WHERE name = 'Sierra Spectra') WHERE id = 1;
  UPDATE app_settings SET public_contact_email = 'hello@ridgelinefield.test' WHERE id = 1;
  -- The trail on, so the fixture exercises what a problem report ATTACHES:
  -- with it off there are no breadcrumbs to freeze, and the half of a bug
  -- report that makes it actionable never gets driven locally.
  UPDATE app_settings SET trail_enabled = true WHERE id = 1;
  -- The starter expense vocabulary, exactly as createOperator seeds it - the
  -- fixture must eat what production cooks.
  INSERT INTO expense_categories (tenant_org_id, name, sort_order, created_by)
  SELECT (SELECT id FROM orgs WHERE name = 'Sierra Spectra'), v.name, v.ord, '${OWNER}'
  FROM (VALUES ${STARTER_CATEGORIES.map((n, i) => `('${n.replace(/'/g, "''")}', ${i + 1})`).join(", ")}) AS v(name, ord);

  -- The travel rulebook the WO expense panel applies: 80 mi stipend radius,
  -- $30 day per diem beyond it, $65/night stepping to $85 after 3, $180 rooms.
  UPDATE app_settings SET expense_policy =
    '{"radiusMiles":80,"dayPerDiemCents":3000,"overnightPerDiemCents":6500,"extendedAfterNights":3,"overnightExtendedCents":8500,"hotelNightCapCents":18000}'
    WHERE id = 1;

  INSERT INTO users (id, name, email, role, onboarded_at) VALUES
    ('dev-user', 'Dev Owner', '${OWNER}', 'owner', now()),
    -- A staff account that is NOT the owner. Half the permission rules in this
    -- app run between those two - payroll, the books, who may read what a job
    -- billed - and none of them can be checked from an owner session.
    ('dev-bill', 'Bill Reyes', 'bill@sierraspectra.test', 'staff', now()),
    ('dev-new', '', 'new@local.test', 'tech', NULL),
    -- The OTHER service company's owner. Half of what the network is for can
    -- only be checked from a second workspace: a client handed over has to be
    -- accepted by somebody who is not us.
    ('dev-dana', 'Dana Whitfield', 'dana@nwinstrument.test', 'owner', now()),
    -- The owner of the shop that came in through a hand-off. Signing in as her
    -- is the only way to see a free workspace from the inside.
    ('dev-cass', 'Cass Ibarra', 'cass@cascadeworks.test', 'owner', now());
  INSERT INTO sessions (session_token, user_id, expires) VALUES
    ('devtoken', 'dev-user', now() + interval '30 days'),
    ('stafftoken', 'dev-bill', now() + interval '30 days'),
    ('newtoken', 'dev-new', now() + interval '30 days'),
    ('danatoken', 'dev-dana', now() + interval '30 days'),
    ('freetoken', 'dev-cass', now() + interval '30 days');

  -- The directory is assembled from these, never typed in: staff are house
  -- members of the operator, clients are allowlist rows on their org.
  INSERT INTO house_members (email, org_id, role, name) VALUES
    ('${OWNER}', 3, 'owner', 'Dev Owner'),
    ('sam@sierraspectra.test', 3, 'staff', 'Sam Ortiz'),
    ('bill@sierraspectra.test', 3, 'staff', 'Bill Reyes'),
    -- The other shop's owner, so a handed-over client has somebody to accept it.
    ('dana@nwinstrument.test', 30, 'owner', 'Dana Whitfield'),
    ('cass@cascadeworks.test', 40, 'owner', 'Cass Ibarra');
  INSERT INTO client_allowlist (entry, org_id, can_edit) VALUES
    ('maria@labzen.test', 1, true),
    ('accounts@coastal.test', 2, false);
  -- Role and org resolve at session time from the allowlist row above.
  INSERT INTO users (id, name, email, role, onboarded_at) VALUES
    ('dev-maria', 'Maria Chen', 'maria@labzen.test', 'client_editor', now());
  INSERT INTO sessions (session_token, user_id, expires) VALUES
    ('clienttoken', 'dev-maria', now() + interval '30 days');
  -- A READ-ONLY client contact. Half the client-view rules only show their
  -- shape from a viewer who cannot edit - Maria can, so she proves nothing
  -- about them.
  INSERT INTO users (id, name, email, role, onboarded_at) VALUES
    ('dev-kosei', 'K. Osei', 'accounts@coastal.test', 'client_viewer', now());
  INSERT INTO sessions (session_token, user_id, expires) VALUES
    ('viewertoken', 'dev-kosei', now() + interval '30 days');

  INSERT INTO instruments (external_id, client, model, manufacturer, serial, priority, stages, notes) VALUES
    ('LZ-001', 'Lab Zen', 'Agilent 6495C LC-MS', 'Agilent', 'US2405111', 1, '{"Checkout"}', 'Reserpine test and tune.'),
    ('LZ-002', 'Lab Zen', 'Thermo ISQ 7000 GC-MS', 'Thermo', 'ISQ70233', 2, '{"Refurbishment","System setup"}', 'Turbo replaced, pumping down.'),
    ('LZ-003', 'Lab Zen', 'Shimadzu LCMS-8060', 'Shimadzu', 'SH806014', 3, '{"Sign-off"}', 'Awaiting client sign-off.'),
    ('CA-001', 'Coastal Analytical', 'PerkinElmer Optima 8300 ICP-OES', 'PerkinElmer', 'PE83007', 4, '{"Intake"}', ''),
    ('CA-002', 'Coastal Analytical', 'Agilent 7890B GC', 'Agilent', 'CN14320', 5, '{"Waiting / blocked"}', 'HED fault - part on order.'),
    -- A unit that has genuinely stopped: past the reseller's stall threshold,
    -- so the pipeline's "sitting too long" surface has something real to show.
    -- CA-002 stays at twelve days, which is the staff board's blocked story.
    ('CA-004', 'Coastal Analytical', 'Waters Xevo TQ-S', 'Waters', 'WX88120', 4, '{"Waiting / blocked"}', 'Discontinued control board.'),
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

  -- YESTERDAY's report, because the digest sends the previous day (one row
  -- per system per day - eod_instrument_date): a bench day on LZ-002 whose
  -- narrative the client edition must carry, a house-only day on LZ-001 which
  -- it must NOT, and an off-system call for Harbor Biotech - the client whose
  -- whole day was a phone.
  INSERT INTO eod_updates (instrument_id, asset_id, date, owner_org_id, title, person, minutes,
                           system_update, action_item, internal, updated_by) VALUES
    (2, NULL, to_char(now() - interval '1 day', 'YYYY-MM-DD'), 1,
     'Turbo recert', 'Sam Ortiz', 240,
     'New turbo at speed; backing pressure 2.1e-2 mbar and falling. Leak-checked the foreline, all joints tight.',
     'Cal gas tune once base pressure holds overnight', false, 'dev@local.test'),
    (1, NULL, to_char(now() - interval '1 day', 'YYYY-MM-DD'), 1,
     'Margin note', 'Sam Ortiz', 5,
     'Quoted the checkout high on purpose - covers a second tune pass if we need one.',
     '', true, 'dev@local.test');
  INSERT INTO eod_updates (instrument_id, asset_id, date, owner_org_id, title, person, minutes,
                           system_update, action_item, internal, updated_by)
  SELECT NULL, NULL, to_char(now() - interval '1 day', 'YYYY-MM-DD'), o.id,
         'Phone support - autosampler alignment', 'Bill Reyes', 25,
         'Walked their chemist through re-teaching the autosampler arm after a crash.',
         'Send the alignment SOP', false, 'dev@local.test'
  FROM orgs o WHERE o.name = 'Harbor Biotech';

  -- Blocking is the one stage that demands a written reason, so the fixture's
  -- blocked system carries one - and an age, so the board can say how long.
  UPDATE instruments
     SET blocked_reason = 'Waiting on HED board from Agilent - no ETA.',
         blocked_since  = now() - interval '12 days'
   WHERE external_id = 'CA-002';

  UPDATE instruments
     SET blocked_reason = 'Discontinued control board. Two options sourced - one refurbished, one substitute.',
         blocked_since  = now() - interval '41 days'
   WHERE external_id = 'CA-004';

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

  -- TASKS ACROSS THE WALL, which the fixture never had - and which is why a
  -- client seeing none of them went unnoticed. Three assigned to Lab Zen's own
  -- editor (the shop handing their engineer the install list), one the shop's
  -- own working memory, and one the client raised themselves. Lab Zen must see
  -- exactly the first three and the last; Sierra Spectra sees all five.
  INSERT INTO tasks (tenant_org_id, instrument_id, title, state, assignee, origin, sort_order) VALUES
    (3, 1, 'Install new collision cell',         'Open', 'Maria Chen',  '',      1),
    (3, 1, 'Install and set up the autosampler', 'Open', 'Maria Chen',  '',      2),
    (3, 1, 'Connect exhaust and ventilation',    'Open', 'Maria Chen',  '',      3),
    (3, 1, 'Check whether the old board is still under warranty',
                                                 'Open', 'Bill Reyes',  '',      4),
    (3, 1, 'Carryover on the blank injections',  'Open', '',            'issue', 5);

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

  -- A retainer: $20,000 a month with no job behind it, which is the one kind
  -- of revenue nothing else in the fixture produces. Its cursor is left a
  -- cycle in the past so Contracts opens with a cycle ready to raise and the
  -- overnight pass has something to catch up on.
  INSERT INTO agreements (org_id, kind, number, title, status, starts_on, value_cents,
      bill_every_months, bill_amount_cents, bill_description, bill_day_of_month,
      bill_lead_days, bill_next_on, created_by) VALUES
    (2, 'contract', 'AGR-2026-07', 'Coastal Analytical retainer', 'active',
      to_char(now() - interval '200 days', 'YYYY-MM-DD'), 24000000,
      1, 2000000, 'Monthly service retainer', 1, 7,
      to_char(date_trunc('month', now()) - interval '1 month', 'YYYY-MM-DD'), '${OWNER}');

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

  -- One expense ours to absorb: it must show in the job's cost and stay off
  -- the invoice draft, which is the pair the billable flag exists for.
  INSERT INTO expenses (work_order_id, kind, description, amount_cents, incurred_on, billable, logged_by) VALUES
    (2, 'per_diem', 'Lunch, install day', 1850, to_char(now() - interval '5 days', 'YYYY-MM-DD'), false, 'Sam Ortiz');

  -- Overhead: money no job caused. Lives at /money/expenses, never invoiced.
  INSERT INTO expenses (work_order_id, kind, description, amount_cents, incurred_on, billable, person, logged_by) VALUES
    (NULL, 'other', 'Internet, August', 8999, to_char(now() - interval '3 days', 'YYYY-MM-DD'), false, 'Bill Reyes', '${OWNER}'),
    (NULL, 'other', 'CAD seat, monthly', 21500, to_char(date_trunc('month', now()), 'YYYY-MM-DD'), false, '', '${OWNER}');

  -- A reimbursement claim mid-flight: Bill's hotel and per diem submitted and
  -- waiting on the owner, so /expenses opens with a queue on one side and a
  -- pool (the owner's own mileage rows above) on the other.
  INSERT INTO expense_reports (person, status, submitted_by, note) VALUES
    ('Bill Reyes', 'submitted', 'bill@sierraspectra.test', 'Sacramento install week');
  INSERT INTO expenses (work_order_id, kind, description, amount_cents, incurred_on, billable, person, logged_by, report_id) VALUES
    (2, 'Lodging', 'Hampton Inn, 2 nights', 31800, to_char(now() - interval '8 days', 'YYYY-MM-DD'), true, 'Bill Reyes', 'bill@sierraspectra.test', 1),
    (2, 'Per diem', 'Install week per diem', 9000, to_char(now() - interval '8 days', 'YYYY-MM-DD'), true, 'Bill Reyes', 'bill@sierraspectra.test', 1);

  -- And one already PAID this month, so "Money out" has both reimbursement
  -- figures to show: what left the account, and what is still waiting to.
  INSERT INTO expense_reports (person, status, submitted_by, note, paid_on, paid_by, paid_ref) VALUES
    ('Bill Reyes', 'paid', 'bill@sierraspectra.test', 'Fresno service call',
     to_char(now() - interval '3 days', 'YYYY-MM-DD'), 'dev@local.test', 'CHK-2214');
  INSERT INTO expenses (work_order_id, kind, description, amount_cents, incurred_on, billable, person, logged_by, report_id) VALUES
    (2, 'Fuel', 'Fresno round trip', 6140, to_char(now() - interval '5 days', 'YYYY-MM-DD'), true, 'Bill Reyes', 'bill@sierraspectra.test', 2),
    (2, 'Meals', 'Working lunch, client site', 3860, to_char(now() - interval '5 days', 'YYYY-MM-DD'), true, 'Bill Reyes', 'bill@sierraspectra.test', 2);

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
  -- STAMPED, like every row the app itself writes. Unstamped fixtures made dev
  -- diverge from production in a way that hid a real bug: the catalog is read
  -- and written per workspace, so rows belonging to nobody are found by some
  -- queries and not others.
  INSERT INTO part_catalog (tenant_org_id, part_number, name, manufacturer, kind, asset_types, models, created_by) VALUES
    (3, '5188-5365', 'Septa, 11 mm, 50/pk',      'Agilent', 'consumable', '{"GC"}', '{"7890B"}', 'dev@local.test'),
    (3, 'G1960-80039', 'Oil mist filter',        'Agilent', 'part', '{"Vacuum pump"}', '{}', 'dev@local.test'),
    (3, 'WAT271066', 'ESI capillary',            'Waters',  'part', '{"Mass spec"}', '{"6495C"}', 'dev@local.test'),
    (3, 'ED-A72401', 'nXDS tip seal kit',        'Edwards', 'kit',  '{"Vacuum pump"}', '{"Edwards nXDS10i"}', 'dev@local.test'),
    (3, '228-45703-91', 'LC-30 plunger seal',    'Shimadzu','consumable', '{"Pump"}', '{"LC-30AD"}', 'dev@local.test');

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
    ('ED-A72401', 'Edwards',        true,  23500, 10, false, false, '', 'dev@local.test'),
    ('G1960-80039', 'Agilent',      true,  18900, 4, false, true,  '', 'dev@local.test');
  -- One price nobody has confirmed in an age, for the stale pill.
  UPDATE part_prices SET updated_at = now() - interval '120 days' WHERE part_number = 'ED-A72401';

  -- Miles are what the travel-rules strip reads: Building C sits inside the
  -- 80 mi stipend radius, the Sacramento lab beyond it, so switching the site
  -- picker on a work order flips the verdict.
  INSERT INTO org_sites (org_id, name, address, contact_name, oneway_miles, created_by) VALUES
    (1, 'Lab Zen - Building C', '1400 Harbor Way, Richmond, CA 94804', 'Rita Alvarez', 45, '${OWNER}'),
    (2, 'Coastal Analytical - Dock 2', '88 Pier Road, Astoria, OR 97103', 'Sam Okafor', 610, '${OWNER}'),
    (1, 'Lab Zen - Sacramento annex', '2101 Capitol Ave, Sacramento, CA 95816', 'Dev Ito', 140, '${OWNER}');
  UPDATE org_sites SET tax_rate_bps = 1025 WHERE org_id = 1;
  -- Stamped, like every other row. Unstamped sites are filtered out by
  -- forTenant, so the fixture's clients had addresses everywhere EXCEPT the
  -- places that read them through a tenant - a hand-off payload with no sites
  -- in it, which is most of what a hand-off is for.
  UPDATE org_sites SET tenant_org_id = 3 WHERE tenant_org_id IS NULL;
  -- Pins for the routed-miles path, so no seed-time network call: real
  -- coordinates for both Lab Zen labs, and the dev owner living in Elk Grove.
  -- Chosen to INVERT the shop's typed defaults: from the shop, Richmond is
  -- the near lab (45) and Sacramento the far one (140); from this engineer's
  -- home it is the other way around - which is the whole point of routing
  -- per engineer.
  UPDATE org_sites SET lat = 37.9120, lng = -122.3560, contact_email = 'rita@labzen.test'
    WHERE name = 'Lab Zen - Building C';
  UPDATE org_sites SET lat = 38.5766, lng = -121.4686 WHERE name = 'Lab Zen - Sacramento annex';
  UPDATE house_members SET home_address = '9376 Laguna Springs Dr, Elk Grove, CA',
    home_lat = 38.4088, home_lng = -121.3716 WHERE email = '${OWNER}';

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
  -- A blank draft for the coverage estimate builder to fill: multi-year, priced
  -- off a plan rather than off history, which is the shape a solicitation asks
  -- for and the one no fixture had (see lib/coveragePrice).
  INSERT INTO quotes (org_id, work_order_id, number, status, title, sent_on, expires_on, deposit_pct, created_by) VALUES
    (2, NULL, 'Q-1002', 'draft', 'Multi-year coverage, two sites', '',
      to_char(now() + interval '30 days', 'YYYY-MM-DD'), 0, '${OWNER}');
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
  -- Agreements too. Unstamped, they are invisible to every screen that filters
  -- by tenant, which is how the fixture had contracts nobody's portal showed.
  UPDATE agreements SET tenant_org_id = 3;
  -- The workspace shape production always has and raw inserts skip: client
  -- orgs hang off their operator, and the bench belongs to the workspace.
  -- Without these the digest - which scopes strictly, as a send must - sees
  -- an empty board, and the partner preview calls every org a stranger.
  -- Only what nobody has claimed. These used to be unqualified, which meant
  -- the fixture quietly took every other workspace's client and every other
  -- workspace's bench as soon as one existed - a second operator's rows
  -- reparented onto the first. A seed that cannot represent two workspaces
  -- cannot be used to check anything about two workspaces.
  UPDATE orgs SET parent_org_id = 3 WHERE kind = 'client' AND parent_org_id IS NULL;
  UPDATE instruments SET tenant_org_id = 3 WHERE tenant_org_id IS NULL;
  UPDATE eod_updates SET tenant_org_id = 3;

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

  -- What each client can SEE. Ownership and visibility are separate axes here:
  -- owner_org_id is whose machine it is, system_shares is who may look, and a
  -- client reads their portal entirely through the second (lib/tenancy
  -- scopeFor). Without these rows the fixture's client signs in to an empty
  -- lab, which made the whole client-facing half of the app untestable
  -- locally - the seed had owners but no shares.
  INSERT INTO system_shares (instrument_id, org_id, access, added_by)
    SELECT id, owner_org_id, 'edit', 'fixture' FROM instruments WHERE owner_org_id IS NOT NULL
    ON CONFLICT DO NOTHING;
  -- Coastal's share is read-only, so the fixture holds BOTH share shapes: an
  -- edit share (Lab Zen) and a view share. Production is mostly view shares,
  -- and a client-view bug that only bites on 'view' was invisible here.
  UPDATE system_shares SET access = 'view' WHERE org_id = 2;

  -- A reseller account, so the third shape of the client product has something
  -- to render: their units are stock heading for a sale rather than benches, so
  -- their landing is a pipeline and their exceptions are units that stopped
  -- moving. Coastal doubles as one - it already owns systems in the fixture.
  UPDATE orgs SET resale_enabled = true WHERE id = 2;
  UPDATE instruments SET for_sale = true, sale_note = 'Refurbished, sign-off packet attached',
    listing_token = 'lst-coastal-000001'
    WHERE client = 'Coastal Analytical' AND external_id = (
      SELECT external_id FROM instruments WHERE client = 'Coastal Analytical' ORDER BY id LIMIT 1);
  INSERT INTO users (id, name, email, role, onboarded_at) VALUES
    ('dev-dana', 'Dana Whitfield', 'accounts@coastal.test', 'client_editor', now())
    ON CONFLICT (id) DO NOTHING;
  INSERT INTO sessions (session_token, user_id, expires) VALUES
    ('resellertoken', 'dev-dana', now() + interval '30 days');

  -- Somewhere to be. Two sites for Lab Zen so the multi-site grouping on the
  -- client landing has something to group by; one system left unassigned, the
  -- ordinary case of an account that never named its rooms.
  INSERT INTO org_sites (org_id, name, address) VALUES
    (1, 'Fremont', '4001 Cushing Pkwy, Fremont, CA'),
    (1, 'Hayward', '2300 Industrial Blvd, Hayward, CA');
  UPDATE instruments SET site_id = (SELECT id FROM org_sites WHERE name = 'Fremont')
    WHERE client = 'Lab Zen' AND external_id IN ('LZ-001', 'LZ-002');
  UPDATE instruments SET site_id = (SELECT id FROM org_sites WHERE name = 'Hayward')
    WHERE client = 'Lab Zen' AND external_id = 'LZ-003';


  -- Stamped, like every other row here. An unstamped schedule is invisible to
  -- the pages that read with forTenant, which makes the local fixture disagree
  -- with production in exactly the way a fixture must not.
  INSERT INTO pm_schedules (tenant_org_id, instrument_id, title, assignee, every_days, next_due, last_done) VALUES
    (3, 1, 'Quarterly source clean', 'joe', 90, to_char(now() - interval '5 days', 'YYYY-MM-DD'), to_char(now() - interval '95 days', 'YYYY-MM-DD')),
    (3, 3, 'Annual desolvation line swap', '', 365, to_char(now() + interval '200 days', 'YYYY-MM-DD'), ''),
    (3, 6, 'Rough pump oil change', 'joe', 180, to_char(now() + interval '20 days', 'YYYY-MM-DD'), '');

  -- A STACKED annual, on the units rather than the system: the pump's jobs on
  -- the pump, the MS's on the MS, plus two system-level checks. This is what
  -- exercises the module-grouped maintenance panel and the PM run - without
  -- it the redesign degenerates locally to the flat list and cannot be seen.
  INSERT INTO pm_schedules (tenant_org_id, instrument_id, asset_id, title, every_days, next_due, last_done, parts)
  SELECT 3, NULL, a.id, v.title, 365,
         to_char(now() - interval '2 days', 'YYYY-MM-DD'),
         to_char(now() - interval '367 days', 'YYYY-MM-DD'), v.parts
  FROM assets a,
       (VALUES
         ('Drain & replace oil',            '[{"name":"AVF 68 Gold lubricant fluid","number":"63760-64085"}]'),
         ('Inspect & replace oil mist filter','[{"name":"Oil exhaust mist filter","number":"63762-68201"}]')
       ) AS v(title, parts)
  WHERE a.serial = 'DEBA2201';
  INSERT INTO pm_schedules (tenant_org_id, instrument_id, asset_id, title, every_days, next_due, last_done, parts)
  SELECT 3, NULL, a.id, v.title, 365,
         to_char(now() - interval '2 days', 'YYYY-MM-DD'),
         to_char(now() - interval '367 days', 'YYYY-MM-DD'), v.parts
  FROM assets a,
       (VALUES
         ('Remove spray shield & inspect',   '[{"name":"AJS spray shield, small","number":"G1958-20008"}]'),
         ('Inspect & clean octopole ion guide',''),
         ('Replace gas filters',             '[{"name":"N2 filter, main gas supply","number":"RMSN-4","qty":2}]')
       ) AS v(title, parts)
  WHERE a.serial = 'US2405111';
  INSERT INTO pm_schedules (tenant_org_id, instrument_id, title, every_days, next_due, last_done) VALUES
    (3, 1, 'Post-PM: verify vacuum at operating pressure', 365,
       to_char(now() - interval '2 days', 'YYYY-MM-DD'), to_char(now() - interval '367 days', 'YYYY-MM-DD'));

  -- A CLUSTER, because it is the ordinary case and nothing else in this
  -- fixture showed it: one machine's schedules were written on the same day at
  -- the same cadence, so they fall due together. The calendar collapses these
  -- into one line naming the machine - see lib/calendar.assembleEvents - and
  -- without a cluster here there is no way to look at that locally.
  INSERT INTO pm_schedules (tenant_org_id, instrument_id, title, assignee, every_days, next_due, last_done)
  SELECT 3, 2, v.title, 'joe', 90, to_char(now() + interval '6 days', 'YYYY-MM-DD'), ''
  FROM (VALUES
    ('Source housekeeping'),
    ('Turbo bearing check'),
    ('Inlet liner and septum'),
    ('Detector gain calibration'),
    ('Foreline pump oil')
  ) AS v(title);

  -- A reference library, so the hand-off has paper to carry. Provenance is
  -- what decides whether a row may travel - see lib/provenance - so the
  -- fixture has one of each answer.
  INSERT INTO catalog_refs (tenant_org_id, asset_type, model, kind, title, url, body, provenance, created_by) VALUES
    (3, 'Mass Spec', '', 'note', 'Source clean, our way', '', 'Vent, cool, bead blast the cone, sonicate 15 min.', 'original', '${OWNER}'),
    (3, 'Mass Spec', '6495C', 'link', 'Vent and pump-down sequence', 'https://example.test/vent', '', 'facts', '${OWNER}'),
    (3, 'Mass Spec', '6495C', 'link', 'Agilent service manual', 'https://example.test/oem', '', 'oem', '${OWNER}'),
    (3, 'Pump', '', 'note', 'Nobody has said where this came from', '', 'Tip seal every 12 months.', '', '${OWNER}');

  INSERT INTO sheet_diffs (external_id, field, sheet_value, db_value) VALUES
    ('LZ-002', 'stage', 'Checkout', 'Refurbishment, System setup'),
    ('CA-001', 'notes', 'Waiting on quote approval', '');

  INSERT INTO discussion_posts (instrument_id, author, author_email, body) VALUES
    (1, 'Rita Alvarez', 'rita@labzen.test', 'Any word on the checkout date? The lab is planning validation runs.'),
    (1, 'Dev Owner', '${OWNER}', 'Tune passed this morning; sign-off packet goes out tomorrow.');

  -- A client shared with a peer service company: twelve systems across two
  -- buildings, which is the shape the fleet brief exists for (lib/fleetBrief).
  -- parent_org_id is what makes it OUR client: every tenancy rule reads it,
  -- and addOrg sets it for anything created through the app.
  INSERT INTO orgs (id, name, kind, parent_org_id) VALUES (20, 'Emery Pharma', 'client', 3)
    ON CONFLICT DO NOTHING;
  INSERT INTO org_sites (id, tenant_org_id, org_id, name, address) VALUES
    (20, 3, 20, 'Hayward', '2000 Sample Way, Hayward CA'),
    (21, 3, 20, 'Alameda', '15 Bay Farm Rd, Alameda CA')
    ON CONFLICT DO NOTHING;
  INSERT INTO instruments (external_id, client, model, category, owner_org_id, site_id, tenant_org_id, stages)
  SELECT 'EP-' || lpad(n::text, 3, '0'), 'Emery Pharma',
         CASE WHEN n % 3 = 0 THEN 'GC-MS' ELSE 'LC-MS' END,
         CASE WHEN n % 3 = 0 THEN 'GC-MS' ELSE 'LC-MS' END,
         20, CASE WHEN n <= 7 THEN 20 ELSE 21 END, 3, ARRAY[]::text[]
  FROM generate_series(1, 12) n;
  -- One of them stalled, so the brief has something other than "In service" to
  -- say. Set afterwards rather than in the CASE above, which silently produced
  -- an empty array for every row.
  UPDATE instruments SET stages = ARRAY['Waiting / blocked']
    WHERE owner_org_id = 20 AND external_id = 'EP-004';

  -- HANDED BACK, NOTHING ASKED. The shape the client landing kept calling an
  -- emergency: a system parked in the client's own queue with the handover
  -- note as its reason, blocked on nobody (blocked_org_id null = us), no PM
  -- due. It must raise no chore and offer no "hand it back" - see
  -- queueNeedsThem in lib/clientView.
  UPDATE instruments SET queue_org_id = 1, queue_since = now() - interval '17 days',
    queue_reason = 'No longer on the Google sheet',
    stages = ARRAY['Waiting / blocked'], blocked_org_id = NULL
    WHERE external_id = 'LZ-003';
  INSERT INTO assets (instrument_id, kind, model, serial, manufacturer, tenant_org_id, sort_order)
  SELECT i.id, 'Mass Spec',
         CASE WHEN i.category = 'GC-MS' THEN 'ISQ 7000' ELSE '6495C' END,
         'SN' || (7000 + i.id), CASE WHEN i.category = 'GC-MS' THEN 'Thermo' ELSE 'Agilent' END, 3, 0
  FROM instruments i WHERE i.owner_org_id = 20;
  INSERT INTO assets (instrument_id, kind, model, serial, manufacturer, tenant_org_id, sort_order)
  SELECT i.id, 'Pump', 'nXDS15i', 'P' || (400 + i.id), 'Edwards', 3, 1
  FROM instruments i WHERE i.owner_org_id = 20;
  -- Half of them under contract with us, one with the maker, the rest unknown.
  INSERT INTO agreements (org_id, kind, number, title, status, starts_on, ends_on, instrument_ids, tenant_org_id)
  SELECT 20, 'contract', 'AGR-EP-1', 'MS coverage', 'active', '2026-01-01', '2027-01-01',
         array_agg(i.id), 3
  FROM (SELECT id FROM instruments WHERE owner_org_id = 20 ORDER BY id LIMIT 5) i;

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
  UPDATE vocab_terms SET manufacturer = 'Shimadzu',
    specs = '[{"name":"Mass range","value":"2-2000 m/z"},{"name":"Scan speed","value":"30000 u/s"},{"name":"Polarity switching","value":"5 ms"}]'
    WHERE kind = 'model' AND name = 'LCMS-8060';
  UPDATE vocab_terms SET manufacturer = 'Thermo Fisher',
    specs = '[{"name":"Mass range","value":"1.2-1100 m/z"},{"name":"Source","value":"ExtractaBrite, removable"},{"name":"Filament","value":"Dual, hot-swap"}]'
    WHERE kind = 'model' AND name = 'ISQ 7000';
  UPDATE vocab_terms SET manufacturer = 'Agilent' WHERE kind = 'model' AND name = '1290 Quat Pump';
  UPDATE vocab_terms SET manufacturer = 'Thermo Fisher' WHERE kind = 'model' AND name = 'TriPlus RSH';

  -- Three of the five go PUBLIC. The harness switches public_catalog_enabled
  -- on, so before this the library pages it unlocked - /equipment, every
  -- /equipment/<slug>, and the exhibit on the landing page - rendered their
  -- empty state and nothing else, which is the one state nobody needs to see
  -- a screenshot of. Two stay unpublished on purpose: publishing is the
  -- operator's explicit act (lib/publicCatalog), and Settings > Catalog has
  -- to have something left to publish for that screen to mean anything.
  UPDATE vocab_terms SET published = true, public_slug = 'agilent-6495c',
    public_summary = 'The 6495C is the triple quadrupole most of the LC-MS benches we look after are built around. In service it is a source-cleaning machine: throughput is decided by how the ion funnel is kept, and most sensitivity complaints we are called out for resolve at the source rather than anywhere downstream of it.'
    WHERE kind = 'model' AND name = '6495C';
  UPDATE vocab_terms SET published = true, public_slug = 'shimadzu-lcms-8060',
    public_summary = 'The LCMS-8060 trades some robustness for speed, and the desolvation line is the part that shows it. We swap them on a yearly interval rather than on failure, because a partially blocked line reads as a column problem for a week before anybody looks upstream of the source.'
    WHERE kind = 'model' AND name = 'LCMS-8060';
  UPDATE vocab_terms SET published = true, public_slug = 'thermo-fisher-isq-7000',
    public_summary = 'The ISQ 7000 is the GC-MS single quad we see most often, and the removable source is the reason. A hot-swap filament and a source that comes out without venting turn what used to be a scheduled visit into something a trained lab tech can do between runs.'
    WHERE kind = 'model' AND name = 'ISQ 7000';

  -- est_minutes and parts on the recurring work: without them the coverage
  -- estimate builder has nothing to look up, and the point of the lookup is
  -- that somebody already wrote a model's PM down once (see lib/pmKit).
  INSERT INTO procedures (asset_type, kind, name, notes, position, runs_at_intake, interval_days, model_scope, est_minutes, parts) VALUES
    ('system', 'task', 'Incoming inspection and photos', 'Every system, on arrival.', 0, true, NULL, '{}', 45, ''),
    ('system', 'test', 'Leak check', '', 1, true, NULL, '{}', 30, ''),
    ('Mass spec', 'task', 'Quarterly source clean', '', 0, false, 90, '{}', 180,
      '[{"name":"ESI capillary","number":"WAT271066"}]'),
    ('Mass spec', 'task', 'Annual PM', 'Full teardown, pump service, recertify.', 2, false, 365, '{"6495C"}', 480,
      '[{"name":"nXDS tip seal kit","number":"ED-A72401"},{"name":"Oil mist filter","number":"G1960-80039","qty":2}]'),
    ('Mass spec', 'task', 'Desolvation line swap', 'LCMS-8060 only.', 1, false, 365, '{"LCMS-8060"}', 240, ''),
    ('Pump', 'task', 'Seal replacement', '', 0, false, 180, '{}', 90,
      '[{"name":"LC-30 plunger seal","number":"228-45703-91","qty":2,"models":["LC-30AD"]}]'),
    -- A pump ships dry. This is what has to happen between the crate and the
    -- shelf, and it is the reason receiving a unit generates intake work at all
    -- (see receivePoLineAsUnit).
    ('Pump', 'task', 'Fill with oil and run up', 'New pumps ship dry - fill before it goes anywhere.',
      1, true, NULL, '{}', 20, '[{"name":"Oil mist filter","number":"G1960-80039"}]'),
    ('Autosampler', 'task', 'Needle and septum check', '', 0, true, NULL, '{}', 60, '');
  -- Stamped, like every other row above. Procedures are matched with
  -- forTenant, so an unstamped one fires for nobody and the fixture quietly
  -- has no maintenance at all - no intake work on a new system, no recurring
  -- schedules on a new unit.
  UPDATE procedures SET tenant_org_id = 3;

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
  -- A UNIT on order, arrived: the roughing pump the blocked GC has been
  -- waiting for. module_kind is what turns Received into an intake door.
  INSERT INTO parts (instrument_id, work_order_id, name, part_number, serial, vendor, cost, cost_cents,
                     status, module_kind, received_at) VALUES
    (2, 2, 'Roughing pump, Edwards RV5', 'A65401903', 'RV5-88213', 'Edwards', '$2,140.00', 214000,
     'Received', 'Pump', to_char(now(), 'YYYY-MM-DD'));
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

  -- ── T-003: the restoration demo from docs/mocks/ridgeline-restoration-flow.html ──
  -- Mid-pipeline (Verify) so every earlier stage has a read-only record to
  -- open and the later gates still have work to demand.
  INSERT INTO instruments (external_id, client, name, model, category, manufacturer, tenant_org_id, stages, notes)
    VALUES ('T-003', 'Lab Zen', 'Thermo Trace 1310 GC · ISQ 7000 · TriPlus 500 HS', 'Trace 1310 GC', 'GC/MS', 'Thermo',
      (SELECT id FROM orgs WHERE name = 'Sierra Spectra'), '{Refurbishment}', 'Auction lot - restoration demo.');
  INSERT INTO assets (instrument_id, kind, model, serial, manufacturer, status, tenant_org_id, sort_order)
    SELECT i.id, v.kind, v.model, v.serial, v.mfr, 'In service', i.tenant_org_id, v.ord
    FROM instruments i, (VALUES
      ('Mass spec', 'ISQ 7000', 'ISQ7N2009006', 'Thermo', 1),
      ('GC', 'Trace 1310 GC', '720001783', 'Thermo', 2),
      ('Headspace', 'TriPlus 500', '820100261', 'Thermo', 3),
      ('Vacuum pump', 'Edwards RV3', '180675201', 'Edwards', 4)
    ) AS v(kind, model, serial, mfr, ord)
    WHERE i.external_id = 'T-003';
  INSERT INTO restoration_projects (tenant_org_id, instrument_id, source, stage, stage_since, assignee, created_by, created_at)
    SELECT tenant_org_id, id, 'acquired', 'verify', now() - interval '1 day', 'Dev Owner', '${OWNER}', now() - interval '9 days'
    FROM instruments WHERE external_id = 'T-003';
  INSERT INTO component_conditions (project_id, asset_id, grade, graded_by, graded_at)
    SELECT p.id, a.id, v.grade, '${OWNER}', now() - interval '8 days'
    FROM restoration_projects p
    JOIN instruments i ON i.id = p.instrument_id AND i.external_id = 'T-003'
    JOIN assets a ON a.instrument_id = i.id
    JOIN (VALUES ('ISQ7N2009006','C'), ('720001783','B'), ('820100261','D'), ('180675201','B')) AS v(serial, grade)
      ON v.serial = a.serial;
  INSERT INTO findings (project_id, asset_id, severity, title, created_by, created_at)
    SELECT p.id, a.id, v.sev, v.title, '${OWNER}', now() - interval '8 days'
    FROM restoration_projects p
    JOIN instruments i ON i.id = p.instrument_id AND i.external_id = 'T-003'
    JOIN assets a ON a.instrument_id = i.id
    JOIN (VALUES
      ('820100261', 'bad', 'Headspace arm not operating properly'),
      ('ISQ7N2009006', 'warn', 'Electron multiplier suspect — verify gain before release')
    ) AS v(serial, sev, title) ON v.serial = a.serial;
  INSERT INTO tasks (tenant_org_id, instrument_id, asset_id, title, state, assignee, origin, restoration_project_id, finding_id, completed_at)
    SELECT p.tenant_org_id, p.instrument_id, f.asset_id, f.title, 'Done', 'Bill Reyes', 'finding', p.id, f.id, now() - interval '3 days'
    FROM restoration_projects p
    JOIN instruments i ON i.id = p.instrument_id AND i.external_id = 'T-003'
    JOIN findings f ON f.project_id = p.id;
  INSERT INTO tasks (tenant_org_id, instrument_id, title, state, assignee, restoration_project_id, completed_at)
    SELECT p.tenant_org_id, p.instrument_id, 'Full PM — source clean, filament, septa, liner, pump oil', 'Done', 'Bill Reyes', p.id, now() - interval '2 days'
    FROM restoration_projects p JOIN instruments i ON i.id = p.instrument_id AND i.external_id = 'T-003';
  INSERT INTO provenance_answers (project_id, question_key, answer, answered_by)
    SELECT p.id, v.k, v.a, '${OWNER}'
    FROM restoration_projects p
    JOIN instruments i ON i.id = p.instrument_id AND i.external_id = 'T-003',
    (VALUES ('operational_at_deinstall','unknown'), ('last_pm_date','unknown'), ('pm_docs','none'), ('contract_history','unknown')) AS v(k, a);
  INSERT INTO handoff_kits (project_id, software_notes, license_status, utilities, cred_username)
    SELECT p.id, 'TraceFinder required — no active license on system', 'required',
      '100–240 V · 50/60 Hz · 50 A max · 6-15 plug · no vent required', 'LZ1'
    FROM restoration_projects p JOIN instruments i ON i.id = p.instrument_id AND i.external_id = 'T-003';
  INSERT INTO parts (instrument_id, restoration_project_id, name, part_number, qty, vendor, cost_cents, status, installed_at)
    SELECT p.instrument_id, p.id, v.name, v.pn, v.qty, v.vendor, v.cents, 'Installed', to_char(now() - interval '3 days', 'YYYY-MM-DD')
    FROM restoration_projects p
    JOIN instruments i ON i.id = p.instrument_id AND i.external_id = 'T-003',
    (VALUES
      ('Electron multiplier', 'WE023950', '1', 'Frit & Ferrule', 68500),
      ('Filament assembly', '1R120-1005', '1', 'Stock', 21200),
      ('RV3 pump oil (1L)', 'H11025011', '2', 'Stock', 5800)
    ) AS v(name, pn, qty, vendor, cents);
  INSERT INTO attachments (instrument_id, restoration_project_id, file_name, kind, description, url, size, uploaded_by)
    SELECT p.instrument_id, p.id, v.fname, v.kind, v.descr, v.url, v.size, 'Dev Owner'
    FROM restoration_projects p
    JOIN instruments i ON i.id = p.instrument_id AND i.external_id = 'T-003',
    (VALUES
      ('arrival-front.jpg', 'Photo', 'Restoration photo', 'https://blob.local/t003-1.jpg', 412000),
      ('arrival-rear.jpg', 'Photo', 'Restoration photo', 'https://blob.local/t003-2.jpg', 398000),
      ('arrival-serials.jpg', 'Photo', 'Restoration photo', 'https://blob.local/t003-3.jpg', 371000),
      ('arrival-crate.jpg', 'Photo', 'Restoration photo', 'https://blob.local/t003-4.jpg', 405000),
      ('MotionRepair RMA MR-2231 report.pdf', 'Report', 'Outside work report - MotionRepair Co.', 'https://blob.local/t003-rma.pdf', 122000),
      ('Wipe certificate.pdf', 'Report', 'Prior-owner data wipe certificate', 'https://blob.local/t003-wipe.pdf', 88000)
    ) AS v(fname, kind, descr, url, size);
  INSERT INTO outside_work (project_id, vendor, rma_number, description, cost_cents, report_attachment_id, created_by)
    SELECT p.id, 'MotionRepair Co.', 'MR-2231', 'Headspace arm drive rebuild', 42000,
      (SELECT id FROM attachments WHERE file_name = 'MotionRepair RMA MR-2231 report.pdf'), '${OWNER}'
    FROM restoration_projects p JOIN instruments i ON i.id = p.instrument_id AND i.external_id = 'T-003';
  UPDATE restoration_projects SET
      pc_backup_at = now() - interval '1 day',
      wipe_cert_attachment_id = (SELECT id FROM attachments WHERE file_name = 'Wipe certificate.pdf')
    WHERE instrument_id = (SELECT id FROM instruments WHERE external_id = 'T-003');
  INSERT INTO restoration_confirms (project_id, stage, key, confirmed_by, confirmed_at)
    SELECT p.id, v.stage, v.k, '${OWNER}', now() - interval '2 days'
    FROM restoration_projects p
    JOIN instruments i ON i.id = p.instrument_id AND i.external_id = 'T-003',
    (VALUES ('receive','handoff_vaulted'), ('restore','task_photos')) AS v(stage, k);
  INSERT INTO audit_log (tenant_org_id, instrument_id, entity_type, entity_id, actor, action, created_at)
    SELECT p.tenant_org_id, p.instrument_id, 'restoration', p.id::text, v.actor, v.action, now() - (v.days || ' days')::interval
    FROM restoration_projects p
    JOIN instruments i ON i.id = p.instrument_id AND i.external_id = 'T-003',
    (VALUES
      ('${OWNER}', 'opened restoration receiving for T-003', '9'),
      ('${OWNER}', 'received 4 components — matched to catalog', '8'),
      ('bill@sierraspectra.test', 'completed full PM · parts logged', '2'),
      ('${OWNER}', 'advanced T-003 to Restoring', '5'),
      ('${OWNER}', 'advanced T-003 to Verifying', '1')
    ) AS v(actor, action, days);
  -- Three lab PCs, so /remote is a list rather than an empty state, and the
  -- notice controls have something to sit under. Between them they cover the
  -- three things that panel renders: a machine that is quiet, one carrying a
  -- repossession notice, and one carrying both a hold and a notice at once.
  INSERT INTO remote_devices (tenant_org_id, org_id, instrument_id, node_id, name, nickname, platform, consent_override, last_seen_at, enrolled_by) VALUES
    ((SELECT id FROM orgs WHERE name = 'Sierra Spectra'), (SELECT id FROM orgs WHERE name = 'Lab Zen'),
      (SELECT id FROM instruments WHERE external_id = 'LZ-002'),
      'node//devfixture000000000000001', 'DESKTOP-7QF3K1', 'Altis PC', 'Windows 10 Pro', NULL,
      now() - interval '40 seconds', 'the agent installer'),
    ((SELECT id FROM orgs WHERE name = 'Sierra Spectra'), (SELECT id FROM orgs WHERE name = 'Lab Zen'),
      NULL, 'node//devfixture000000000000002', 'DESKTOP-K22X9', 'Bench 3 PC', 'Windows 11 Pro', NULL,
      now() - interval '6 minutes', 'the agent installer'),
    -- Consent forced on, so the panel has a machine whose lock rung visibly
    -- degrades to advice - the state that is otherwise only reachable by
    -- shipping a system.
    ((SELECT id FROM orgs WHERE name = 'Sierra Spectra'), (SELECT id FROM orgs WHERE name = 'Coastal Analytical'),
      (SELECT id FROM instruments WHERE external_id = 'CA-003'),
      'node//devfixture000000000000003', 'CA-QC-02', 'Coastal QC PC', 'Windows 10 Pro', true,
      now() - interval '3 hours', 'the agent installer');

  -- A hold nobody has cleared, on the machine driving the GC-MS.
  INSERT INTO safety_holds (tenant_org_id, device_id, instrument_id, reason, fault_source, effect, contact, decided_by, dispatched_to, created_at) VALUES
    ((SELECT id FROM orgs WHERE name = 'Sierra Spectra'),
      (SELECT id FROM remote_devices WHERE node_id = 'node//devfixture000000000000001'),
      (SELECT id FROM instruments WHERE external_id = 'LZ-002'),
      'Source heater overshooting setpoint; thermal fault suspected.',
      'engineer assessment', 'hold', 'Sierra Spectra 555-0100', 'bill@sierraspectra.test', 'Rita Alvarez',
      now() - interval '5 hours'),
    -- The sharpest rung, on the machine that has left our shop: posted as
    -- 'lock' and rendered as advice, which is the whole point of permitted().
    ((SELECT id FROM orgs WHERE name = 'Sierra Spectra'),
      (SELECT id FROM remote_devices WHERE node_id = 'node//devfixture000000000000003'),
      (SELECT id FROM instruments WHERE external_id = 'CA-003'),
      'Rotary pump exhaust blocked - oil mist detected at the bench.',
      'engineer assessment', 'lock', 'Sierra Spectra 555-0100', 'bill@sierraspectra.test', '',
      now() - interval '2 days');

  -- A machine that went missing in transit, so the lockout controls have a
  -- live one to render. Deliberately the Coastal QC PC's neighbour rather than
  -- a machine that also carries a notice: the two are different acts and the
  -- fixture should not imply they travel together.
  INSERT INTO device_lockouts (tenant_org_id, device_id, instrument_id, reference, reason, contact, force, decided_by, last_enforced_at, created_at) VALUES
    ((SELECT id FROM orgs WHERE name = 'Sierra Spectra'),
      (SELECT id FROM remote_devices WHERE node_id = 'node//devfixture000000000000002'),
      NULL, 'Reno PD 26-114882',
      'Taken from the loading dock overnight between the 27th and 28th.',
      'Sierra Spectra 555-0100', 'logoff', '${OWNER}',
      now() - interval '20 minutes', now() - interval '1 day');

  INSERT INTO device_notices (tenant_org_id, device_id, rung, body, approved_by, posted_by, created_at) VALUES
    ((SELECT id FROM orgs WHERE name = 'Sierra Spectra'),
      (SELECT id FROM remote_devices WHERE node_id = 'node//devfixture000000000000003'),
      'prominent', 'Property of Sierra Spectra. Account past due - call 555-0100.',
      '${OWNER}', '${OWNER}', now() - interval '1 day');

  -- Two leases, so /remote shows the lease guard in its ordinary states: one
  -- warning-only and renewing normally, one whose renewal an owner suspended.
  INSERT INTO device_leases (tenant_org_id, device_id, instrument_id, armed, force, lease_days, grace_days, expires_at, counter, last_renewed_at, armed_by, created_at) VALUES
    ((SELECT id FROM orgs WHERE name = 'Sierra Spectra'),
      (SELECT id FROM remote_devices WHERE node_id = 'node//devfixture000000000000001'),
      (SELECT id FROM instruments WHERE external_id = 'LZ-002'),
      true, 'notify', 7, 3, now() + interval '5 days', 6, now() - interval '2 days', '${OWNER}',
      now() - interval '44 days');
  INSERT INTO device_leases (tenant_org_id, device_id, instrument_id, armed, force, lease_days, grace_days, expires_at, counter, last_renewed_at, armed_by, suspended_at, suspended_by, suspend_reason, created_at) VALUES
    ((SELECT id FROM orgs WHERE name = 'Sierra Spectra'),
      (SELECT id FROM remote_devices WHERE node_id = 'node//devfixture000000000000002'),
      NULL, true, 'lock', 7, 3, now() + interval '2 days', 11, now() - interval '5 days', '${OWNER}',
      now() - interval '1 day', '${OWNER}', 'Terms not met on the March delivery; hold pending contract review.',
      now() - interval '30 days');
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
  console.log("[dev:local] ... stafftoken (Bill Reyes, staff at Sierra Spectra - not the owner)");
  console.log("[dev:local] ... freetoken (Cass Ibarra, a shop on the free tier - see lib/plan)");
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
