// What gets blacked out for whom. Part cost and PO number are the operator's
// (and the paying client's) business data: platform staff and the organization
// that PAID see them; every other party on a shared system - service providers
// above all - sees them blank. Vendor stays visible: it says where a part came
// from, not what was paid.
import type { SessionUser } from "@/lib/authz";
import { houseOfRecord } from "@/lib/tenants";

export type CostViewer = Pick<SessionUser, "role" | "orgId">
  & Partial<Pick<SessionUser, "operatorOrgId" | "rootOperatorOrgId">>;

/**
 * `tenantOrgId` is the record's own tenant, and passing it is what keeps this
 * honest on an instance with more than one service company: being staff makes you
 * the house of YOUR work, not of a system another operator shared with you. An
 * engineer invited onto somebody else's instrument sees the same blanks a provider
 * org sees - which is the whole reason two competitors can share a platform.
 *
 * Omitting it keeps the old answer (any staff sees costs) and is only right where
 * the record's tenant genuinely isn't in hand.
 */
export function canSeeCosts(
  user: CostViewer, ownerOrgId: number | null, tenantOrgId?: number | null,
): boolean {
  if (houseOfRecord(user, tenantOrgId)) return true;
  return user.orgId !== null && user.orgId === ownerOrgId;
}

/** Blank the priced fields on a part row. Cheap enough to run on every read. */
export function redactPart<T extends { cost: string; po: string; costCents?: number | null }>(row: T): T {
  // costCents is the same number in another shape - blanking the text while
  // shipping the cents would be redaction theater.
  return { ...row, cost: "", po: "", costCents: null };
}

/**
 * Per-row redaction. A part's cost belongs to whoever bought it, so each row is
 * judged on its own owner stamp rather than on who owns the system today. That
 * distinction only matters after a handoff - and it matters a lot: repointing
 * ownership must not hand the new owner sight of every price the previous owner
 * paid. Rows with no stamp predate handoffs and fall back to the system's
 * owner, which is what they were bought under.
 */
export function redactParts<
  T extends { cost: string; po: string; costCents?: number | null; ownerOrgId?: number | null },
>(
  rows: T[],
  viewer: CostViewer,
  systemOwnerOrgId: number | null,
  tenantOrgId?: number | null,
): T[] {
  return rows.map((r) =>
    canSeeCosts(viewer, r.ownerOrgId ?? systemOwnerOrgId, tenantOrgId) ? r : redactPart(r));
}
