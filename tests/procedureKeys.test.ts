import { describe, expect, it } from "vitest";
import { currentSet, keyCollisions, procedureKey, scopeSlug, slug, type KeyedRow } from "@/lib/custody/keys";
import { SCORE_WEIGHTS, handoffGradeFor, howGradeFor, whoGradeFor } from "@/lib/custody/grades";

/**
 * A key is written into events that travel to strangers. The failure this file
 * exists to prevent is a slug rule that drifts - one deploy's `replace-lamp`
 * becoming the next one's `replace_lamp` - which does not break anything
 * loudly: it just quietly splits one machine's lamp history into two piles that
 * never add up again.
 */

const proc = (over: Partial<KeyedRow> = {}): KeyedRow => ({
  id: 1, tenantOrgId: 1, name: "Replace lamp",
  assetType: "Detector", modelScope: [], categoryScope: [], ...over,
});

describe("slug", () => {
  it("is lowercase, hyphenated, and keeps the digits", () => {
    expect(slug("Replace 6890 Liner")).toBe("replace-6890-liner");
    expect(slug("Mass axis calibration")).toBe("mass-axis-calibration");
  });

  it("folds accents rather than dropping the word", () => {
    // "Réservoir" and "Reservoir" are one job. Two keys that look identical in
    // every list they appear in is the worst possible split.
    expect(slug("Réservoir flush")).toBe("reservoir-flush");
  });

  it("collapses punctuation and never leaves a stray hyphen", () => {
    expect(slug("  --Odd--  name!!  ")).toBe("odd-name");
    expect(slug("5% KOH flush")).toBe("5-koh-flush");
    expect(slug("!!!")).toBe("");
  });

  it("truncates without leaving the cut hyphen behind", () => {
    const long = slug(`${"a".repeat(78)} bcdefgh`);
    expect(long.length).toBeLessThanOrEqual(80);
    expect(long.endsWith("-")).toBe(false);
  });
});

describe("scope", () => {
  it("keys on the model when there is one", () => {
    expect(scopeSlug(proc({ modelScope: ["6495C"] }))).toBe("6495c");
  });

  it("falls back to the category, then to the asset type", () => {
    expect(scopeSlug(proc({ categoryScope: ["LC-MS"] }))).toBe("lc-ms");
    expect(scopeSlug(proc())).toBe("detector");
  });

  it("sorts, so a multi-select's order cannot change the key", () => {
    // The arrays are edited by hand in a picker. [A,B] and [B,A] are the same
    // scope, and a key that disagreed would fork the history on a re-save.
    expect(scopeSlug(proc({ modelScope: ["6495C", "1260"] })))
      .toBe(scopeSlug(proc({ modelScope: ["1260", "6495C"] })));
  });

  it("gives an unscoped procedure a word rather than an empty segment", () => {
    expect(procedureKey(proc({ assetType: "" }))).toBe("any/replace-lamp");
  });

  it("refuses to key a nameless procedure instead of inventing one", () => {
    expect(procedureKey(proc({ name: "   " }))).toBe("");
  });
});

describe("collisions", () => {
  it("finds two rows in one workspace that would key the same", () => {
    const found = keyCollisions([
      proc({ id: 1, name: "Replace lamp" }),
      proc({ id: 2, name: "replace  LAMP" }),
      proc({ id: 3, name: "Leak check" }),
    ]);
    expect(found).toHaveLength(1);
    expect(found[0].key).toBe("detector/replace-lamp");
    expect(found[0].ids).toEqual([1, 2]);
  });

  it("does not call two workspaces' identical procedures a collision", () => {
    // Every shop has a lamp change. Keys are scoped per tenant precisely so
    // that two customers of the platform are never in each other's way.
    expect(keyCollisions([proc({ id: 1, tenantOrgId: 1 }), proc({ id: 2, tenantOrgId: 2 })])).toEqual([]);
  });

  it("ignores rows it could not key at all", () => {
    expect(keyCollisions([proc({ id: 1, name: "" }), proc({ id: 2, name: "!!" })])).toEqual([]);
  });
});

