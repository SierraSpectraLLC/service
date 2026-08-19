import { describe, it, expect } from "vitest";
import {
  MAX_SPECS, mergeModelSpecs, parseModelSpecs, serializeModelSpecs, specNameSuggestions,
} from "@/lib/modelSpecs";

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
