import { asc, eq, isNull, or } from "drizzle-orm";
import { db } from "@/db";
import { stageDefs } from "@/db/schema";
import { STAGES, STAGE_COLOR } from "@/lib/stages";

export type StageDef = { id: number; name: string; bg: string; fg: string; builtin: boolean };

/**
 * The live stage vocabulary, in display order. Falls back to the built-ins if the
 * table hasn't been seeded yet (fresh DB before schema-sync runs).
 *
 * `tenantOrgId` scopes it to one workspace's own stages - pass lib/tenancy's
 * viewTenant(user), or a record's tenant when the vocabulary should follow the
 * record. Null means no restriction, which is platform staff and pre-tenancy
 * instances.
 *
 * A row with NO tenant is included whatever the scope. Those are seeded
 * built-ins: the seed runs on every deploy and the one-shot backfill that
 * stamps them ran long ago, so a built-in ADDED to the seed later arrives
 * unclaimed and would otherwise be invisible to every workspace on the instance
 * - which is exactly what happened to "In service" and "Maintenance due", and
 * showed up as being unable to put a system into a stage the list offered.
 * Custom stages are stamped at creation (tests/tenantStamp.test.ts enforces it),
 * so unclaimed can only mean built-in, and a built-in belongs to everybody.
 */
export async function getStageDefs(tenantOrgId: number | null = null): Promise<StageDef[]> {
  const rows = await db.select().from(stageDefs)
    .where(tenantOrgId === null ? undefined
      : or(eq(stageDefs.tenantOrgId, tenantOrgId), isNull(stageDefs.tenantOrgId)))
    .orderBy(asc(stageDefs.sortOrder), asc(stageDefs.id));
  if (rows.length) return rows.map((r) => ({ id: r.id, name: r.name, bg: r.bg, fg: r.fg, builtin: r.builtin }));
  return STAGES.map((name, i) => ({
    id: -(i + 1), name, bg: STAGE_COLOR[name].bg, fg: STAGE_COLOR[name].fg, builtin: true,
  }));
}
