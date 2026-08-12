// Many service companies, one instance.
//
// The portal began as one shop's tool: "the house" (owner/staff) saw everything,
// and every other organization saw exactly what was shared with it. That is one
// operator with many clients. Selling the platform to other service companies
// needs a second axis - many operators, each with their own clients, none of them
// seeing each other - without giving up the thing that makes the product work:
// two service companies collaborating on one instrument.
//
// The model, in three sentences:
//
//   * An organization can be an OPERATOR - a service company that runs a
//     workspace: it has staff, it signs documents, and it may create client
//     organizations of its own. Those clients carry parentOrgId = the operator.
//   * Every record belongs to exactly one TENANT, stamped at creation
//     (tenantOrgId) and never derived. Staff see their tenant's records.
//   * Sharing crosses tenants. An operator org can be the target of a share, so
//     "LabZen's system, serviced by Sierra Spectra" is one row in system_shares -
//     the same mechanism a client already uses to bring in a provider.
//
// The consequence worth stating: staff of the operator that runs the instance
// (the ROOT operator) see every tenant, because somebody has to be able to
// support them. Everyone else is boxed in by their tenant plus what has been
// explicitly shared with them.
//
// Nothing here touches the database. The rules are pure so they can be tested as
// a table rather than discovered in production, and so client components can ask
// the cheap questions.

export type Role = "owner" | "staff" | "client_editor" | "client_viewer";

/** An org's place in the tree. `isOperator` orgs are tenants; the rest are members of one. */
export type OrgNode = { id: number; parentOrgId: number | null; isOperator: boolean };

/**
 * Where a viewer stands. Assembled by lib/authz from the session, so every rule
 * below can be answered without another query.
 */
export type TenantViewer = {
  role: string;
  /** The operator whose staff this person is. Null for organization members. */
  operatorOrgId: number | null;
  /** The organization this person belongs to when they are not staff. */
  orgId: number | null;
  /** The operator that runs the instance. Its staff support every tenant. */
  rootOperatorOrgId: number | null;
};

export type ShareRow = { instrumentId: number; access: string };

export const isStaffRole = (role: string) => role === "owner" || role === "staff";

/**
 * Which tenant an organization belongs to: itself when it runs a workspace, else
 * the operator that created it. Null means an org nobody owns - a client whose
 * operator was removed - which is visible to platform staff only, on purpose.
 */
export function tenantOf(org: OrgNode): number | null {
  return org.isOperator ? org.id : org.parentOrgId;
}

/**
 * Staff of the operator that runs the instance. They see every tenant.
 *
 * The second clause is the pre-tenancy world: an instance that never named an
 * operator organization has one house, and its staff are it. Note what the rule
 * deliberately does NOT say - "root is missing, so everyone is platform staff".
 * On a configured instance a transient failure to read the root must not promote
 * another operator's staff to seeing every tenant, so both halves have to be
 * absent, and a staff row with an operator on an instance with no root reads as
 * nothing rather than everything.
 */
export function isPlatformStaff(v: TenantViewer): boolean {
  if (!isStaffRole(v.role)) return false;
  if (v.rootOperatorOrgId === null) return v.operatorOrgId === null;
  return v.operatorOrgId === v.rootOperatorOrgId;
}

/**
 * The organization a viewer acts as: their operator when they are staff, their
 * own organization otherwise. This is the id that appears in shares, in audit
 * lines about "who did this", and in the queue.
 */
export function actingOrgId(v: TenantViewer): number | null {
  return isStaffRole(v.role) ? v.operatorOrgId : v.orgId;
}

/**
 * Is this viewer the house for a record in `tenantOrgId` - the service company
 * whose record it is, rather than a partner who has been let in?
 *
 * This replaces the old global isHouse(role). The distinction it draws is the one
 * the app already relies on everywhere: the house sees costs, manages shares,
 * signs the work off. An operator's staff looking at an instrument shared INTO
 * their tenant by another operator are not its house - they are a provider on it,
 * which is exactly what they are.
 */
