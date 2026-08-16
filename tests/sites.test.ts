import { describe, expect, it } from "vitest";
import { addressHint, addressLine, siteLabel, sitesFor, visitBrief } from "@/lib/sites";

const site = (over: Partial<{
  id: number; orgId: number; name: string; address: string; accessNotes: string; archived: boolean;
}> = {}) => ({
  id: 1, orgId: 7, name: "Reno lab", address: "123 Cedar St\nSuite 4\nReno NV 89501",
  accessNotes: "", archived: false, ...over,
});

describe("an address next to something else", () => {
  it("becomes one line with the commas put in", () => {
    // Not CSS: collapsing the newlines in the browser gives "Cedar StSuite 4".
    expect(addressLine("123 Cedar St\nSuite 4\nReno NV 89501"))
      .toBe("123 Cedar St, Suite 4, Reno NV 89501");
  });

  it("survives blank lines, trailing space and CRLF", () => {
    expect(addressLine("123 Cedar St \r\n\r\n  Reno NV  ")).toBe("123 Cedar St, Reno NV");
    expect(addressLine("")).toBe("");
    expect(addressLine("\n\n")).toBe("");
  });

  it("truncates at a length rather than wrapping a picker", () => {
    expect(addressHint("123 Cedar St\nSuite 4\nReno NV 89501", 20)).toBe("123 Cedar St, Suite…");
    expect(addressHint("123 Cedar St", 20)).toBe("123 Cedar St");
  });
});

describe("what a site is called", () => {
  it("uses the name somebody typed", () => {
    expect(siteLabel(site())).toBe("Reno lab");
  });

  it("falls back to the address, because 'Site 12' helps nobody", () => {
    expect(siteLabel(site({ name: "  " }))).toBe("123 Cedar St, Suite 4, Reno NV 89501");
  });

  it("says so plainly when there is nothing at all", () => {
    expect(siteLabel({ name: "", address: "" })).toBe("Unnamed site");
  });
});

describe("which sites a system may be assigned to", () => {
  const sites = [
    site({ id: 1, orgId: 7, name: "Reno" }),
    site({ id: 2, orgId: 7, name: "Sparks" }),
    site({ id: 3, orgId: 7, name: "Closed lab", archived: true }),
    site({ id: 4, orgId: 9, name: "Another client's lab" }),
  ];

  it("offers only the owning organization's live sites", () => {
    expect(sitesFor(sites, 7, null).map((s) => s.id)).toEqual([1, 2]);
  });

  it("never offers another client's site", () => {
    expect(sitesFor(sites, 7, null).some((s) => s.orgId === 9)).toBe(false);
  });

  it("keeps the site it is already at, even once that lab has closed", () => {
    // Dropping the current value out of its own picker is how an unrelated
    // edit silently clears a field.
    expect(sitesFor(sites, 7, 3).map((s) => s.id)).toEqual([1, 2, 3]);
  });

  it("offers nothing but the current one for a house-stewarded system", () => {
    expect(sitesFor(sites, null, null)).toEqual([]);
    expect(sitesFor(sites, null, 2).map((s) => s.id)).toEqual([2]);
  });
});

describe("what a tech reads before driving there", () => {
  it("puts the name, the address and the awkward part in that order", () => {
    expect(visitBrief(site({ accessNotes: "Parking garage on Cedar, $30/day. Dock round the back." })))
      .toBe("Reno lab\n123 Cedar St, Suite 4, Reno NV 89501\nParking garage on Cedar, $30/day. Dock round the back.");
  });

  it("is null when there is nothing to say, so the block can be left out", () => {
    // An empty heading is the commonest way a page looks broken to somebody
    // whose data simply is not filled in.
    expect(visitBrief(null)).toBe(null);
    expect(visitBrief({ name: "", address: "", accessNotes: "" })).toBe(null);
  });
});
