// What gets blacked out for whom. Part cost and PO number are the operator's
// (and the paying client's) business data: platform staff and the system's
// owning organization see them; every other party on a shared system - service
// providers above all - sees them blank. Vendor stays visible: it says where a
// part came from, not what was paid.
import type { SessionUser } from "@/lib/authz";
import { isHouse } from "@/lib/tenancy";

export function canSeeCosts(user: Pick<SessionUser, "role" | "orgId">, ownerOrgId: number | null): boolean {
  if (isHouse(user.role)) return true;
  return user.orgId !== null && user.orgId === ownerOrgId;
}

/** Blank the priced fields on a part row. Cheap enough to run on every read. */
export function redactPart<T extends { cost: string; po: string }>(row: T): T {
  return { ...row, cost: "", po: "" };
}

export function redactParts<T extends { cost: string; po: string }>(rows: T[], showCosts: boolean): T[] {
  return showCosts ? rows : rows.map(redactPart);
}