export function isHouseOf(v: TenantViewer, tenantOrgId: number | null): boolean {
  if (!isStaffRole(v.role)) return false;
  if (isPlatformStaff(v)) return true;
  return v.operatorOrgId !== null && tenantOrgId !== null && v.operatorOrgId === tenantOrgId;
}

/**
 * The conversion primitive, for the places that used to ask isHouse(role).
 *
 * A viewer here may be a partially-shaped one - a client component's props, a
 * test's literal - so the tenancy fields are optional. `tenantOrgId` of
 * `undefined` means the caller genuinely does not have the record's tenant in
 * hand and keeps the pre-tenancy answer (any staff is the house). That escape
 * hatch is deliberate and greppable: it should shrink over time, and every use of
 * it is a place where one operator's staff still answers as another's.
 */
export type MaybeTenantViewer = {
  role: string; orgId: number | null;
  operatorOrgId?: number | null; rootOperatorOrgId?: number | null;
};

export function houseOfRecord(v: MaybeTenantViewer, tenantOrgId: number | null | undefined): boolean {
  if (tenantOrgId === undefined) return isStaffRole(v.role);
  return isHouseOf({
    role: v.role, orgId: v.orgId,
    operatorOrgId: v.operatorOrgId ?? null,
    rootOperatorOrgId: v.rootOperatorOrgId ?? null,
  }, tenantOrgId);
}

/**
 * What a viewer may see.
 *
 * `{ all: true }` is platform staff - no filter at all, as the house had before
 * tenants existed. Everyone else gets a tenant (theirs, or null for an org
 * member) plus an explicit list of ids shared with them, and callers must treat
 * an empty list as "nothing", never as "everything".
 *
 * Staff with no operator is a misconfiguration - a staff row whose organization
 * was removed - and resolves to nothing rather than to everything. Failing closed
 * on a broken row is the only safe direction when the alternative is showing one
 * company's fleet to another.
 */
export type TenantScope =
  | { all: true }
  | { all: false; tenantOrgId: number | null; ids: number[]; editable: Set<number> };

export function tenantScope(v: TenantViewer, shares: ShareRow[]): TenantScope {
  if (isPlatformStaff(v)) return { all: true };
  const ids = [...new Set(shares.map((s) => s.instrumentId))];
  if (isStaffRole(v.role)) {
    // Own tenant in full, plus whatever another operator's client has shared in.
    // Staff edit their own tenant's work; on a shared-in system they need the
    // same edit-level share a provider org needs.
    return {
      all: false,
      tenantOrgId: v.operatorOrgId,
      ids,
      editable: new Set(shares.filter((s) => s.access === "edit").map((s) => s.instrumentId)),
    };
  }
  if (v.orgId === null) return { all: false, tenantOrgId: null, ids: [], editable: new Set() };
  return {
    all: false,
    tenantOrgId: null,
    ids,
    editable: new Set(
      v.role === "client_editor" ? shares.filter((s) => s.access === "edit").map((s) => s.instrumentId) : [],
    ),
  };
}

/** Does this scope reach one particular record? `tenantOrgId` is the record's. */
export function scopeSees(scope: TenantScope, record: { tenantOrgId: number | null; id: number }): boolean {
  if (scope.all) return true;
  if (scope.tenantOrgId !== null && record.tenantOrgId === scope.tenantOrgId) return true;
  return scope.ids.includes(record.id);
}

/** May this viewer create organizations? Any operator's staff, for their own tenant. */
export function mayCreateOrgs(v: TenantViewer): boolean {
  return isStaffRole(v.role) && (v.operatorOrgId !== null || isPlatformStaff(v));
}

/**
 * May this viewer administer `org` - grant its people access, set its dials,
 * share systems with it? Only its own operator's staff, and platform staff.
 *
 * The guard that matters is the negative one: an operator must not be able to
 * touch another operator's client, or another operator, however the id arrives.
 */
export function mayAdminOrg(v: TenantViewer, org: OrgNode): boolean {
  if (!isStaffRole(v.role)) return false;
  if (isPlatformStaff(v)) return true;
  if (v.operatorOrgId === null) return false;
  if (org.isOperator) return org.id === v.operatorOrgId;   // their own workspace, nobody else's
  return org.parentOrgId === v.operatorOrgId;
}
