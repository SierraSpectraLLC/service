/**
 * Separate the PLATFORM operator from the service company that happens to be
 * tenant #1.
 *
 * app_settings.operator_org_id does two unrelated jobs. It is the tenancy ROOT
 * - isPlatformStaff is `operatorOrgId === rootOperatorOrgId`, so its staff read
 * every workspace on the instance - and it is the SIGNING operator, the company
 * whose name goes on documents. While one company was both, nobody noticed. The
 * day a second workspace opened, the first company's own people were still
 * reading its data, because they are platform staff by construction.
 *
 * This moves the root to a platform organization that services nothing, and
 * leaves the service company as an ordinary tenant.
 *
 * Idempotent, and every step reports what it would do first. Run with
 * --dry-run (the default is a dry run - you must pass --commit to write).
 *
 *   npx tsx scripts/split-platform-operator.ts                    # report only
 *   npx tsx scripts/split-platform-operator.ts --commit           # do it
 *   npx tsx scripts/split-platform-operator.ts --rollback --commit # put it back
 *
 * ROLLBACK is one field: operator_org_id back to the service company. The
 * backfill and the new organization are additive and are left alone, because
 * neither does any harm standing.
 *
 * BREAK-GLASS, if the new administrator cannot sign in: add an address to the
 * STAFF_EMAILS environment variable. lib/houseRole.houseIdentityFor gives an
 * env-listed address the ROOT org when it has no house_members row, so that
 * address becomes platform staff of whatever operator_org_id currently names.
 */
import { randomBytes, scrypt as scryptCb } from "node:crypto";
import { promisify } from "node:util";
import { and, eq, isNull, sql } from "drizzle-orm";
import { db } from "@/db";
import { appSettings, houseMembers, orgs, users } from "@/db/schema";
import { hashPassword, passwordProblem } from "@/lib/password";
import { makeTempPassword } from "@/lib/tempPassword";

const COMMIT = process.argv.includes("--commit");
const ROLLBACK = process.argv.includes("--rollback");
const PLATFORM_NAME = "Ridgeline";
const ADMIN = "admin@ridgelinefield.com";

/** Tables the one-shot schema-sync backfill does not reach. */
const STAMPED = [
  "agreements", "assets", "attachments", "catalog_refs", "cloud_connections",
  "credit_overrides", "discussion_posts", "disputes", "drop_links", "dunning_events",
  "eod_updates", "expense_categories", "expense_reports", "expenses", "folders",
  "instruments", "invoice_fees", "invoices", "message_threads", "org_sites",
  "part_catalog", "part_prices", "payments", "payroll", "people", "pm_schedules",
  "procedures", "promises", "purchase_orders", "quotes", "rate_cards",
  "remote_devices", "service_visits", "share_links", "stage_defs", "stockrooms",
  "tasks", "time_entries", "validation_docs", "vocab_terms", "work_orders",
];

const say = (s = "") => console.log(s);

