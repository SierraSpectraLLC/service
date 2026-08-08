import { db } from "@/db";
import { auditLog } from "@/db/schema";

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
};

/** Append-only. There is deliberately no update/delete helper for audit rows. */
export async function audit(e: AuditEntry) {
  await db.insert(auditLog).values({
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
