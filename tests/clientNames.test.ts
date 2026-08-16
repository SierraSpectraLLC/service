import { describe, expect, it } from "vitest";
import { clientOptions } from "@/lib/clientNames";

describe("what the Client picker offers", () => {
  it("lists organizations tagged as clients, whether or not any system names one", () => {
    // The bug: a client created in Organizations was invisible here until
    // somebody typed its name onto a system by hand.
    expect(clientOptions(["Acme Engineering", "LabZen"], [])).toEqual(["Acme Engineering", "LabZen"]);
  });

  it("keeps names already typed onto systems, which have no org behind them", () => {
    // Dropping these would orphan every system labelled with a company that
    // predates the orgs table.
    expect(clientOptions(["LabZen"], ["Casablanca", "Utah"]))
      .toEqual(["Casablanca", "LabZen", "Utah"]);
  });

  it("treats one company spelled two ways as one company", () => {
    expect(clientOptions(["GMI"], ["gmi", "GMI "])).toEqual(["GMI"]);
  });

  it("prefers the organization's spelling over whatever was typed", () => {
    // The org row is the record; the string on a system is a label somebody
    // typed at eight in the morning.
    expect(clientOptions(["MID"], ["mid"])).toEqual(["MID"]);
  });

  it("drops blanks rather than offering an empty row", () => {
    expect(clientOptions(["", "  "], ["Optiq", ""])).toEqual(["Optiq"]);
  });

  it("sorts case-blind, so capitals don't scatter the list", () => {
    expect(clientOptions([], ["utah", "Casablanca", "gMI"]))
      .toEqual(["Casablanca", "gMI", "utah"]);
  });
});
