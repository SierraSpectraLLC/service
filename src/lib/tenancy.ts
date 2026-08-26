import { cache } from "react";
import { and, asc, eq, inArray, isNull, or, type AnyColumn, type SQL } from "drizzle-orm";
import { db } from "@/db";
import { assets, assetShares, clientAllowlist, instruments, orgs, systemShares, workOrders } from "@/db/schema";
import type { Role, SessionUser } from "@/lib/authz";
import { maySeeBooks } from "@/lib/books";
import { isHouse } from "@/lib/houseRole";
import {
  actingOrgId, houseOfRecord, isPlatformStaff, tenantOf, tenantScope, tenantViewer,
} from "@/lib/tenants";

// Who can see what. Sierra Spectra staff (owner/staff, from STAFF_EMAILS) are
// the house and see everything. Everyone else belongs to one organization and
// sees exactly the systems shared with it - plus any asset their org owns
// outright. This module is the only place that answers those questions, so a
// new page or action gets tenancy right by calling it rather than remembering
// to write a filter.

export type ShareRow = { instrumentId: number; access: string };

// Defined in lib/houseRole (which imports nothing) and re-exported here so
// every existing server-side import keeps working. Client components must
// import it from lib/houseRole - this module reaches the database.
export { isHouse };

/**
 * The pre-tenancy pure core, kept as the shape every read path already speaks:
 * - no restriction (`all: true`)
 * - an org with no shares sees nothing (empty list, NOT unrestricted)
 * - a client with no org at all sees nothing
 *
 * The rules themselves moved to lib/tenants, where they also answer the question
 * this signature cannot ask - staff of WHICH service company - so this delegates
 * rather than keeping a second copy that could drift. A viewer with no operator
 * and no root is the single-house instance, which is what this used to assume.
 */
export function scopeFilter(
  role: Role,
  orgId: number | null,
  shares: ShareRow[],
): { all: true } | { all: false; ids: number[]; editable: Set<number> } {
  const s = tenantScope({ role, orgId, operatorOrgId: null, rootOperatorOrgId: null }, shares);
  return s.all ? { all: true } : { all: false, ids: s.ids, editable: s.editable };
}

/**
 * The viewer's scope, resolved once per call site.
 *
 * An operator's staff see their own workspace plus anything another operator has
 * shared with them, so the tenant's systems are listed here and the result stays
 * the id list every caller already handles. That materialization is deliberate:
 * it keeps one query and no call-site changes, and it is the same shape a client
 * org has always had. A tenant with thousands of systems should trade it for a
 * subquery behind this same function - the callers will not know either way.
 */
