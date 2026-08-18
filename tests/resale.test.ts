import { describe, expect, it } from "vitest";
import { canOfferResale } from "@/lib/owner";

const base = {
  isStaff: false, viewerOrgId: 5, viewerRole: "client_editor",
  ownerOrgId: 5, ownerResaleEnabled: true, alreadyListed: false,
};

describe("who may be offered resale controls", () => {
  it("asks who, and then whether the org is in that business at all", () => {
    expect(canOfferResale(base)).toBe(true);
    expect(canOfferResale({ ...base, ownerResaleEnabled: false })).toBe(false);
  });

  it("hides it from everybody at an org that does not resell", () => {
    // The clutter this removes: a lab servicing four instruments reading past
    // "List for sale..." on every one of them, forever.
    expect(canOfferResale({ ...base, isStaff: true, ownerResaleEnabled: false })).toBe(false);
  });

  it("never lets the capability strip a live listing of its controls", () => {
    // Turning it off must not strand something already for sale with no way to
    // end it - the same asymmetry stage removal has.
    expect(canOfferResale({ ...base, ownerResaleEnabled: false, alreadyListed: true })).toBe(true);
    expect(canOfferResale({ ...base, isStaff: true, ownerResaleEnabled: false, alreadyListed: true })).toBe(true);
  });

  it("still refuses somebody who was never allowed to sell it", () => {
    // Being listed is not permission. A viewer at another org, a read-only
    // client, and an unowned record's client all stay out.
    expect(canOfferResale({ ...base, viewerOrgId: 9, alreadyListed: true })).toBe(false);
    expect(canOfferResale({ ...base, viewerRole: "client_viewer", alreadyListed: true })).toBe(false);
    expect(canOfferResale({ ...base, ownerOrgId: null, alreadyListed: true })).toBe(false);
  });

  it("lets staff sell house stock when the house resells", () => {
    expect(canOfferResale({ ...base, isStaff: true, ownerOrgId: null, viewerOrgId: null })).toBe(true);
  });
});
