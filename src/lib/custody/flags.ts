// Rollout switches for the custody work, by name.
//
// ABSENT READS AS OFF, and every failure reads as off. A flag nobody has
// created, on a database nobody has migrated, behaves exactly as the app did
// before - which is what makes it safe to deploy the new read path ahead of
// anybody deciding to use it. A flag that throws is a flag that is off: the old
// path is always the one that works.
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { featureFlags } from "@/db/schema";

/**
 * The six switches the custody phases roll out behind. Named as a union rather
 * than free strings so a typo is a build error instead of a feature that
 * silently never turns on.
 */
export type CustodyFlag =
  | "custody.readPath"
  | "custody.twoBox"
  | "custody.transfers"
  | "custody.claims"
  | "custody.sheets"
  | "custody.score";

/**
 * Per-request memo. Server actions and page renders each ask two or three
 * times; the process is short-lived and a stale answer within one render is
 * better than three round trips for one boolean.
 */
const seen = new Map<string, { at: number; on: boolean }>();
const TTL_MS = 5_000;

export async function flagOn(key: CustodyFlag): Promise<boolean> {
  const hit = seen.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.on;
  let on = false;
  try {
    const [row] = await db.select({ enabled: featureFlags.enabled })
      .from(featureFlags).where(eq(featureFlags.key, key)).limit(1);
    on = row?.enabled ?? false;
  } catch {
    // A missing table on an un-migrated database is the ordinary case during a
    // rollout, not an incident. Off is the old behavior, which works.
    on = false;
  }
  seen.set(key, { at: Date.now(), on });
  return on;
}

/** For tests and for the settings screen that will set these in Phase 4. */
export function forgetFlags(): void {
  seen.clear();
}
