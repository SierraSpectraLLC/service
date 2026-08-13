// Where a batch of tasks may be copied to.
//
// Server-only. The list is "systems this person may write to, other than the one
// they are standing on" - offering the current record would be a duplicate
// button, and offering one they can only read would be a button the server
// refuses, which the rest of this app takes care not to do.
import { and, asc, inArray, ne, sql } from "drizzle-orm";
import { db } from "@/db";
import { instruments } from "@/db/schema";
import { scopeFor } from "@/lib/tenancy";
import type { SessionUser } from "@/lib/authz";

/** Capped: a picker of four hundred systems is a search box, not a dropdown. */
const CAP = 300;

export async function copyTargetsFor(
  user: SessionUser, exceptInstrumentId: number | null,
): Promise<{ key: string; label: string }[]> {
  if (user.role === "client_viewer") return [];
  const scope = await scopeFor(user);
  const rows = await db.select({
    id: instruments.id, externalId: instruments.externalId, client: instruments.client,
  }).from(instruments)
    .where(and(
      sql`${instruments.archived} = false`,
      exceptInstrumentId === null ? undefined : ne(instruments.id, exceptInstrumentId),
      scope.all ? undefined : scope.ids.length ? inArray(instruments.id, scope.ids) : sql`false`,
    ))
    .orderBy(asc(instruments.externalId))
    .limit(CAP)
    .catch(() => []);
  return rows
    .filter((s) => (scope.all ? true : scope.editable.has(s.id)))
    .map((s) => ({ key: `i:${s.id}`, label: `${s.externalId}${s.client ? ` \u00b7 ${s.client}` : ""}` }));
}
