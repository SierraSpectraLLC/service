/**
 * Give every organization its capabilities, once, from what it already is.
 *   DATABASE_URL=... npx tsx scripts/backfill-org-capabilities.ts [--apply]
 *
 *   kind = 'provider'  -> canService
 *   resaleEnabled      -> canCustody + canBroker
 *   kind = 'client'    -> canCustody
 *
 * Only rows with all three still false are touched, so an admin who has since
 * turned one OFF on purpose is not overruled by a re-run. `kind` stays: it is
 * which side of a relationship an org is on, and every persona, share and
 * queue rule still reads it. showNameDownstream is not backfilled - it is off
 * by policy (ADR 0001, decision 1) and only the provider turns it on.
 */
import { and, eq } from "drizzle-orm";
import { db } from "../src/db";
import { orgs } from "../src/db/schema";

export async function main() {
  const apply = process.argv.includes("--apply");
  const rows = await db.select({
    id: orgs.id, name: orgs.name, kind: orgs.kind, resaleEnabled: orgs.resaleEnabled,
    canCustody: orgs.canCustody, canService: orgs.canService, canBroker: orgs.canBroker,
  }).from(orgs);

  let wrote = 0, kept = 0;
  const tally = { canCustody: 0, canService: 0, canBroker: 0 };
  for (const o of rows) {
    if (o.canCustody || o.canService || o.canBroker) { kept++; continue; }
    const next = {
      canService: o.kind === "provider",
      canCustody: o.kind === "client" || o.resaleEnabled,
      canBroker: o.resaleEnabled,
    };
    if (!next.canService && !next.canCustody && !next.canBroker) { kept++; continue; }
    wrote++;
    for (const k of Object.keys(tally) as (keyof typeof tally)[]) if (next[k]) tally[k]++;
    if (apply) {
      await db.update(orgs).set(next)
        .where(and(eq(orgs.id, o.id), eq(orgs.canCustody, false), eq(orgs.canService, false), eq(orgs.canBroker, false)));
    }
  }
  console.log(`[capabilities] ${rows.length} org(s): ${apply ? "wrote" : "would write"} ${wrote}, left ${kept} alone`);
  console.log(`[capabilities]   canCustody ${tally.canCustody} · canService ${tally.canService} · canBroker ${tally.canBroker}`);
  if (!apply) console.log("[capabilities] dry run; pass --apply to write");
}

// Auto-runs when you run it, and stays quiet when a test imports it to
// drive main() against a database of its own.
if (!process.env.VITEST) main().catch((e) => { console.error("[capabilities] failed:", e); process.exit(1); });
