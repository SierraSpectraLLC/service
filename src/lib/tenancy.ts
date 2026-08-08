import { and, eq, inArray, isNull, or } from "drizzle-orm";
import { db } from "@/db";
import { assets, systemShares } from "@/db/schema";
import type { Role, SessionUser } from "@/lib/authz";

// Who can see what. Sierra Spectra staff (owner/staff, from STAFF_EMAILS) are
// the house and see everything. Everyone else belongs to one organization and
// sees exactly the systems shared with it - plus any asset their org owns
// outright. This module is the only place that answers those questions, so a
// new page or action gets tenancy right by calling it rather than remembering
// to write a filter.

export type ShareRow = { instrumentId: number; access: string };

export const isHouse = (role: Role) => role === "owner" || role === "staff";

/**
 * Pure core, kept separate from the DB so the rules are testable:
 * - the house sees everything (`null` = no restriction)
 * - an org with no shares sees nothing (empty list, NOT unrestricted)
 * - a client with no org at all sees nothing
 */
export function scopeFilter(
  role: Role,
  orgId: number | null,
  shares: ShareRow[],
): { all: true } | { all: false; ids: number[]; editable: Set<number> } {
  if (isHouse(role)) return { all: true };
  if (orgId === null) return { all: false, ids: [], editable: new Set() };
  const ids = [...new Set(shares.map((s) => s.instrumentId))];
  // A view-level share is read-only however the org's role is set; edit needs
  // both an edit share and the client-edit toggle (role === client_editor).
  const editable = new Set(
    role === "client_editor" ? shares.filter((s) => s.access === "edit").map((s) => s.instrumentId) : []
  );
  return { all: false, ids, editable };
}

/** The viewer's scope, resolved once per call site. */
export async function scopeFor(user: SessionUser) {
  if (isHouse(user.role)) return scopeFilter(user.role, null, []);
  const shares = user.orgId === null ? [] : await db
    .select({ instrumentId: systemShares.instrumentId, access: systemShares.access })
    .from(systemShares).where(eq(systemShares.orgId, user.orgId));
  return scopeFilter(user.role, user.orgId, shares);
}

/**
 * Instrument ids the viewer may see: `null` for the house (no filter), else an
 * explicit list. Callers must treat `[]` as "nothing", never as "everything".
 */
export async function visibleSystemIds(user: SessionUser): Promise<number[] | null> {
  const scope = await scopeFor(user);
  return scope.all ? null : scope.ids;
}

export async function canSeeSystem(user: SessionUser, instrumentId: number): Promise<boolean> {
  const scope = await scopeFor(user);
  return scope.all || scope.ids.includes(instrumentId);
}

export async function canEditSystem(user: SessionUser, instrumentId: number): Promise<boolean> {
  const scope = await scopeFor(user);
  return scope.all ? user.role !== "client_viewer" : scope.editable.has(instrumentId);
}

/**
 * An asset is visible when it sits on a system the viewer can see, or when the
 * viewer's own organization owns it (their spare on our bench). Editing follows
 * the system it's on; an org's own unattached asset is editable by its editors.
 */
export async function assetAccess(user: SessionUser, assetId: number): Promise<{ see: boolean; edit: boolean }> {
  const [a] = await db.select({ instrumentId: assets.instrumentId, ownerOrgId: assets.ownerOrgId })
    .from(assets).where(eq(assets.id, assetId));
  if (!a) return { see: false, edit: false };
  const scope = await scopeFor(user);
  if (scope.all) return { see: true, edit: user.role !== "client_viewer" };
  const ownedByViewer = a.ownerOrgId !== null && a.ownerOrgId === user.orgId;
  if (a.instrumentId === null) {
    return { see: ownedByViewer, edit: ownedByViewer && user.role === "client_editor" };
  }
  const onVisible = scope.ids.includes(a.instrumentId);
  return {
    see: onVisible || ownedByViewer,
    edit: scope.editable.has(a.instrumentId) || (ownedByViewer && user.role === "client_editor"),
  };
}

/** Asset ids the viewer may see: `null` = no restriction (the house). */
export async function visibleAssetIds(user: SessionUser): Promise<number[] | null> {
  const scope = await scopeFor(user);
  if (scope.all) return null;
  const rows = await db.select({ id: assets.id }).from(assets).where(
    or(
      scope.ids.length ? inArray(assets.instrumentId, scope.ids) : undefined,
      user.orgId === null ? undefined : and(isNull(assets.instrumentId), eq(assets.ownerOrgId, user.orgId)),
    )
  );
  return rows.map((r) => r.id);
}

// ---- assertions for server actions -----------------------------------------
// Thrown messages are masked in production, so they double as the log line.

export async function assertSystemVisible(user: SessionUser, instrumentId: number) {
  if (!(await canSeeSystem(user, instrumentId))) throw new Error("Not found");
}

export async function assertSystemEditable(user: SessionUser, instrumentId: number) {
  if (!(await canSeeSystem(user, instrumentId))) throw new Error("Not found");
  if (!(await canEditSystem(user, instrumentId))) throw new Error("Read-only access to this system");
}

/**
 * Guard for a work row (task, part, gas, file, note) that belongs to a system,
 * a standalone asset, or both. Used by resolveTarget and the row mutations.
 */
export async function assertWorkEditable(
  user: SessionUser,
  // Undefined when the parent row is gone (an orphaned note, say) - treat that
  // as not found rather than letting a property access throw.
  row: { instrumentId: number | null; assetId?: number | null } | null | undefined,
) {
  if (isHouse(user.role)) return;
  if (!row) throw new Error("Not found");
  if (row.instrumentId !== null) { await assertSystemEditable(user, row.instrumentId); return; }
  if (row.assetId) {
    const a = await assetAccess(user, row.assetId);
    if (!a.see) throw new Error("Not found");
    if (!a.edit) throw new Error("Read-only access to this asset");
    return;
  }
  throw new Error("Not found");
}