describe("set versioning", () => {
  const set = (over: Partial<Parameters<typeof currentSet>[0][number]>) => ({
    id: 1, assetType: "Detector", modelScope: [] as string[], version: 1,
    publishedAt: new Date("2026-01-01"), ...over,
  });

  it("takes the highest published version", () => {
    const got = currentSet([set({ id: 1, version: 1 }), set({ id: 2, version: 3 }), set({ id: 3, version: 2 })], "Detector", "6495C");
    expect(got?.id).toBe(2);
  });

  it("never takes a draft", () => {
    // A sheet printed from an unpublished set is a sheet whose steps can still
    // change under it, which is the one thing paper cannot survive.
    expect(currentSet([set({ id: 1, version: 9, publishedAt: null })], "Detector", "6495C")).toBeNull();
  });

  it("prefers the set written about this model over the catch-all", () => {
    const got = currentSet([
      set({ id: 1, version: 2, modelScope: [] }),
      set({ id: 2, version: 2, modelScope: ["6495C"] }),
    ], "Detector", "6495C");
    expect(got?.id).toBe(2);
  });

  it("does not hand a model a set scoped to another one", () => {
    expect(currentSet([set({ modelScope: ["1260"] })], "Detector", "6495C")).toBeNull();
  });
});

describe("who said it happened", () => {
  it("calls the custodian's own work self-reported", () => {
    expect(whoGradeFor({ authorOrgId: 5, custodianOrgId: 5, backfilled: false })).toBe("self_reported");
  });

  it("calls an outside org's work third-party", () => {
    expect(whoGradeFor({ authorOrgId: 6, custodianOrgId: 5, backfilled: false })).toBe("third_party");
  });

  it("grades an unverified outside author down rather than up", () => {
    // An org grading its own subsidiary as third-party is the obvious way to
    // buy a score, so the cheap direction to be wrong in is the modest one.
    expect(whoGradeFor({ authorOrgId: 6, custodianOrgId: 5, backfilled: false, authorVerified: false }))
      .toBe("self_reported");
  });

  it("calls an assertion about unwitnessed work attested, whoever makes it", () => {
    expect(whoGradeFor({ authorOrgId: 6, custodianOrgId: 5, backfilled: true })).toBe("attested");
    expect(whoGradeFor({ authorOrgId: 5, custodianOrgId: 5, backfilled: true })).toBe("attested");
  });
});

describe("how it was recorded", () => {
  it("counts evidence, not the shape of the form", () => {
    expect(howGradeFor({ results: 1, checklistDone: 0, written: 0 })).toBe("procedure_run");
    expect(howGradeFor({ results: 0, checklistDone: 4, written: 0 })).toBe("procedure_run");
    expect(howGradeFor({ results: 0, checklistDone: 0, written: 120 })).toBe("typed");
  });

  it("calls a file with nothing structured behind it document-only", () => {
    expect(howGradeFor({ results: 0, checklistDone: 0, written: 0, documents: 1 })).toBe("document_only");
  });

  it("does not let a ticked box outrank a reading by being written up", () => {
    expect(howGradeFor({ results: 1, checklistDone: 0, written: 900 })).toBe("procedure_run");
  });
});

describe("the weights", () => {
  it("prices an unsealed gap below every kind of handoff", () => {
    // A chain that priced a disappearance like a clean handoff would pay people
    // to disappear rather than seal.
    const { close } = SCORE_WEIGHTS;
    expect(close.dormant_gap).toBeLessThan(close.closed_by_claim);
    expect(close.closed_by_claim).toBeLessThan(close.steward_sealed);
    expect(close.steward_sealed).toBeLessThan(close.sealed);
  });

  it("orders both grade axes the way the ADR says", () => {
    expect(SCORE_WEIGHTS.who.third_party).toBeGreaterThan(SCORE_WEIGHTS.who.self_reported);
    expect(SCORE_WEIGHTS.who.self_reported).toBeGreaterThan(SCORE_WEIGHTS.who.attested);
    expect(SCORE_WEIGHTS.how.procedure_run).toBeGreaterThan(SCORE_WEIGHTS.how.typed);
    expect(SCORE_WEIGHTS.how.typed).toBeGreaterThan(SCORE_WEIGHTS.how.document_only);
  });

  it("maps every close kind to a grade the weights price", () => {
    for (const kind of ["sealed", "steward_sealed", "dormant", "claimed"] as const) {
      const grade = handoffGradeFor(kind);
      expect(grade).not.toBeNull();
      expect(SCORE_WEIGHTS.close[grade!]).toBeGreaterThan(0);
    }
    expect(handoffGradeFor("open")).toBeNull();
  });
});
