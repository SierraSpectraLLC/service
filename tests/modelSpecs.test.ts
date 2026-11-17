import { describe, it, expect } from "vitest";
import {
  effectiveSheet, effectiveSpecs, MAX_SPECS, mergeModelSpecs, ownSpecsFrom, parseModelSpecs, serializeModelSpecs,
  specNameSuggestions,
} from "@/lib/modelSpecs";

// A family's sheet and a model's place in it: every ISQ shares the ISQ numbers,
// the ISQ-LT says one of them differently, and changing the family changes
// every member except where a member has spoken for itself.
describe("effectiveSheet", () => {
  const isq = [{ name: "Mass range", value: "1.2–1100 u" }, { name: "Source temp", value: "up to 350 °C" }];

  it("reads the family's rows first, then the model's own", () => {
    const own = [{ name: "Weight", value: "80 kg" }];
    expect(effectiveSheet(own, isq)).toEqual([
      { name: "Mass range", value: "1.2–1100 u", source: "series" },
      { name: "Source temp", value: "up to 350 °C", source: "series" },
      { name: "Weight", value: "80 kg", source: "own" },
    ]);
  });

  it("lets the model's own value win, and remembers what the family said", () => {
    const own = [{ name: "source temp", value: "up to 400 °C" }];
    const sheet = effectiveSheet(own, isq);
    expect(sheet[1]).toEqual({ name: "Source temp", value: "up to 400 °C", source: "override", seriesValue: "up to 350 °C" });
    expect(effectiveSpecs(own, isq).map((s) => s.value)).toEqual(["1.2–1100 u", "up to 400 °C"]);
  });

  it("is the model's own sheet when it is in no family", () => {
    const own = [{ name: "Max pressure", value: "1300 bar" }];
    expect(effectiveSheet(own, [])).toEqual([{ name: "Max pressure", value: "1300 bar", source: "own" }]);
  });
});

describe("ownSpecsFrom", () => {
  const isq = [{ name: "Mass range", value: "1.2–1100 u" }, { name: "Source temp", value: "up to 350 °C" }];

  it("stores only what differs from the family, so the rest keeps following it", () => {
    expect(ownSpecsFrom([
      { name: "Mass range", value: "1.2–1100 u" },      // same as the family: inherited, not copied
      { name: "Source temp", value: "up to 400 °C" },   // this model's own number
      { name: "Weight", value: "80 kg" },               // the family has no such row
    ], isq)).toEqual([
      { name: "Source temp", value: "up to 400 °C" },
      { name: "Weight", value: "80 kg" },
    ]);
  });

  it("treats a blanked family row as going back to the family's value", () => {
    expect(ownSpecsFrom([{ name: "Source temp", value: "" }, { name: "Mass range", value: "  1.2–1100 u " }], isq)).toEqual([]);
  });

  it("is the whole sheet for a model in no family", () => {
    expect(ownSpecsFrom([{ name: "Max pressure", value: "1300 bar" }], [])).toEqual([{ name: "Max pressure", value: "1300 bar" }]);
  });
});

describe("parse / serialize round trip", () => {
  it("keeps authored order and content", () => {
    const raw = serializeModelSpecs([
      { name: "Max pressure", value: "1300 bar" },
      { name: "Flow range", value: "0.0001–5 mL/min" },
    ]);
    expect(parseModelSpecs(raw)).toEqual([
      { name: "Max pressure", value: "1300 bar" },
      { name: "Flow range", value: "0.0001–5 mL/min" },
    ]);
  });

  it("drops half-typed rows: a name with no value, a value with no name", () => {
    expect(parseModelSpecs(serializeModelSpecs([
      { name: "Max pressure", value: "" },
      { name: "", value: "600 bar" },
      { name: "Wetted materials", value: "SST, PEEK" },
    ]))).toEqual([{ name: "Wetted materials", value: "SST, PEEK" }]);
  });

  it("collapses duplicate names, edit wins, position kept", () => {
    const raw = serializeModelSpecs([
      { name: "Max pressure", value: "600 bar" },
      { name: "Seal type", value: "PTFE" },
      { name: "max pressure", value: "1300 bar" },
    ]);
    expect(parseModelSpecs(raw)).toEqual([
      { name: "Max pressure", value: "1300 bar" },
      { name: "Seal type", value: "PTFE" },
    ]);
  });

  it("empty sheet serializes to the empty string, and garbage parses to []", () => {
    expect(serializeModelSpecs([])).toBe("");
    expect(parseModelSpecs("")).toEqual([]);
    expect(parseModelSpecs("not json")).toEqual([]);
    expect(parseModelSpecs('{"name":"x"}')).toEqual([]);
  });

  it("collapses runs of whitespace and enforces the row cap", () => {
    const raw = serializeModelSpecs([{ name: "  Max   pressure ", value: " 1300  bar " }]);
    expect(parseModelSpecs(raw)).toEqual([{ name: "Max pressure", value: "1300 bar" }]);
    const many = Array.from({ length: 60 }, (_, i) => ({ name: `Row ${i}`, value: "x" }));
    expect(parseModelSpecs(serializeModelSpecs(many))).toHaveLength(MAX_SPECS);
  });
});

describe("mergeModelSpecs - the copy-from rule", () => {
  it("fills what's missing, never overwrites what's written", () => {
    const merged = mergeModelSpecs(
      [{ name: "Max pressure", value: "1300 bar" }],
      [{ name: "max pressure", value: "600 bar" }, { name: "Flow range", value: "0.0001–5 mL/min" }],
    );
    expect(merged).toEqual([
      { name: "Max pressure", value: "1300 bar" },
      { name: "Flow range", value: "0.0001–5 mL/min" },
    ]);
  });

  it("copying onto an empty sheet is a straight copy", () => {
    const src = [{ name: "A", value: "1" }, { name: "B", value: "2" }];
    expect(mergeModelSpecs([], src)).toEqual(src);
  });
});

describe("specNameSuggestions", () => {
  it("dedupes across sheets case-insensitively, first spelling wins, sorted", () => {
    expect(specNameSuggestions([
      [{ name: "Max pressure", value: "600 bar" }],
      [{ name: "max pressure", value: "1300 bar" }, { name: "Flow range", value: "x" }],
    ])).toEqual(["Flow range", "Max pressure"]);
  });
});
