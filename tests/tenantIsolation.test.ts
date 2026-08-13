import { describe, expect, it } from "vitest";
import { canSeeCosts, redactParts } from "@/lib/redact";
import { stockAccess } from "@/lib/stock";
import { canKick, queueView } from "@/lib/queue";
import { remoteAbility, mayEnroll } from "@/lib/remoteAccess";
import { houseEmailsFrom } from "@/lib/houseRole";

/**
 * The same question asked of every rule that used to say "is this person staff?":
 * staff of WHOSE company?
 *
 * Sierra (1) runs the instance. Northwind (2) is another service company on it.
 * A Northwind engineer is senior at Northwind and nobody at Sierra - and because
 * the two of them will work the same instruments for the same clients, that has
 * to hold on the sharpest capabilities in the product: prices, stock, whose move
 * it is, and reaching into a lab PC.
 *
 * These are the tests that make it safe to sell one instance to competitors.
 */
const SIERRA = 1, NORTHWIND = 2, ACME = 7;

const sierraStaff = { role: "staff" as const, orgId: null, operatorOrgId: SIERRA, rootOperatorOrgId: SIERRA };
const nwStaff = { role: "staff" as const, orgId: null, operatorOrgId: NORTHWIND, rootOperatorOrgId: SIERRA };
const nwOwner = { role: "owner" as const, orgId: null, operatorOrgId: NORTHWIND, rootOperatorOrgId: SIERRA };
const acmeEditor = { role: "client_editor" as const, orgId: ACME, operatorOrgId: null, rootOperatorOrgId: SIERRA };

describe("part costs", () => {
  it("shows a tenant's own staff the price", () => {
    expect(canSeeCosts(sierraStaff, ACME, SIERRA)).toBe(true);
    expect(canSeeCosts(nwStaff, ACME, NORTHWIND)).toBe(true);
  });

  it("hides it from another operator's staff, however senior", () => {
    // Northwind is working on a Sierra system as a provider. They see the work;
    // they do not see what Sierra paid for the parts.
    expect(canSeeCosts(nwStaff, ACME, SIERRA)).toBe(false);
    expect(canSeeCosts(nwOwner, ACME, SIERRA)).toBe(false);
  });

  it("still shows the client who paid", () => {
    expect(canSeeCosts(acmeEditor, ACME, SIERRA)).toBe(true);
  });

  it("blanks the rows, cents included, for the other operator", () => {
    const rows = [{ cost: "$412.00", po: "PO-88", costCents: 41200, ownerOrgId: ACME }];
    expect(redactParts(rows, nwStaff, ACME, SIERRA)[0]).toEqual({
      cost: "", po: "", costCents: null, ownerOrgId: ACME,
    });
    expect(redactParts(rows, sierraStaff, ACME, SIERRA)[0].cost).toBe("$412.00");
  });

  it("keeps the pre-tenancy answer when no tenant is passed", () => {
    // The documented escape hatch, so its behavior is pinned rather than assumed.
    expect(canSeeCosts(nwStaff, ACME)).toBe(true);
  });
});

describe("stockrooms", () => {
  const sierraRoom = { orgId: null, tenantOrgId: SIERRA };

  it("is one company's shelf", () => {
    expect(stockAccess(sierraStaff, sierraRoom, undefined)).toEqual({ see: true, issue: true, manage: true });
    expect(stockAccess(nwStaff, sierraRoom, undefined)).toEqual({ see: false, issue: false, manage: false });
  });

  it("still opens through a share, at the share's level", () => {
    // Cross-company stock access exists - it is just explicit, not implied by
    // being staff of some company.
    expect(stockAccess({ ...nwStaff, role: "client_editor" as const, orgId: NORTHWIND }, sierraRoom, { access: "issue" }))
      .toEqual({ see: true, issue: true, manage: false });
  });
});

