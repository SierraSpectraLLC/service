/**
 * Derive the ledger from the rows that predate it. Idempotent - every posting
 * is keyed, and post() returns the entry that already carries a key rather
 * than writing another - so it is safe to run again after a deploy, after
 * the dual-writing actions have been posting for a month, or after a bill is
 * fixed. The logic is lib/ledger/backfill; this is the command line.
 *
 *   DATABASE_URL=... npx tsx scripts/backfill-ledger.ts --dry-run   # prints what it would write
 *   DATABASE_URL=... npx tsx scripts/backfill-ledger.ts             # writes it
 *   ... --tenant=3                                                  # one workspace only
 *
 * Against the local throwaway database, as `npm run dev:local` does after
 * seeding:  NODE_ENV=development LOCAL_DB=1 PGLITE_DIR=... npx tsx scripts/backfill-ledger.ts
 */
import { backfillLedger } from "../src/lib/ledger/backfill";
import { shopToday } from "../src/lib/shopday";
import { accountName } from "../src/lib/ledger/accounts";

async function main() {
  const dryRun = process.argv.includes("--dry-run");
  const tenantArg = process.argv.find((a) => a.startsWith("--tenant="));
  const tenantOrgId = tenantArg ? Number(tenantArg.slice("--tenant=".length)) : undefined;
  const result = await backfillLedger({ today: shopToday(), dryRun, tenantOrgId, log: (l) => console.log(l) });
  if (dryRun) {
    for (const p of result.planned) {
      const lines = p.lines.map((l) => `${accountName(l.account)} ${l.debitCents ? `dr ${(l.debitCents / 100).toFixed(2)}` : `cr ${((l.creditCents ?? 0) / 100).toFixed(2)}`}`).join(" / ");
      console.log(`  ${p.on}  [t${p.tenantOrgId ?? "-"}]  ${p.key.padEnd(34)}  ${p.memo}\n      ${lines}`);
    }
    console.log(`[backfill] dry run: ${result.planned.length} entr${result.planned.length === 1 ? "y" : "ies"} would be written; nothing was`);
  }
  for (const s of result.skipped) console.log(`  skipped ${s.what}: ${s.why}`);
}

main().then(() => process.exit(0)).catch((e) => { console.error("[backfill] failed:", e.message); process.exit(1); });