export async function scopeFor(user: SessionUser) {
  const v = tenantViewer(user);
  const asOrg = actingOrgId(v);
  const shares = asOrg === null ? [] : await db
    .select({ instrumentId: systemShares.instrumentId, access: systemShares.access })
    .from(systemShares).where(eq(systemShares.orgId, asOrg));
  const scope = tenantScope(v, shares);
  if (scope.all) return { all: true as const };
  const own = scope.tenantOrgId === null ? [] : (await db
    .select({ id: instruments.id }).from(instruments)
    .where(eq(instruments.tenantOrgId, scope.tenantOrgId))).map((r) => r.id);
  return {
    all: false as const,
    ids: [...new Set([...own, ...scope.ids])],
    // Their own workspace is theirs to work; a system shared in from another
    // needs the same edit-level share a provider org needs.
    editable: new Set([...own, ...scope.editable]),
  };
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
 * An asset is visible when it sits on a system the viewer can see, when the
 * viewer's own organization owns it (their spare on our bench), or when the
 * asset itself has been shared with their organization. Editing follows the
 * system it's on, ownership, or an edit-level asset share - always gated by
 * the editor role.
 */
export async function assetAccess(user: SessionUser, assetId: number): Promise<{ see: boolean; edit: boolean }> {
  const [a] = await db.select({
    instrumentId: assets.instrumentId, ownerOrgId: assets.ownerOrgId, tenantOrgId: assets.tenantOrgId,
  }).from(assets).where(eq(assets.id, assetId));
  if (!a) return { see: false, edit: false };
  const scope = await scopeFor(user);
  if (scope.all) return { see: true, edit: user.role !== "client_viewer" };
  // Staff of the workspace the unit belongs to: a spare on their own shelf is
  // theirs whether or not it is installed in anything yet.
  if (houseOfRecord(user, a.tenantOrgId)) return { see: true, edit: true };
  const [share] = user.orgId === null ? [] : await db.select({ access: assetShares.access })
    .from(assetShares).where(and(eq(assetShares.assetId, assetId), eq(assetShares.orgId, user.orgId)));
  const ownedByViewer = a.ownerOrgId !== null && a.ownerOrgId === user.orgId;
  const editorRights = user.role === "client_editor" &&
    (ownedByViewer || share?.access === "edit");
  if (a.instrumentId === null) {
    return { see: ownedByViewer || !!share, edit: editorRights };
  }
  const onVisible = scope.ids.includes(a.instrumentId);
  return {
    see: onVisible || ownedByViewer || !!share,
    edit: scope.editable.has(a.instrumentId) || editorRights,
  };
}

/** Asset ids the viewer may see: `null` = no restriction (the house). */
export async function visibleAssetIds(user: SessionUser): Promise<number[] | null> {
  const scope = await scopeFor(user);
  if (scope.all) return null;
  const asOrg = actingOrgId(tenantViewer(user));
  const shared = asOrg === null ? [] : (
    await db.select({ assetId: assetShares.assetId }).from(assetShares).where(eq(assetShares.orgId, asOrg))
  ).map((s) => s.assetId);
  const rows = await db.select({ id: assets.id }).from(assets).where(
    or(
      scope.ids.length ? inArray(assets.instrumentId, scope.ids) : undefined,
      // Their own workspace's units, installed or on the shelf.
      forTenant(assets.tenantOrgId, readTenant(user)),
      user.orgId === null ? undefined : and(isNull(assets.instrumentId), eq(assets.ownerOrgId, user.orgId)),
      shared.length ? inArray(assets.id, shared) : undefined,
    )
  );
  return rows.map((r) => r.id);
}

/**
 * The tenant a staff-facing list is restricted to, or null for no restriction -
 * which is platform staff, and an instance that has not named an operator.
 *
 * Pair with forTenant() in a where clause. Deliberately NOT for records a client
 * reads: vocabulary, people and prices on a client's own system page follow the
 * SYSTEM's tenant, not the reader's, or a client of one operator would see an
 * empty catalog.
 */
export const readTenant = (u: SessionUser): number | null =>
  isPlatformStaff(tenantViewer(u)) ? null : u.operatorOrgId;

/**
 * The workspace whose shared vocabulary this viewer reads - stage names, catalog
 * models, the roster. Staff read their own; a client reads their operator's,
 * because the vocabulary on their system page is the vocabulary of whoever
 * services it. Null = no restriction (platform staff, or no operator named yet).
 *
 * cache() so a page that asks twice pays once.
 */
export const viewTenant = cache(async (user: SessionUser): Promise<number | null> => {
  const v = tenantViewer(user);
  if (isPlatformStaff(v)) return null;
  return user.operatorOrgId ?? await tenantOfOrg(user.orgId);
});

/** `eq(col, tenant)`, or no condition at all when there is nothing to restrict to. */
export const forTenant = (col: AnyColumn, tenantOrgId: number | null): SQL | undefined =>
  tenantOrgId === null ? undefined : eq(col, tenantOrgId);

/**
 * Organizations this viewer may see by name.
 *
 * The leak this closes: every page that offered a share picker used to ship the
 * whole instance's organization list to the browser and filter it there. With one
 * operator that was untidy; with two it hands a competitor your client list.
 *
 * Operators stay visible to everyone, because that is the directory that makes
 * cross-company work possible - a client bringing in another service company has
 * to be able to name it. Clients are visible only inside their own tenant.
 *
 * With one exception: the operator that RUNS the instance. It is the landlord,
 * not a peer on the directory, and it is the one company every other workspace
 * would otherwise see named in its own org list, share pickers and queue
 * badges - which is how a workspace handed to somebody else told them who the
 * seller was. Its own clients still see it through the tenantOf test below,
 * because it IS their provider, and its own staff read `t === null` above and
 * see the whole instance unchanged.
 */
export async function visibleOrgs(user: SessionUser) {
  const t = readTenant(user);
  // Full rows: every caller picks its own fields, and one shape means one place
  // to change when the rule changes.
  const rows = await db.select().from(orgs).orderBy(asc(orgs.name));
  if (t === null) return rows;
  const root = user.rootOperatorOrgId;
  return rows.filter((o) =>
    (o.isOperator && o.id !== root) || tenantOf(o) === t || o.id === user.orgId);
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
  row: { instrumentId: number | null; assetId?: number | null; workOrderId?: number | null } | null | undefined,
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
  // A row with no record behind it belongs to a job that has none either - a
  // client's move or survey. The job answers for it: their own, and theirs to
  // edit. Anyone else gets the "Not found" below.
  if (row.workOrderId) {
    const [wo] = await db.select({
      instrumentId: workOrders.instrumentId, assetId: workOrders.assetId, orgId: workOrders.orgId,
    }).from(workOrders).where(eq(workOrders.id, row.workOrderId));
    if (wo && wo.instrumentId === null && wo.assetId === null
      && user.orgId !== null && wo.orgId === user.orgId && user.role === "client_editor") return;
  }
  throw new Error("Not found");
}

/**
 * Which tenant an organization belongs to - itself when it runs a workspace, its
 * operator otherwise. The database half of lib/tenants.tenantOf, for the places
 * that hold an org id and need to know whose workspace it sits in.
 */
export async function tenantOfOrg(orgId: number | null): Promise<number | null> {
  if (orgId === null) return null;
  const [org] = await db.select({ id: orgs.id, parentOrgId: orgs.parentOrgId, isOperator: orgs.isOperator })
    .from(orgs).where(eq(orgs.id, orgId));
  return org ? tenantOf(org) : null;
}

/** The tenant a unit belongs to, or null when it is gone or unstamped. */
export async function tenantOfAsset(assetId: number): Promise<number | null> {
  const [a] = await db.select({ tenantOrgId: assets.tenantOrgId })
    .from(assets).where(eq(assets.id, assetId));
  return a?.tenantOrgId ?? null;
}

/** The tenant a system belongs to, or null when it is gone or unstamped. */
export async function tenantOfSystem(instrumentId: number): Promise<number | null> {
  const [i] = await db.select({ tenantOrgId: instruments.tenantOrgId })
    .from(instruments).where(eq(instruments.id, instrumentId));
  return i?.tenantOrgId ?? null;
}


/**
 * May this person read an organization's agreements?
 *
 * The house always can - it wrote them. For a client, it is a per-person
 * privilege on their sign-in entry (client_allowlist.can_see_agreements),
 * because "can see the system" and "can see what we pay for it" are different
 * questions and one org has people on both sides of that line.
 */
export async function maySeeAgreements(
  user: { role: string; email: string; orgId: number | null },
  orgId: number,
): Promise<boolean> {
  if (user.role === "owner" || user.role === "staff") return true;
  if (user.orgId !== orgId) return false;
  const rows = await db.select({ canSee: clientAllowlist.canSeeAgreements })
    .from(clientAllowlist)
    .where(and(eq(clientAllowlist.orgId, orgId), eq(clientAllowlist.entry, user.email.toLowerCase())));
  // A domain-wildcard entry (@lab.com) has no row of its own for this person;
  // absence of an explicit grant is not a denial, it is "the org's default",
  // and the org's default is what everyone had before this switch existed.
  return rows.length === 0 ? true : rows[0].canSee;
}

/**
 * May this person read their own organization's MONEY - the quotes it has been
 * sent and the invoices it owes?
 *
 * The client half of the books rule. An operator has an owner role, so keeping
 * its position to the owner is a rule rather than a setting (lib/books, and
 * the /money section enforces it); a client organization has no owner role, so
 * the same wall has to be a per-person flag on the sign-in entry, exactly as
 * agreements are.
 *
 * Staff pass through: they do not read a client's money HERE - /orders is the
 * client's own room and sends them to /money, which has its own gate. Denying
 * them at this function would just be a second answer to a question already
 * answered somewhere better.
 */
export async function maySeeOrgMoney(
  user: { role: string; email: string; orgId: number | null },
  orgId: number,
): Promise<boolean> {
  if (isHouse(user.role)) return true;
  const rows = await db.select({ canSee: clientAllowlist.canSeeMoney })
    .from(clientAllowlist)
    .where(and(eq(clientAllowlist.orgId, orgId), eq(clientAllowlist.entry, user.email.toLowerCase())));
  // Same reading as maySeeAgreements: a domain-wildcard entry (@lab.com) has
  // no row of its own, and no row is the org's default rather than a denial.
  return maySeeBooks({
    email: user.email, role: user.role, orgId: user.orgId, operatorOrgId: null,
    canSeeMoney: rows.length === 0 ? true : rows[0].canSee,
  }, orgId);
}
