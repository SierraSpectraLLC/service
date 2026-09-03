/**
 * Give every procedure a stable key, and REPORT the ones that collide.
 *   DATABASE_URL=... npx tsx scripts/backfill-procedure-keys.ts [--apply]
 *
 * Dry by default: it prints what it would write and what would clash. Nothing
 * is written without --apply, because the collision list is the point of
 * running it and a script that fixes things while you are still reading the
 * report is a script nobody reads the report of.
 *
 * Idempotent: a row that already has a key is left alone, always. Keys are
 * written into system_events that travel to other organizations, so re-slugging
 * a renamed procedure would orphan somebody else's history in silence.
 *
 * Collisions are NOT auto-suffixed. A '-2' is a decision about which of two
 * procedures is the real one, and it is not this script's to take at 3am on a
 * workspace it has never seen.
 */
import { eq } from "drizzle-orm";
import { db } from "../src/db";
import { procedures, procedureTypes } from "../src/db/schema";
import { keyCollisions, procedureKey, slug, type KeyedRow } from "../src/lib/custody/keys";

export async function main() {
  const apply = process.argv.includes("--apply");
  const rows = await db.select({
    id: procedures.id, tenantOrgId: procedures.tenantOrgId, name: procedures.name,
    assetType: procedures.assetType, modelScope: procedures.modelScope,
    categoryScope: procedures.categoryScope, key: procedures.key, typeKey: procedures.typeKey,
  }).from(procedures);

  const need = rows.filter((r) => r.key === "");
  const keyed: KeyedRow[] = rows.map((r) => ({
    id: r.id, tenantOrgId: r.tenantOrgId, name: r.name,
    assetType: r.assetType, modelScope: r.modelScope, categoryScope: r.categoryScope,
  }));

  const unnameable = need.filter((r) => procedureKey(r) === "");
  const collisions = keyCollisions(keyed);

  // A best-effort classification, and only where the name IS the platform's
  // word for the job. Anything else is left blank for a person: guessing that
  // "Annual service" means `replace-ion-source-consumables` is how a taxonomy
  // stops meaning anything.
  const types = new Set((await db.select({ key: procedureTypes.key }).from(procedureTypes)).map((t) => t.key));

  let wrote = 0, classified = 0;
  for (const r of need) {
    const key = procedureKey(r);
    if (!key) continue;
    const guess = slug(r.name);
    const typeKey = types.has(guess) ? guess : "";
    if (apply) {
      await db.update(procedures).set({ key, ...(typeKey ? { typeKey } : {}) }).where(eq(procedures.id, r.id));
    }
    wrote++;
    if (typeKey) classified++;
  }

  console.log(`[procedure-keys] ${rows.length} procedure(s); ${rows.length - need.length} already keyed`);
  console.log(`[procedure-keys] ${apply ? "wrote" : "would write"} ${wrote} key(s), ${classified} matched a platform type`);

  if (unnameable.length) {
    console.log(`[procedure-keys] ${unnameable.length} row(s) have no sluggable name and stay blank:`);
    for (const r of unnameable) console.log(`  - #${r.id} ${JSON.stringify(r.name)}`);
  }

  if (collisions.length) {
    console.log(`[procedure-keys] ${collisions.length} COLLISION(S) - two procedures in one workspace keying the same.`);
    console.log("[procedure-keys] not auto-suffixed: decide which is the real one, then re-run.");
    for (const c of collisions) {
      console.log(`  - tenant ${c.tenantOrgId ?? "(none)"} ${c.key}`);
      for (const [i, id] of c.ids.entries()) console.log(`      #${id} ${JSON.stringify(c.names[i])}`);
    }
  } else {
    console.log("[procedure-keys] no collisions - a unique index on (tenant_org_id, key) is safe to add");
  }

  if (!apply) console.log("[procedure-keys] dry run; pass --apply to write");
}

// Auto-runs when you run it, and stays quiet when a test imports it to
// drive main() against a database of its own. A backfill nobody can
// exercise is a backfill nobody knows the behaviour of.
if (!process.env.VITEST) main().catch((e) => { console.error("[procedure-keys] failed:", e); process.exit(1); });
