import { describe, expect, it } from "vitest";
import {
  alreadyHas, procedureCopy, refilePlan, refileSummary, type ModelTerm, type ProcedureLike,
} from "@/lib/procedureMove";

const proc = (over: Partial<ProcedureLike> = {}): ProcedureLike => ({
  assetType: "Pump", kind: "test", name: "Leak Check", notes: "Hold 200 bar for 5 min.",
  resultType: "pass_fail", target: null, tolerancePct: null,
  requiresNote: true, consumesPart: false, runsAtIntake: true, intervalDays: 365,
  required: true, parts: '[{"name":"Seal kit","number":"5063-6589"}]',
  modelScope: ["LC-20AD", "LC-30AD"],
  ...over,
});

describe("copying a procedure to another module type", () => {
  it("carries everything about the work", () => {
    const c = procedureCopy(proc(), "LC System", 4);
    expect(c).toMatchObject({
      assetType: "LC System", kind: "test", name: "Leak Check",
      notes: "Hold 200 bar for 5 min.", requiresNote: true, runsAtIntake: true,
      intervalDays: 365, required: true, position: 4,
    });
    expect(c.parts).toBe('[{"name":"Seal kit","number":"5063-6589"}]');
  });

  it("drops the model scope, which belonged to the old type", () => {
    // Two Shimadzu pump models mean nothing on an LC System: the copy would
    // apply to no unit at all and look like it had simply stopped working.
    expect(procedureCopy(proc(), "LC System", 0).modelScope).toEqual([]);
  });

  it("spots a duplicate before making one", () => {
    const existing = [{ assetType: "LC System", name: "Leak check" }];
    expect(alreadyHas(existing, "LC System", "  LEAK CHECK ")).toBe(true);
    expect(alreadyHas(existing, "LC System", "Pressure test")).toBe(false);
    expect(alreadyHas(existing, "Pump", "Leak check")).toBe(false);
  });
});

describe("re-filing a module type under a different system category", () => {
  const models: ModelTerm[] = [
    { id: 1, assetType: "LC System", name: "1260 Infinity", categories: ["UV-Vis"] },
    { id: 2, assetType: "LC System", name: "Nexera X2", categories: ["UV-Vis", "HPLC"] },
    { id: 3, assetType: "LC System", name: "Vanquish", categories: ["UV-Vis", "LC-MS"] },
    { id: 4, assetType: "LC System", name: "Universal stack", categories: [] },
    { id: 5, assetType: "Pump", name: "LC-20AD", categories: ["UV-Vis"] },
    { id: 6, assetType: "LC System", name: "Elsewhere", categories: ["GC-MS"] },
  ];

  it("retags this type's models and nothing else's", () => {
    const plan = refilePlan(models, "LC System", "UV-Vis", "LC-MS");
    expect(plan.map((p) => p.id).sort()).toEqual([1, 2, 3]);
    // The Pump filed under UV-Vis is a different type and stays where it is.
    expect(plan.some((p) => p.id === 5)).toBe(false);
  });

  it("keeps every other category the model was filed under", () => {
    // The type was in several places and only one of them was the mistake.
    const plan = refilePlan(models, "LC System", "UV-Vis", "LC-MS");
    expect(plan.find((p) => p.id === 2)?.categories).toEqual(["LC-MS", "HPLC"]);
  });

  it("does not leave a duplicate when the model was already in both", () => {
    const plan = refilePlan(models, "LC System", "UV-Vis", "LC-MS");
    expect(plan.find((p) => p.id === 3)?.categories).toEqual(["LC-MS"]);
  });

  it("leaves universal kit universal", () => {
    // A model tagged with nothing is offered under every system type. It was
    // never under UV-Vis specifically, and pinning it to one place would narrow
    // it in a way nobody asked for.
    expect(refilePlan(models, "LC System", "UV-Vis", "LC-MS").some((p) => p.id === 4)).toBe(false);
  });

  it("leaves a model filed somewhere else entirely alone", () => {
    expect(refilePlan(models, "LC System", "UV-Vis", "LC-MS").some((p) => p.id === 6)).toBe(false);
  });

  it("does nothing at all when the two categories are the same", () => {
    expect(refilePlan(models, "LC System", "UV-Vis", "uv-vis")).toEqual([]);
  });

  it("matches categories the way the rest of the catalog does - case blind", () => {
    expect(refilePlan(models, "lc system", "uv-vis", "LC-MS").map((p) => p.id).sort()).toEqual([1, 2, 3]);
  });

  it("says plainly when there was nothing to move", () => {
    expect(refilePlan(models, "Detector", "UV-Vis", "LC-MS")).toEqual([]);
    expect(refileSummary("Detector", "UV-Vis", "LC-MS", 0))
      .toBe("nothing to move: no Detector model is filed under UV-Vis");
    expect(refileSummary("LC System", "UV-Vis", "LC-MS", 3))
      .toBe("moved LC System from UV-Vis to LC-MS (3 models retagged)");
    expect(refileSummary("LC System", "UV-Vis", "LC-MS", 1)).toContain("1 model retagged");
  });
});
