import { describe, expect, it } from "vitest";
import {
  actingOrgId, isHouseOf, isPlatformStaff, mayAdminOrg, mayCreateOrgs,
  scopeSees, tenantOf, tenantScope, type OrgNode, type TenantViewer,
} from "@/lib/tenants";

/**
 * Two service companies on one instance. The failure this file exists to prevent
 * is one operator seeing the other's fleet - so every rule is checked from both
 * sides, and every misconfiguration is checked to fail closed.
 *
 * The cast: SIERRA (id 1) runs the instance. LABZEN (id 2) is a second operator
 * who bought the product. Each has clients - ACME (3) under Sierra, WESTLAB (4)
 * under LabZen.
 */
const SIERRA = 1, LABZEN = 2, ACME = 3, WESTLAB = 4;

const orgs: Record<number, OrgNode> = {
  [SIERRA]: { id: SIERRA, parentOrgId: null, isOperator: true },
  [LABZEN]: { id: LABZEN, parentOrgId: null, isOperator: true },
  [ACME]: { id: ACME, parentOrgId: SIERRA, isOperator: false },
  [WESTLAB]: { id: WESTLAB, parentOrgId: LABZEN, isOperator: false },
};

const viewer = (over: Partial<TenantViewer> = {}): TenantViewer => ({
  role: "staff", operatorOrgId: SIERRA, orgId: null, rootOperatorOrgId: SIERRA, ...over,
});

const platform = viewer();
const labzenStaff = viewer({ operatorOrgId: LABZEN });
const labzenOwner = viewer({ role: "owner", operatorOrgId: LABZEN });
const acmeEditor = viewer({ role: "client_editor", operatorOrgId: null, orgId: ACME });
const acmeViewer = viewer({ role: "client_viewer", operatorOrgId: null, orgId: ACME });

describe("where an organization sits", () => {
  it("makes an operator its own tenant", () => {
    expect(tenantOf(orgs[LABZEN])).toBe(LABZEN);
  });

  it("puts a client in its operator's tenant", () => {
    expect(tenantOf(orgs[WESTLAB])).toBe(LABZEN);
  });

  it("leaves an orphaned client in no tenant, not in everyone's", () => {
    expect(tenantOf({ id: 9, parentOrgId: null, isOperator: false })).toBeNull();
  });
});

describe("who is platform staff", () => {
  it("is the root operator's staff, and only them", () => {
    expect(isPlatformStaff(platform)).toBe(true);
    expect(isPlatformStaff(labzenStaff)).toBe(false);
    expect(isPlatformStaff(labzenOwner)).toBe(false);
  });

  it("is never a client, whatever their org", () => {
    expect(isPlatformStaff(viewer({ role: "client_editor", operatorOrgId: null, orgId: SIERRA }))).toBe(false);
  });

  it("is the plain staff of an instance that never named an operator", () => {
    // The world before tenancy: one house, and this is it. Every existing
    // deployment keeps working before anyone configures anything.
    expect(isPlatformStaff(viewer({ operatorOrgId: null, rootOperatorOrgId: null }))).toBe(true);
    expect(tenantScope(viewer({ operatorOrgId: null, rootOperatorOrgId: null }), [])).toEqual({ all: true });
  });

  it("does not promote a tenant's staff when the root can't be read", () => {
    // The dangerous version of the rule above. If a lookup fails and the root
    // comes back null, LabZen's staff must not become platform staff and see
    // every tenant on the instance - so they read as nothing instead.
    const v = viewer({ operatorOrgId: LABZEN, rootOperatorOrgId: null });
    expect(isPlatformStaff(v)).toBe(false);
    expect(tenantScope(v, [])).toMatchObject({ all: false, tenantOrgId: LABZEN });
    expect(isHouseOf(v, SIERRA)).toBe(false);
    // Their own tenant is unaffected - a failed lookup elsewhere must not lock a
    // company out of its own records.
    expect(isHouseOf(v, LABZEN)).toBe(true);
  });
});

describe("who acts as whom", () => {
  it("has staff act as their operator and members as themselves", () => {
    expect(actingOrgId(labzenStaff)).toBe(LABZEN);
    expect(actingOrgId(acmeEditor)).toBe(ACME);
  });
});

describe("who is the house of a record", () => {
  it("is the operator whose tenant it is", () => {
    expect(isHouseOf(labzenStaff, LABZEN)).toBe(true);
    expect(isHouseOf(labzenStaff, SIERRA)).toBe(false);
  });

  it("is platform staff everywhere, because somebody has to support a tenant", () => {
    expect(isHouseOf(platform, LABZEN)).toBe(true);
    expect(isHouseOf(platform, null)).toBe(true);
  });

  it("is never a client of that tenant", () => {
    // A client editor works the record; it is not their record.
    expect(isHouseOf(acmeEditor, SIERRA)).toBe(false);
  });

  it("is not an operator invited onto another operator's system", () => {
    // Sierra servicing a LabZen instrument is a provider on it, not its house -
    // which is what keeps costs, shares and sign-off on the right side.
    expect(isHouseOf(labzenStaff, SIERRA)).toBe(false);
  });

  it("fails closed for staff whose operator is gone", () => {
    expect(isHouseOf(viewer({ operatorOrgId: null }), LABZEN)).toBe(false);
    expect(isHouseOf(viewer({ operatorOrgId: null }), null)).toBe(false);
  });
});