describe("whose move it is", () => {
  const sierraSystem = { queueOrgId: null, ownerOrgId: ACME, archived: false, tenantOrgId: SIERRA };

  it("reads an empty queue as the owning workspace's", () => {
    expect(queueView(sierraStaff, sierraSystem)).toBe("mine");
    expect(queueView(nwStaff, sierraSystem)).toBe("elsewhere");
  });

  it("lets only that workspace's staff move it", () => {
    expect(canKick(sierraStaff, sierraSystem)).toBe(true);
    expect(canKick(nwStaff, sierraSystem)).toBe(false);
  });

  it("still lets whoever holds it hand it back", () => {
    expect(canKick({ ...nwStaff, role: "client_editor" as const, orgId: NORTHWIND },
      { ...sierraSystem, queueOrgId: NORTHWIND })).toBe(true);
  });

  it("never moves an archived system", () => {
    expect(canKick(sierraStaff, { ...sierraSystem, archived: true })).toBe(false);
  });
});

describe("reaching a lab PC", () => {
  const ctx = { moduleOn: true, personaActive: false };
  const sierraPc = { orgId: ACME, tenantOrgId: SIERRA };
  const orgOn = { remoteAccessEnabled: true };

  it("is the enrolling workspace's staff", () => {
    expect(remoteAbility(sierraStaff, ctx, sierraPc, orgOn)).toMatchObject({ see: true, connect: true });
  });

  it("is not another operator's staff - the machine does not exist for them", () => {
    // The sharpest thing the product does. Being staff at Northwind must not put
    // a Sierra client's instrument controller within reach.
    expect(remoteAbility(nwStaff, ctx, sierraPc, orgOn)).toMatchObject({ see: false, connect: false });
    expect(remoteAbility(nwOwner, ctx, sierraPc, orgOn)).toMatchObject({ see: false, connect: false });
  });

  it("still lets the machine's own client connect when their tier is on", () => {
    expect(remoteAbility({ ...acmeEditor }, ctx, sierraPc, orgOn)).toMatchObject({ see: true, connect: true });
  });

  it("hands out installers only for the workspace doing the enrolling", () => {
    expect(mayEnroll(sierraStaff, { moduleOn: true }, { tenantOrgId: SIERRA })).toBe(true);
    expect(mayEnroll(nwStaff, { moduleOn: true }, { tenantOrgId: SIERRA })).toBe(false);
    expect(mayEnroll(nwStaff, { moduleOn: true }, { tenantOrgId: NORTHWIND })).toBe(true);
  });

  it("denies everything when the module is off, tenant or not", () => {
    expect(remoteAbility(sierraStaff, { ...ctx, moduleOn: false }, sierraPc, orgOn)).toMatchObject({ see: false });
    expect(mayEnroll(sierraStaff, { moduleOn: false }, { tenantOrgId: SIERRA })).toBe(false);
  });
});

describe("who gets the email", () => {
  // The other half of isolation: not just what you can see, but what lands in
  // your inbox. A fault on a Sierra instrument must not page Northwind's
  // engineers, who could not open the link if they tried.
  const ENV = ["joe@sierra.com"];
  const members = [
    { email: "bill@sierra.com", role: "staff", orgId: SIERRA },
    { email: "tech@northwind.com", role: "staff", orgId: NORTHWIND },
    { email: "owner@northwind.com", role: "owner", orgId: NORTHWIND },
  ];

  it("emails one workspace's staff about its own work", () => {
    expect(houseEmailsFrom(ENV, members, SIERRA, SIERRA).sort())
      .toEqual(["bill@sierra.com", "joe@sierra.com"]);
    expect(houseEmailsFrom(ENV, members, NORTHWIND, SIERRA).sort())
      .toEqual(["owner@northwind.com", "tech@northwind.com"]);
  });

  it("keeps the break-glass address with the company it belongs to", () => {
    // STAFF_EMAILS is the platform operator's own lockout insurance, so it must
    // not be copied on another operator's mail.
    expect(houseEmailsFrom(ENV, members, NORTHWIND, SIERRA)).not.toContain("joe@sierra.com");
  });

  it("reaches everyone only for a message about the instance itself", () => {
    expect(houseEmailsFrom(ENV, members).length).toBe(4);
  });

  it("still honours a revoked row inside a workspace", () => {
    const revoked = [...members, { email: "tech@northwind.com", role: "none", orgId: NORTHWIND }];
    expect(houseEmailsFrom(ENV, revoked, NORTHWIND, SIERRA)).toEqual(["owner@northwind.com"]);
  });
});
