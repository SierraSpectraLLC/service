import { asc, eq } from "drizzle-orm";
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
 */
export async function getStageDefs(tenantOrgId: number | null = null): Promise<StageDef[]> {
  const rows = await db.select().from(stageDefs)
    .where(tenantOrgId === null ? undefined : eq(stageDefs.tenantOrgId, tenantOrgId))
    .orderBy(asc(stageDefs.sortOrder), asc(stageDefs.id));
  if (rows.length) return rows.map((r) => ({ id: r.id, name: r.name, bg: r.bg, fg: r.fg, builtin: r.builtin }));
  return STAGES.map((name, i) => ({
    id: -(i + 1), name, bg: STAGE_COLOR[name].bg, fg: STAGE_COLOR[name].fg, builtin: true,
  }));
}
