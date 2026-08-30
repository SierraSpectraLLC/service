import { describe, expect, it } from "vitest";
import {
  noticesFor, permitted, repoNotice, safetyNotice,
  type RepoFacts, type SafetyFacts,
} from "@/lib/fleetNotice";

const repo = (o: Partial<RepoFacts> = {}): RepoFacts => ({
  noticeText: "Property of Sierra Spectra. Account past due - call 555-0100.",
  approvedBy: "joe@sierraspectra.com", rung: "notice", ...o,
});

const safety = (o: Partial<SafetyFacts> = {}): SafetyFacts => ({
  reason: "Source heater overshooting setpoint; thermal fault suspected.",
  decidedBy: "bill@sierraspectra.com", contact: "Sierra Spectra 555-0100",
  effect: "hold", ...o,
});

describe("repossession notices inform and nothing more", () => {
  it("never asks to lock, at any rung", () => {
    for (const rung of ["notice", "prominent", "at_login"] as const) {
      expect(repoNotice(repo({ rung }))?.mayLockAtIdle).toBe(false);
    }
  });

  it("does not render without an approver's name on it", () => {
    expect(repoNotice(repo({ approvedBy: "" }))).toBeNull();
    expect(repoNotice(repo({ approvedBy: "   " }))).toBeNull();
  });

  it("does not render with nothing to say", () => {
    expect(repoNotice(repo({ noticeText: "  " }))).toBeNull();
  });
});

describe("safety holds advise, and only the sharpest rung may lock", () => {
  it("only 'lock' carries permission to lock", () => {
    expect(safetyNotice(safety({ effect: "advise" }))?.mayLockAtIdle).toBe(false);
    expect(safetyNotice(safety({ effect: "hold" }))?.mayLockAtIdle).toBe(false);
    expect(safetyNotice(safety({ effect: "lock" }))?.mayLockAtIdle).toBe(true);
  });

  it("says do-not-run for anything past advice", () => {
    expect(safetyNotice(safety({ effect: "advise" }))?.text).not.toMatch(/Do not start/);
    expect(safetyNotice(safety({ effect: "hold" }))?.text).toMatch(/^Do not start new runs\./);
  });

  it("does not render without a named decision-maker", () => {
    expect(safetyNotice(safety({ decidedBy: "" }))).toBeNull();
  });
});

/**
 * THE INVARIANT.
 *
 * Not a grep for the word "invoice" - a behavioural pin. The safety decision is
 * computed here against every credit standing this business can be in, and the
 * results must be byte-identical. A money field wired into the safety path to
 * make a lock happen sooner cannot pass this without also being dead weight.
 */
describe("safety is invariant under money", () => {
  const standings = [
    { label: "clear", onHold: false, balanceCents: 0, oldestDaysLate: 0 },
    { label: "slightly late", onHold: false, balanceCents: 120_00, oldestDaysLate: 12 },
    { label: "on credit hold", onHold: true, balanceCents: 48_000_00, oldestDaysLate: 61 },
    { label: "referred out", onHold: true, balanceCents: 250_000_00, oldestDaysLate: 400 },
  ];

  it("produces the same safety notice in every standing", () => {
    for (const effect of ["advise", "hold", "lock"] as const) {
      const results = standings.map(() => safetyNotice(safety({ effect })));
      const first = JSON.stringify(results[0]);
      for (const r of results) expect(JSON.stringify(r)).toBe(first);
    }
  });

  it("owing money never raises a safety hold on its own", () => {
    // The worst standing there is, with no engineering fault: silence.
    expect(safetyNotice(safety({ reason: "", decidedBy: "" }))).toBeNull();
    expect(noticesFor(null, { reason: "", decidedBy: "", contact: "", effect: "lock" })).toEqual([]);
  });

  it("paying up never clears a safety hold", () => {
    // Nothing in this module can retire a fault. Only clearing the hold does.
    expect(safetyNotice(safety({ effect: "lock" }))?.mayLockAtIdle).toBe(true);
  });
});

describe("ordering and consent", () => {
  it("puts the fault above the bill", () => {
    const out = noticesFor(repo(), safety());
    expect(out.map((n) => n.kind)).toEqual(["safety", "repo"]);
  });

  it("a machine that has changed hands is advised, never locked", () => {
    const out = permitted(noticesFor(repo(), safety({ effect: "lock" })), "consent");
    expect(out.every((n) => !n.mayLockAtIdle)).toBe(true);
    // The advice survives - it is worth more there than anywhere.
    expect(out.find((n) => n.kind === "safety")?.text).toMatch(/Do not start/);
  });

  it("a bench unit in our own shop keeps the rung", () => {
    const out = permitted(noticesFor(null, safety({ effect: "lock" })), "unattended");
    expect(out[0].mayLockAtIdle).toBe(true);
  });
});