describe("what a viewer may see", () => {
  it("gives platform staff no filter at all", () => {
    expect(tenantScope(platform, [])).toEqual({ all: true });
  });

  it("gives an operator's staff their tenant plus what's shared in", () => {
    const s = tenantScope(labzenStaff, [{ instrumentId: 77, access: "edit" }, { instrumentId: 78, access: "view" }]);
    expect(s).toMatchObject({ all: false, tenantOrgId: LABZEN, ids: [77, 78] });
    if (s.all) throw new Error("unreachable");
    expect([...s.editable]).toEqual([77]);
  });

  it("needs an edit share for a system from another tenant", () => {
    // Being staff somewhere does not make you an editor everywhere.
    const s = tenantScope(labzenStaff, [{ instrumentId: 78, access: "view" }]);
    if (s.all) throw new Error("unreachable");
    expect(s.editable.has(78)).toBe(false);
  });

  it("leaves an organization member on shares alone", () => {
    const s = tenantScope(acmeEditor, [{ instrumentId: 5, access: "edit" }]);
    expect(s).toMatchObject({ all: false, tenantOrgId: null, ids: [5] });
    if (s.all) throw new Error("unreachable");
    expect(s.editable.has(5)).toBe(true);
  });

  it("keeps a viewer read-only however the share is set", () => {
    const s = tenantScope(acmeViewer, [{ instrumentId: 5, access: "edit" }]);
    if (s.all) throw new Error("unreachable");
    expect(s.editable.size).toBe(0);
  });

  it("shows nothing to a member with no organization", () => {
    expect(tenantScope(viewer({ role: "client_editor", operatorOrgId: null, orgId: null }), []))
      .toEqual({ all: false, tenantOrgId: null, ids: [], editable: new Set() });
  });

  it("shows nothing to staff with no operator", () => {
    // The dangerous misconfiguration: a staff row whose company was removed must
    // not read as "the house" and see every tenant on the instance.
    const s = tenantScope(viewer({ operatorOrgId: null }), []);
    expect(s).toEqual({ all: false, tenantOrgId: null, ids: [], editable: new Set() });
  });

  it("dedupes ids so a doubled share can't skew a count", () => {
    const s = tenantScope(acmeEditor, [{ instrumentId: 5, access: "view" }, { instrumentId: 5, access: "edit" }]);
    if (s.all) throw new Error("unreachable");
    expect(s.ids).toEqual([5]);
  });
});

describe("reaching one record", () => {
  const labzenScope = tenantScope(labzenStaff, [{ instrumentId: 90, access: "view" }]);

  it("reaches its own tenant's record", () => {
    expect(scopeSees(labzenScope, { id: 10, tenantOrgId: LABZEN })).toBe(true);
  });

  it("reaches a shared-in record from another tenant", () => {
    expect(scopeSees(labzenScope, { id: 90, tenantOrgId: SIERRA })).toBe(true);
  });

  it("does not reach another tenant's unshared record", () => {
    expect(scopeSees(labzenScope, { id: 11, tenantOrgId: SIERRA })).toBe(false);
  });

  it("does not reach an unstamped record, which is how a missed stamp shows up", () => {
    // Fail closed: a record created without a tenant disappears from its own
    // workspace - loud in testing - rather than appearing in everybody's.
    expect(scopeSees(labzenScope, { id: 12, tenantOrgId: null })).toBe(false);
    expect(scopeSees({ all: true }, { id: 12, tenantOrgId: null })).toBe(true);
  });
});

describe("delegated administration", () => {
  it("lets any operator's staff create organizations", () => {
    expect(mayCreateOrgs(labzenStaff)).toBe(true);
    expect(mayCreateOrgs(acmeEditor)).toBe(false);
    expect(mayCreateOrgs(viewer({ operatorOrgId: null }))).toBe(false);
  });

  it("lets an operator administer its own clients", () => {
    expect(mayAdminOrg(labzenStaff, orgs[WESTLAB])).toBe(true);
  });

  it("refuses another operator's client", () => {
    expect(mayAdminOrg(labzenStaff, orgs[ACME])).toBe(false);
  });

  it("refuses another operator outright", () => {
    expect(mayAdminOrg(labzenStaff, orgs[SIERRA])).toBe(false);
    expect(mayAdminOrg(labzenStaff, orgs[LABZEN])).toBe(true);
  });

  it("lets platform staff administer anyone, and clients nobody", () => {
    expect(mayAdminOrg(platform, orgs[WESTLAB])).toBe(true);
    expect(mayAdminOrg(platform, orgs[LABZEN])).toBe(true);
    expect(mayAdminOrg(acmeEditor, orgs[ACME])).toBe(false);
  });
});
