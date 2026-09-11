import { describe, expect, it } from "vitest";
import { eodAuthorName, groupEodEntries, isOwnEodRow, nestEodGroups } from "@/lib/eodLines";

/**
 * Each person writes their own EOD line. The rules that decide whose line is
 * whose, and how a report gathers them, live in lib/eodLines so they can be
 * pinned as a table rather than found on the EOD page.
 */
const joe = { email: "Joe@Sierra.com", name: "Joe Harris" };
const bill = { email: "bill@sierra.com", name: "Bill Harner" };

describe("isOwnEodRow", () => {
  it("is the stamp, case-insensitively, when there is one", () => {
    const row = { author: "joe@sierra.com", updatedBy: "Joe Harris" };
    expect(isOwnEodRow(row, joe)).toBe(true);
    expect(isOwnEodRow(row, bill)).toBe(false);
  });

  it("gives a pre-authorship row to whoever last wrote it, by name", () => {
    /* The old rows have no stamp and one name. Treating them as nobody's
       would leave yesterday's engineer reading their own words in a box they
       cannot edit. */
    const legacy = { author: "", updatedBy: "Bill Harner" };
    expect(isOwnEodRow(legacy, bill)).toBe(true);
    expect(isOwnEodRow(legacy, joe)).toBe(false);
  });

  it("is nobody's without a viewer, or with neither stamp nor name", () => {
    expect(isOwnEodRow({ author: "joe@sierra.com", updatedBy: "Joe Harris" }, null)).toBe(false);
    expect(isOwnEodRow({ author: "", updatedBy: "" }, joe)).toBe(false);
  });

  it("does not let a stamped row fall back to the name", () => {
    // A row Bill stamped that Joe later corrected keeps Bill's name AND stamp;
    // the stamp decides, so a name match alone cannot hand it over.
    expect(isOwnEodRow({ author: "bill@sierra.com", updatedBy: "Joe Harris" }, joe)).toBe(false);
  });
});

describe("eodAuthorName", () => {
  it("prefers who did it, then who wrote it, then the stamp", () => {
    expect(eodAuthorName({ author: "joe@sierra.com", updatedBy: "Joe Harris", person: "Bill Harner" })).toBe("Bill Harner");
    expect(eodAuthorName({ author: "joe@sierra.com", updatedBy: "Joe Harris" })).toBe("Joe Harris");
    expect(eodAuthorName({ author: "joe@sierra.com", updatedBy: "" })).toBe("joe");
  });

  it("cuts an address at the @, and says nothing for a row nobody signed", () => {
    expect(eodAuthorName({ author: "", updatedBy: "tess@demo.com" })).toBe("tess");
    expect(eodAuthorName({ author: "", updatedBy: "" })).toBe("");
  });
});

describe("groupEodEntries", () => {
  it("gathers one system's lines under one heading, in first-appearance order", () => {
    const groups = groupEodEntries([
      { kind: "system", id: 1, by: "Joe" },
      { kind: "system", id: 2, by: "Joe" },
      { kind: "system", id: 1, by: "Bill" },
      { kind: "asset", id: 1, by: "Bill" },
    ]);
    expect(groups.map((g) => g.map((e) => `${e.kind}:${e.id}:${e.by}`))).toEqual([
      ["system:1:Joe", "system:1:Bill"], ["system:2:Joe"], ["asset:1:Bill"],
    ]);
  });

  it("never merges off-system lines, which have no record to share", () => {
    const groups = groupEodEntries([
      { kind: "offsystem", id: 7 }, { kind: "offsystem", id: 8 },
    ]);
    expect(groups).toHaveLength(2);
  });
});

describe("nestEodGroups", () => {
  const sys = (id: number) => ({ kind: "system", id, parent: null });
  const unit = (id: number, parent: number | null) => ({ kind: "asset", id, parent: parent === null ? null : { id: parent } });
  const off = (id: number) => ({ kind: "offsystem", id, parent: null });

  it("puts a unit's group under its system's, in the systems' order", () => {
    const nested = nestEodGroups(groupEodEntries([sys(1), sys(2), unit(5, 2), unit(6, 1), unit(7, 2)]));
    expect(nested.map((n) => [n.head[0].kind + n.head[0].id, n.modules.map((m) => m[0].id)]))
      .toEqual([["system1", [6]], ["system2", [5, 7]]]);
  });

  it("leaves a shelf unit, a stranger's unit and off-system work as groups of their own", () => {
    const nested = nestEodGroups(groupEodEntries([sys(1), unit(5, null), unit(6, 99), off(3)]));
    expect(nested.map((n) => n.head[0].kind + n.head[0].id)).toEqual(["system1", "asset5", "asset6", "offsystem3"]);
    expect(nested.every((n) => n.modules.length === 0)).toBe(true);
  });

  it("keeps two people's lines together, on the system and on the module", () => {
    const nested = nestEodGroups(groupEodEntries([
      { ...sys(1), by: "Joe" }, { ...sys(1), by: "Bill" }, { ...unit(5, 1), by: "Joe" }, { ...unit(5, 1), by: "Bill" },
    ]));
    expect(nested).toHaveLength(1);
    expect(nested[0].head).toHaveLength(2);
    expect(nested[0].modules[0]).toHaveLength(2);
  });
});
