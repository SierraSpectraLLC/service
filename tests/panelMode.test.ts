// Which shape a record page takes.
//
// The rule is small and the cost of getting it wrong is not: the server page
// and the client layout both resolve it, and if they disagree the page arrives
// as bands and snaps to the rail one frame later - which reads as a bug on
// every load, on the page people open most.
import { describe, expect, it } from "vitest";
import { defaultMode, isPanelMode, modeFor, PANEL_MODES } from "@/lib/panelMode";

describe("what a page defaults to", () => {
  it("puts the system page on the rail - the one that outgrew bands", () => {
    expect(defaultMode("system")).toBe("rail");
  });

  it("leaves the asset and the work order exactly where they were", () => {
    // A third of the panels each. Changing them would be change for its own
    // sake, and every reader would have to discover a page they did not ask for.
    expect(defaultMode("asset")).toBe("bands");
    expect(defaultMode("workorder")).toBe("bands");
    expect(defaultMode("anything-else")).toBe("bands");
  });
});

describe("what a person's own choice does", () => {
  it("beats the default, in both directions", () => {
    expect(modeFor("system", { mode: "bands" })).toBe("bands");
    expect(modeFor("asset", { mode: "rail" })).toBe("rail");
  });

  it("falls back to the default when they have never chosen", () => {
    expect(modeFor("system", null)).toBe("rail");
    expect(modeFor("system", {})).toBe("rail");
    expect(modeFor("asset", null)).toBe("bands");
  });

  it("ignores a stored value that is not one of the two", () => {
    // The column is jsonb and the client writes it, so "whatever was in there"
    // is a real input. Anything unrecognised reads as "never chose".
    for (const junk of ["tabs", "", "RAIL", 1, true, null, undefined, {}]) {
      expect(modeFor("system", { mode: junk })).toBe("rail");
      expect(modeFor("asset", { mode: junk })).toBe("bands");
    }
  });
});

describe("the guard the save path uses", () => {
  it("accepts exactly the two literals and nothing else", () => {
    for (const m of PANEL_MODES) expect(isPanelMode(m)).toBe(true);
    for (const junk of ["tabs", "", "Rail", 0, [], {}, null, undefined]) {
      expect(isPanelMode(junk)).toBe(false);
    }
  });

  it("is the only vocabulary there is", () => {
    expect([...PANEL_MODES]).toEqual(["rail", "bands"]);
  });
});

// The save path is where an unknown mode would become permanent, so the
// sanitiser is checked against the source rather than trusted.
import { readFileSync } from "node:fs";

describe("saveUiLayout sanitises the mode like every other field", () => {
  const src = readFileSync("src/app/actions.ts", "utf8");
  const body = src.slice(src.indexOf("export async function saveUiLayout"));
  const fn = body.slice(0, body.indexOf("\nexport "));

  it("passes it through isPanelMode rather than storing what it was handed", () => {
    expect(fn).toContain("isPanelMode(data?.mode)");
  });

  it("omits the key entirely when it is not one of the two", () => {
    // Not "mode: undefined" - an absent key is what modeFor reads as
    // "never chose", and a stored null would read the same but linger.
    expect(fn).toMatch(/\?\s*\{ mode: data\.mode \}\s*:\s*\{\}/);
  });

  it("still accepts the work order view, which it used to refuse outright", () => {
    // viewKey="workorder" was already being passed by the work order page
    // while PANEL_VIEWS listed only system and asset, so every rearrangement
    // there was rejected and silently dropped.
    expect(src).toContain('const PANEL_VIEWS = ["system", "asset", "workorder"] as const;');
  });
});
