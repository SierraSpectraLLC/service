// Administering an organization and BILLING one are different powers.
//
// Conflating them is what made a peer service company unbillable: mayAdminOrg
// refuses another operator outright, correctly - you must never edit their
// sites, their people or their settings - and the money pages used it as the
// gate for putting somebody on an invoice too. Naming a company on your own
// paper is not administering it.
import { describe, expect, it } from "vitest";
import { mayAdminOrg, mayBillOrg } from "@/lib/tenants";

const SIERRA = { id: 3, isOperator: true, parentOrgId: null };
const NORTHWEST = { id: 4, isOperator: true, parentOrgId: null };
const MY_CLIENT = { id: 20, isOperator: false, parentOrgId: 3 };
const THEIR_CLIENT = { id: 21, isOperator: false, parentOrgId: 4 };

const staff = { role: "staff", operatorOrgId: 3, rootOperatorOrgId: 26, orgId: null };
const owner = { ...staff, role: "owner" };
const platform = { role: "owner", operatorOrgId: 26, rootOperatorOrgId: 26, orgId: null };
const client = { role: "client_editor", operatorOrgId: null, rootOperatorOrgId: 26, orgId: 20 };

describe("who may be billed", () => {
  it("keeps every case mayAdminOrg already allowed", () => {
    expect(mayBillOrg(owner, MY_CLIENT, [])).toBe(true);
    expect(mayBillOrg(staff, MY_CLIENT, [])).toBe(true);
    // Platform staff still reach everything, which is the support path.
    expect(mayBillOrg(platform, THEIR_CLIENT, [])).toBe(true);
  });

  it("opens the one door mayAdminOrg deliberately shuts", () => {
    /*
     * A peer service company that subcontracts to us, or owes us a referral
     * fee, is a customer for that transaction - and could not be put on an
     * invoice at all before this.
     */
    expect(mayAdminOrg(owner, NORTHWEST)).toBe(false);
    expect(mayBillOrg(owner, NORTHWEST, [4])).toBe(true);
  });

  it("only for a peer this workspace actually added", () => {
    // Not "any operator": being nameable is not nothing, which is why
    // visibleOrgs hides operators from each other in the first place.
    expect(mayBillOrg(owner, NORTHWEST, [])).toBe(false);
    expect(mayBillOrg(owner, NORTHWEST, [99])).toBe(false);
  });

  it("still refuses another operator's client, linked or not", () => {
    // The link says "we work with that company", not "we may bill their book".
    expect(mayBillOrg(owner, THEIR_CLIENT, [4])).toBe(false);
  });

  it("is not a way to bill yourself", () => {
    expect(mayBillOrg(owner, SIERRA, [3])).toBe(false);
  });

  it("is staff only, and never a client", () => {
    expect(mayBillOrg(client, MY_CLIENT, [])).toBe(false);
    expect(mayBillOrg(client, NORTHWEST, [4])).toBe(false);
  });

  it("refuses somebody with no workspace behind them", () => {
    expect(mayBillOrg({ ...staff, operatorOrgId: null }, NORTHWEST, [4])).toBe(false);
  });
});
