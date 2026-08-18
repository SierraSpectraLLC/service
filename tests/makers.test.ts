import { describe, it, expect } from "vitest";
import { cleanMakerName, mergeMakers, makerUsageLine, type MakerRow } from "@/lib/makers";

describe("cleanMakerName", () => {
  it("trims and collapses inner whitespace", () => {
    expect(cleanMakerName("  Thermo   Fisher ")).toBe("Thermo Fisher");
  });
  it("caps at the vocab name limit", () => {
    expect(cleanMakerName("x".repeat(80))).toHaveLength(60);
  });
});

describe("mergeMakers", () => {
  it("merges case-insensitively, defined spelling winning the display", () => {
    const rows = mergeMakers(
      [{ id: 5, name: "Shimadzu" }],
      [{ name: "SHIMADZU", source: "units" }, { name: "shimadzu", source: "models" }],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: 5, name: "Shimadzu", total: 2 });
    expect(rows[0].usage.units).toBe(1);
    expect(rows[0].usage.models).toBe(1);
  });

  it("an undefined name shows its most common in-use spelling, id null", () => {
    const rows = mergeMakers([], [
      { name: "waters", source: "parts" },
      { name: "Waters", source: "parts" },
      { name: "Waters", source: "buying" },
    ]);
    expect(rows[0].id).toBeNull();
    expect(rows[0].name).toBe("Waters");
    expect(rows[0].total).toBe(3);
  });

  it("a defined maker never used still lists, at zero", () => {
    const rows = mergeMakers([{ id: 1, name: "Restek" }], []);
    expect(rows[0]).toMatchObject({ id: 1, name: "Restek", total: 0 });
  });

  it("drops empty names and sorts by name", () => {
    const rows = mergeMakers(
      [{ id: 1, name: "  " }],
      [{ name: "Thermo", source: "units" }, { name: "", source: "units" }, { name: "Agilent", source: "units" }],
    );
    expect(rows.map((r) => r.name)).toEqual(["Agilent", "Thermo"]);
  });
});

describe("makerUsageLine", () => {
  const base = (): MakerRow => ({
    id: 1, name: "Agilent", total: 0,
    usage: { models: 0, systems: 0, units: 0, parts: 0, buying: 0 },
  });

  it("names only the sources with counts, pluralised", () => {
    const r = base();
    r.usage.models = 4; r.usage.units = 1; r.total = 5;
    expect(makerUsageLine(r)).toBe("4 models · 1 unit");
  });

  it("is empty when unused, so the card can say 'not used yet'", () => {
    expect(makerUsageLine(base())).toBe("");
  });
});
