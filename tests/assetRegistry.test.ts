import { describe, expect, it } from "vitest";
import { unitShown, unitStage } from "@/lib/assetRegistry";

/**
 * A unit has no stage of its own: it is a former client's unit because its
 * owner is, or because the system it sits in is owned by one. These pin the
 * rule the assets page hides former clients by, which is the systems page's
 * rule read from the unit's side.
 */
const LABZEN = 7, GONE = 8, UNKNOWN = 99;
const orgStage = (id: number) => ({ [LABZEN]: "client", [GONE]: "former" } as Record<number, string>)[id];
const systemOwner = (id: number) => ({ 1: LABZEN, 2: GONE, 3: null } as Record<number, number | null>)[id];

describe("unitStage", () => {
  it("follows the unit's own owner on the shelf", () => {
    expect(unitStage({ ownerOrgId: GONE, instrumentId: null }, systemOwner, orgStage)).toBe("former");
    expect(unitStage({ ownerOrgId: LABZEN, instrumentId: null }, systemOwner, orgStage)).toBe("client");
  });
  it("follows the system's owner once installed, whatever the unit's own column says", () => {
    // A pump entered with no owner in a former client's LC-MS is theirs.
    expect(unitStage({ ownerOrgId: null, instrumentId: 2 }, systemOwner, orgStage)).toBe("former");
    // And one a former client once owned, now in a client's system, is the client's.
    expect(unitStage({ ownerOrgId: GONE, instrumentId: 1 }, systemOwner, orgStage)).toBe("client");
  });
  it("reads nobody's, and an owner it cannot resolve, as a client's - the safe direction", () => {
    expect(unitStage({ ownerOrgId: null, instrumentId: null }, systemOwner, orgStage)).toBe("client");
    expect(unitStage({ ownerOrgId: null, instrumentId: 3 }, systemOwner, orgStage)).toBe("client");
    expect(unitStage({ ownerOrgId: UNKNOWN, instrumentId: null }, systemOwner, orgStage)).toBe("client");
    expect(unitStage({ ownerOrgId: null, instrumentId: 404 }, systemOwner, orgStage)).toBe("client");
  });
});

describe("unitShown", () => {
  it("hides a former client's units by default and keeps everybody else's", () => {
    expect(unitShown("former", "")).toBe(false);
    expect(unitShown("client", "")).toBe(true);
    expect(unitShown("prospect", "")).toBe(true);
  });
  it("shows only theirs when the facet is on", () => {
    expect(unitShown("former", "former")).toBe(true);
    expect(unitShown("client", "former")).toBe(false);
  });
});
