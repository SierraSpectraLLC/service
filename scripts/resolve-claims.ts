/**
 * Resolve every claim whose notice window has run with no objection.
 *   DATABASE_URL=... npx tsx scripts/resolve-claims.ts
 *
 * Cron-safe: the same call the daily route makes (api/cron/resolve-claims),
 * runnable by hand when the cron did not. A claim resolved twice is not a
 * thing - resolveSilently re-reads the row and refuses one that has moved.
 */
import { runClaimResolutions } from "../src/lib/custody/claims";

export async function main() {
  const { resolved, skipped } = await runClaimResolutions(new Date());
  console.log(`[claims] resolved ${resolved.length}: ${resolved.join(", ") || "-"}`);
  for (const s of skipped) console.log(`[claims]   skipped ${s.id}: ${s.why}`);
}

if (!process.env.VITEST) main().catch((e) => { console.error("[claims] failed:", e); process.exit(1); });
