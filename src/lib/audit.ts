import { eq } from "drizzle-orm";
import { db } from "@/db";
import { assets, auditLog, instruments } from "@/db/schema";

type AuditEntry = {
  actor: string;
  instrumentId?: number | null;
  // Set when the change concerns an asset - work on a standalone asset has no
  // instrument at all, and system work tagged to an asset carries both.
  assetId?: number | null;
  entityType: string;
  entityId?: string | number;
  action: string;
  field?: string;
  oldValue?: string;
  newValue?: string;
  /**
   * Whose workspace this line belongs to. Pass it when the caller has it in hand
   * (it almost always just read the record); left out, it is derived from the
   * system or asset named above, at the cost of one query. Null means a line
   * about the instance itself, which only platform staff read.
   */
  tenantOrgId?: number | null;
};

async function tenantFor(e: AuditEntry): Promise<number | null> {
  if (e.tenantOrgId !== undefined) return e.tenantOrgId;
  if (e.instrumentId != null) {
    const [i] = await db.select({ t: instruments.tenantOrgId }).from(instruments).where(eq(instruments.id, e.instrumentId));
    return i?.t ?? null;
  }
  if (e.assetId != null) {
    const [a] = await db.select({ t: assets.tenantOrgId }).from(assets).where(eq(assets.id, e.assetId));
    return a?.t ?? null;
  }
  return null;
}

/** Append-only. There is deliberately no update/delete helper for audit rows. */
export async function audit(e: AuditEntry) {
  await db.insert(auditLog).values({
    tenantOrgId: await tenantFor(e),
    actor: e.actor,
    instrumentId: e.instrumentId ?? null,
    assetId: e.assetId ?? null,
    entityType: e.entityType,
    entityId: String(e.entityId ?? ""),
    action: e.action,
    field: e.field ?? "",
    oldValue: e.oldValue ?? "",
    newValue: e.newValue ?? "",
  });
}
