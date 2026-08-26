import { eq, inArray } from "drizzle-orm";
import { db } from "@/db";
import { instruments, orgs, systemShares } from "@/db/schema";
import { partyChoices, type PartyChoice } from "@/lib/parties";

/**
 * The organizations with a real hold on one system - the workspace it lives
 * in, the organization that owns it, and anyone it is shared with to work on.
 *
 * Read here rather than assembled twice, because the picker a person sees and
 * the list the server will accept have to be the same list. A picker that
 * offered more than the action allowed would fail on save; one that offered
 * less would quietly make an option unreachable. Deliberately not every org on
 * the instance - see lib/parties.
 */
export async function systemParties(
  inst: { id: number; tenantOrgId: number | null; ownerOrgId: number | null },
  viewerOrgId: number | null,
): Promise<PartyChoice[]> {
  const shared = (await db.select({ orgId: systemShares.orgId })
    .from(systemShares).where(eq(systemShares.instrumentId, inst.id))).map((r) => r.orgId);
  const ids = [...new Set([inst.tenantOrgId, inst.ownerOrgId, ...shared]
    .filter((x): x is number => typeof x === "number"))];
  if (ids.length === 0) return [];
  const rows = await db.select({ id: orgs.id, name: orgs.name, isOperator: orgs.isOperator })
    .from(orgs).where(inArray(orgs.id, ids));
  const byId = new Map(rows.map((o) => [o.id, o]));
  const parties = ids.flatMap((id) => {
    const o = byId.get(id);
    if (!o) return [];
    // The note says WHY this org is on the list, because on a shared bench two
    // of the three can be the same kind of company and the names alone do not
    // tell you which one is the owner.
    const note = id === inst.tenantOrgId ? "working it"
      : id === inst.ownerOrgId ? "owns it"
        : "shared with";
    return [{ id, name: o.name, note }];
  });
  return partyChoices(parties, viewerOrgId);
}

/** The same list, for the one system a caller already holds by id. */
export async function systemPartiesFor(
  instrumentId: number, viewerOrgId: number | null,
): Promise<PartyChoice[]> {
  const [inst] = await db.select({
    id: instruments.id, tenantOrgId: instruments.tenantOrgId, ownerOrgId: instruments.ownerOrgId,
  }).from(instruments).where(eq(instruments.id, instrumentId));
  return inst ? systemParties(inst, viewerOrgId) : [];
}
