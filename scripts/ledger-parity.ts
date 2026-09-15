/**
 * Every workspace's money, computed both ways - the legacy arithmetic and the
 * ledger - and the diff per figure. Gate 4 of docs/design/LEDGER-VERIFY.md:
 * zero everywhere, or every nonzero written up with its reason.
 *
 *   DATABASE_URL=... npx tsx scripts/ledger-parity.ts
 *   ... --record   # also store the run, as the hourly cron does
 */
import { parityRuns, recordParity } from "../src/lib/ledger/parity";
import { shopToday } from "../src/lib/shopday";

const money = (c: number) => (c / 100).toLocaleString("en-US", { style: "currency", currency: "USD" });

async function main() {
  const record = process.argv.includes("--record");
  const runs = record ? await recordParity(shopToday()) : await parityRuns(shopToday());
  let nonzero = 0;
  for (const r of runs) {
    console.log(`\n${r.orgName} (org ${r.tenantOrgId}) - ${r.today}`);
    console.log(`  ${"figure".padEnd(26)} ${"legacy".padStart(14)} ${"ledger".padStart(14)} ${"diff".padStart(14)}`);
    for (const f of r.figures) {
      if (f.diffCents !== 0) nonzero++;
      console.log(`  ${f.label.padEnd(26)} ${money(f.legacyCents).padStart(14)} ${money(f.ledgerCents).padStart(14)} ${money(f.diffCents).padStart(14)}${f.diffCents ? "  <-" : ""}`);
    }
  }
  console.log(`\n[parity] ${nonzero === 0 ? "every figure agrees" : `${nonzero} figure${nonzero === 1 ? "" : "s"} differ - see the notes in lib/ledger/parity`}`);
}

main().then(() => process.exit(0)).catch((e) => { console.error("[parity] failed:", e.message); process.exit(1); });