async function main() {
  say(`${COMMIT ? "COMMITTING" : "DRY RUN - nothing is written"}${ROLLBACK ? "  (rollback)" : ""}\n`);

  const [s] = await db.select().from(appSettings).where(eq(appSettings.id, 1));
  if (!s) throw new Error("no app_settings row");
  const root = s.operatorOrgId;
  if (root === null) throw new Error("operator_org_id is not set - nothing to split");
  const [rootOrg] = await db.select().from(orgs).where(eq(orgs.id, root));
  say(`current root: ${root} (${rootOrg?.name})`);

  const [existingPlatform] = await db.select().from(orgs)
    .where(and(eq(orgs.name, PLATFORM_NAME), eq(orgs.isOperator, true)));

  if (ROLLBACK) {
    const service = await db.select().from(orgs)
      .where(and(eq(orgs.isOperator, true), sql`${orgs.name} <> ${PLATFORM_NAME}`));
    const back = service.find((o) => o.id !== existingPlatform?.id);
    if (!back) throw new Error("cannot find a service operator to hand the root back to");
    say(`would set operator_org_id = ${back.id} (${back.name})`);
    if (COMMIT) {
      await db.update(appSettings).set({ operatorOrgId: back.id }).where(eq(appSettings.id, 1));
      say("done - the service company is the root again");
    }
    return;
  }

  // ---- 1. Backfill --------------------------------------------------------
  // Rows with no stamp are invisible to a SCOPED reader (eq() never matches
  // NULL) and visible only to platform staff. They survive today because the
  // service company IS platform staff; the moment it is not, they vanish from
  // its own pages.
  say("\n[1] Unstamped rows -> the service company");
  let total = 0;
  for (const t of STAMPED) {
    const r: { rows?: { n: number }[] } = await db.execute(
      sql.raw(`SELECT count(*)::int AS n FROM "${t}" WHERE tenant_org_id IS NULL`),
    ) as never;
    const n = Number((r.rows ?? (r as never as { n: number }[]))[0]?.n ?? 0);
    if (!n) continue;
    total += n;
    say(`    ${t.padEnd(22)} ${String(n).padStart(4)}`);
    if (COMMIT) {
      await db.execute(sql.raw(
        `UPDATE "${t}" SET tenant_org_id = ${root} WHERE tenant_org_id IS NULL`));
    }
  }
  say(total ? `    ${total} row(s)${COMMIT ? " stamped" : " would be stamped"}` : "    none - already clean");

  // ---- 2. The platform organization ---------------------------------------
  say("\n[2] The platform organization");
  let platformId = existingPlatform?.id ?? null;
  if (platformId) {
    say(`    "${PLATFORM_NAME}" already exists as org ${platformId}`);
  } else if (COMMIT) {
    const [row] = await db.insert(orgs)
      .values({ name: PLATFORM_NAME, kind: "provider", isOperator: true, parentOrgId: null })
      .returning();
    platformId = row.id;
    say(`    created "${PLATFORM_NAME}" as org ${platformId}`);
  } else {
    say(`    would create "${PLATFORM_NAME}" (provider, is_operator, no parent, no clients)`);
  }

  // ---- 3. The administrator ------------------------------------------------
  say("\n[3] The platform administrator");
  const [member] = await db.select().from(houseMembers).where(eq(houseMembers.email, ADMIN));
  if (member) {
    say(`    ${ADMIN} already a house member (org=${member.orgId}, ${member.role})`);
    if (COMMIT && platformId && member.orgId !== platformId) {
      await db.update(houseMembers).set({ orgId: platformId, role: "owner" })
        .where(eq(houseMembers.id, member.id));
      say(`    moved to org ${platformId} as owner`);
    }
  } else if (COMMIT && platformId) {
    await db.insert(houseMembers)
      .values({ email: ADMIN, orgId: platformId, role: "owner", name: "Platform administrator" });
    say(`    added ${ADMIN} as owner of org ${platformId}`);
  } else {
    say(`    would add ${ADMIN} as owner of the platform organization`);
  }

  // A password as well as the code path, so a mail problem cannot lock the
  // platform out of itself on the one night it matters.
  const [account] = await db.select().from(users).where(eq(users.email, ADMIN));
  if (account?.passwordHash) {
    say("    an account with a password already exists - left alone");
  } else if (COMMIT) {
    let pw = "";
    do { pw = makeTempPassword((max) => randomBytes(4).readUInt32BE(0) % max); }
    while (passwordProblem(pw, ADMIN));
    const scrypt = promisify(scryptCb) as (p: string, s: Buffer, k: number, o: object) => Promise<Buffer>;
    const hash = await hashPassword(pw, (p, sa, k, o) => scrypt(p, sa, k, o), randomBytes);
    if (account) {
      await db.update(users).set({ passwordHash: hash, passwordSetAt: new Date(), passwordTempUntil: null, role: "owner" })
        .where(eq(users.email, ADMIN));
    } else {
      await db.insert(users).values({
        email: ADMIN, name: "Platform administrator", role: "owner",
        passwordHash: hash, passwordSetAt: new Date(), passwordTempUntil: null,
      });
    }
    say(`    password: ${pw}`);
    say("    (change it in Settings - it is printed once, here, and nowhere else)");
  } else {
    say("    would create the account and print a password once");
  }

  // ---- 4. The flip ---------------------------------------------------------
  say("\n[4] The root");
  if (!platformId) {
    say("    (dry run - the platform organization does not exist yet, so nothing to point at)");
  } else if (root === platformId) {
    say("    already points at the platform organization");
  } else {
    say(`    operator_org_id: ${root} (${rootOrg?.name}) -> ${platformId} (${PLATFORM_NAME})`);
    say(`    after this, ${rootOrg?.name}'s staff are an ordinary tenant: they read their own`);
    say("    workspace and no other. Platform staff are whoever sits in the platform org.");
    if (COMMIT) {
      await db.update(appSettings).set({ operatorOrgId: platformId }).where(eq(appSettings.id, 1));
      say("    done");
    }
  }

  say(`\n${COMMIT ? "Committed." : "Nothing was written. Pass --commit to do it."}`);
  say("Rollback: npx tsx scripts/split-platform-operator.ts --rollback --commit");
}

main().then(() => process.exit(0)).catch((e) => { console.error("ERR:", e.message); process.exit(1); });
