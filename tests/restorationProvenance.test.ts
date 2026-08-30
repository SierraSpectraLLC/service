import { describe, expect, it } from "vitest";
import { provenanceOf, type ProvenanceInput } from "@/lib/restorationProvenance";
import { PROVENANCE_QUESTIONS } from "@/lib/restoration";

// A project fresh off the truck: nothing documented yet.
const bare = (): ProvenanceInput => ({
  components: { total: 4, serialed: 0 },
  answers: new Map(),
  tasks: null,
  verifyVerdict: null,
  onsiteVerdict: null,
  pcBackup: false,
  wipeCert: false,
  checklists: null,
  outsideWork: null,
});

// Everything a record can carry, all in order.
const complete = (): ProvenanceInput => ({
  components: { total: 4, serialed: 4 },
  answers: new Map(PROVENANCE_QUESTIONS.map((q) => [q.key, q.answers[0]])),
  tasks: { total: 3, done: 3 },
  verifyVerdict: "pass",
  onsiteVerdict: "pass",
  pcBackup: true,
  wipeCert: true,
  checklists: { total: 12, checked: 12 },
  outsideWork: { total: 1, documented: 1 },
});

describe("provenanceOf", () => {
  it("scores a fully documented record at 100", () => {
    expect(provenanceOf(complete()).pct).toBe(100);
  });

  it("scores an empty record at 0", () => {
    expect(provenanceOf(bare()).pct).toBe(0);
  });

  it("stays inside 0..100 whatever it is fed", () => {
    for (const input of [bare(), complete(), { ...bare(), components: { total: 0, serialed: 0 } }]) {
      const { pct } = provenanceOf(input);
      expect(pct).toBeGreaterThanOrEqual(0);
      expect(pct).toBeLessThanOrEqual(100);
    }
  });

  it("earns fractionally for partial serial matches", () => {
    const half = provenanceOf({ ...bare(), components: { total: 4, serialed: 2 } });
    const full = provenanceOf({ ...bare(), components: { total: 4, serialed: 4 } });
    const none = provenanceOf(bare());
    expect(half.pct).toBeGreaterThan(none.pct);
    expect(full.pct).toBeGreaterThan(half.pct);
  });

  it("gives a system with no components nothing for serials, not a pass", () => {
    const { lines } = provenanceOf({ ...bare(), components: { total: 0, serialed: 0 } });
    const serials = lines.find((l) => l.key === "serials")!;
    expect(serials.earned).toBe(0);
    expect(serials.weight).toBeGreaterThan(0);
    expect(serials.tone).toBe("bad");
  });

  it("treats 'unknown' as documented half-knowledge: better than unasked, worse than answered", () => {
    const key = "operational_at_deinstall";
    const unasked = provenanceOf(bare());
    const unknown = provenanceOf({ ...bare(), answers: new Map([[key, "unknown"]]) });
    const answered = provenanceOf({ ...bare(), answers: new Map([[key, "running"]]) });
    const at = (r: ReturnType<typeof provenanceOf>) => r.lines.find((l) => l.key === key)!.earned;
    expect(at(unknown)).toBeGreaterThan(at(unasked));
    expect(at(answered)).toBeGreaterThan(at(unknown));
    expect(unknown.lines.find((l) => l.key === key)!.tone).toBe("warn");
  });

  it("scores a FAIL verdict as half of a PASS - the record knows, the next owner re-proves", () => {
    const pass = provenanceOf({ ...bare(), verifyVerdict: "pass" }).lines.find((l) => l.key === "verify_verdict")!;
    const fail = provenanceOf({ ...bare(), verifyVerdict: "fail" }).lines.find((l) => l.key === "verify_verdict")!;
    const none = provenanceOf(bare()).lines.find((l) => l.key === "verify_verdict")!;
    expect(pass.earned).toBe(pass.weight);
    expect(fail.earned).toBe(pass.weight / 2);
    expect(none.earned).toBe(0);
    expect(fail.tone).toBe("bad");
  });

  it("leaves not-applicable lines out of both sides of the division", () => {
    const withoutTasks = provenanceOf(bare());
    expect(withoutTasks.lines.find((l) => l.key === "tasks")).toBeUndefined();
    const withTasks = provenanceOf({ ...bare(), tasks: { total: 2, done: 2 } });
    expect(withTasks.lines.find((l) => l.key === "tasks")).toBeDefined();
    // Completing work that exists must never READ worse than having none.
    expect(withTasks.pct).toBeGreaterThanOrEqual(withoutTasks.pct);
  });

  it("never lowers the figure when more gets documented", () => {
    // Walk from bare to complete one fact at a time; pct must be monotonic.
    const steps: ProvenanceInput[] = [
      bare(),
      { ...bare(), components: { total: 4, serialed: 4 } },
      { ...bare(), components: { total: 4, serialed: 4 }, answers: new Map([["pm_docs", "unknown"]]) },
      { ...bare(), components: { total: 4, serialed: 4 }, answers: new Map([["pm_docs", "docs"]]) },
      { ...bare(), components: { total: 4, serialed: 4 }, answers: new Map([["pm_docs", "docs"]]), verifyVerdict: "pass" },
      complete(),
    ];
    let last = -1;
    for (const s of steps) {
      const { pct } = provenanceOf(s);
      expect(pct).toBeGreaterThanOrEqual(last);
      last = pct;
    }
  });

  it("renders one line per interview question, keyed for the sidebar", () => {
    const { lines } = provenanceOf(bare());
    for (const q of PROVENANCE_QUESTIONS) {
      const line = lines.find((l) => l.key === q.key)!;
      expect(line).toBeDefined();
      expect(line.value).toBe("Not asked");
      expect(line.tone).toBe("bad");
    }
  });
});
