import { describe, expect, it } from "vitest";
import { consentModeFor, mayEnroll, remoteAbility } from "@/lib/remoteAccess";

// These rules decide whether somebody can take control of a lab PC, so they get
// the same treatment as the tenancy rules: every combination stated, including
// the ones that must refuse.

const house = { role: "owner", orgId: null };
const staff = { role: "staff", orgId: null };
const editor = { role: "client_editor", orgId: 1 };
const viewer = { role: "client_viewer", orgId: 1 };
const on = { moduleOn: true, personaActive: false };
const persona = { moduleOn: true, personaActive: true };
const labzen = { orgId: 1 };
const tierOn = { remoteAccessEnabled: true };
const tierOff = { remoteAccessEnabled: false };

describe("remoteAbility", () => {
  it("gives the house everything, on any organization's machine", () => {
    for (const u of [house, staff]) {
      const a = remoteAbility(u, on, labzen, tierOff); // tier is irrelevant to us
      expect(a).toMatchObject({ see: true, connect: true, enroll: true, unlink: true });
    }
  });

  it("turns the whole module off for everyone, house included", () => {
    // A flag that the owner can still bypass is not a flag.
    for (const u of [house, staff, editor, viewer]) {
      expect(remoteAbility(u, { moduleOn: false, personaActive: false }, labzen, tierOn).see).toBe(false);
    }
  });

  it("lets a persona look but refuses the connection, with words", () => {
    const a = remoteAbility(house, persona, labzen, tierOn);
    expect(a.see).toBe(true);
    expect(a.connect).toBe(false);
    expect(a.refusal).toMatch(/own account/i);
  });

  it("gives a client editor their own machines only when the tier is on", () => {
    expect(remoteAbility(editor, on, labzen, tierOn)).toMatchObject({ see: true, connect: true });
    expect(remoteAbility(editor, on, labzen, tierOff).see).toBe(false);
  });

  it("never lets a client enrol or unlink - an installer is the house's to hand out", () => {
    const a = remoteAbility(editor, on, labzen, tierOn);
    expect(a.enroll).toBe(false);
    expect(a.unlink).toBe(false);
  });

  it("never crosses organizations", () => {
    const gmi = { orgId: 2 };
    expect(remoteAbility(editor, on, gmi, tierOn).see).toBe(false);
  });

  it("gives a read-only client nothing, tier on or off", () => {
    expect(remoteAbility(viewer, on, labzen, tierOn).see).toBe(false);
    expect(remoteAbility(viewer, on, labzen, tierOff).see).toBe(false);
  });

  it("says nothing when the device is invisible - it does not exist to them", () => {
    // A refusal message on a device they cannot see would leak that it exists.
    expect(remoteAbility(viewer, on, labzen, tierOn).refusal).toBe("");
  });

  it("gives an org-less non-house session nothing", () => {
    expect(remoteAbility({ role: "client_editor", orgId: null }, on, labzen, tierOn).see).toBe(false);
  });
});

describe("mayEnroll", () => {
  it("is the house's act, and only while the module is on", () => {
    expect(mayEnroll(house, { moduleOn: true })).toBe(true);
    expect(mayEnroll(staff, { moduleOn: true })).toBe(true);
    expect(mayEnroll(house, { moduleOn: false })).toBe(false);
    expect(mayEnroll(editor, { moduleOn: true })).toBe(false);
  });
});

describe("consentModeFor - attended vs unattended follows custody", () => {
  const derive = { orgId: 1, consentOverride: null };
  const inShop = { ownerOrgId: 1, stages: ["Refurbishment"] };

  it("is unattended while the system is still in the shop", () => {
    const r = consentModeFor(derive, inShop);
    expect(r.mode).toBe("unattended");
    expect(r.why).toMatch(/in the shop/);
  });

  it("requires consent once the system has shipped", () => {
    const r = consentModeFor(derive, { ownerOrgId: 1, stages: ["Checkout", "Shipped"] });
    expect(r.mode).toBe("consent");
    expect(r.why).toMatch(/shipped/);
  });

  it("requires consent once the system has changed hands", () => {
    // The reported case: LabZen ships a system to their client, so the owner is
    // no longer the org whose PC this is. Unattended access must close itself.
    const r = consentModeFor(derive, { ownerOrgId: 2, stages: ["Refurbishment"] });
    expect(r.mode).toBe("consent");
    expect(r.why).toMatch(/changed hands/);
  });

  it("requires consent when a system is handed to nobody in particular", () => {
    expect(consentModeFor(derive, { ownerOrgId: null, stages: [] }).mode).toBe("consent");
  });

  it("treats a house-owned device on a house-owned system as in the shop", () => {
    const houseDevice = { orgId: null, consentOverride: null };
    expect(consentModeFor(houseDevice, { ownerOrgId: null, stages: [] }).mode).toBe("unattended");
  });

  it("defaults an unlinked device to unattended, and says why", () => {
    const r = consentModeFor(derive, null);
    expect(r.mode).toBe("unattended");
    expect(r.why).toMatch(/not linked/);
  });

  it("lets staff force a prompt on a system still in the shop", () => {
    const r = consentModeFor({ orgId: 1, consentOverride: true }, inShop);
    expect(r.mode).toBe("consent");
    expect(r.why).toBe("set by staff");
  });

  it("lets staff keep unattended access after a handoff - that is the paid tier", () => {
    const r = consentModeFor({ orgId: 1, consentOverride: false }, { ownerOrgId: 2, stages: ["Shipped"] });
    expect(r.mode).toBe("unattended");
    expect(r.why).toBe("set by staff");
  });
});
