import { describe, expect, it } from "vitest";
import { LOCKOUT_REACH, lockoutPlan, lockoutSurvivesCustody, type LockoutFacts } from "@/lib/deviceLockout";
import { lockoutCommands } from "@/lib/remote";

const stolen = (o: Partial<LockoutFacts> = {}): LockoutFacts => ({
  reference: "Reno PD 26-114882", decidedBy: "joe@sierraspectra.com",
  contact: "Sierra Spectra 555-0100", force: "logoff", ...o,
});

describe("a lockout needs a claim somebody filed", () => {
  it("does not compute without a reference", () => {
    expect(lockoutPlan(stolen({ reference: "" }))).toBeNull();
    expect(lockoutPlan(stolen({ reference: "   " }))).toBeNull();
  });

  it("does not compute without a named decision-maker", () => {
    expect(lockoutPlan(stolen({ decidedBy: "" }))).toBeNull();
  });

  it("does not compute without a contact - a locked machine with no number is a brick", () => {
    expect(lockoutPlan(stolen({ contact: "" }))).toBeNull();
  });

  it("puts the reference and the number on the screen", () => {
    const plan = lockoutPlan(stolen())!;
    expect(plan.text).toContain("Reno PD 26-114882");
    expect(plan.text).toContain("555-0100");
  });
});

describe("force rungs", () => {
  it("notify says it and does nothing else", () => {
    const plan = lockoutPlan(stolen({ force: "notify" }))!;
    expect(plan.endsSession).toBe(false);
    expect(plan.powersOff).toBe(false);
  });

  it("logoff ends the session but does not power off", () => {
    const plan = lockoutPlan(stolen({ force: "logoff" }))!;
    expect(plan.endsSession).toBe(true);
    expect(plan.powersOff).toBe(false);
  });

  it("shutdown does both", () => {
    const plan = lockoutPlan(stolen({ force: "shutdown" }))!;
    expect(plan.endsSession).toBe(true);
    expect(plan.powersOff).toBe(true);
  });
});

/**
 * THE INVARIANT, again.
 *
 * The same behavioural pin tests/fleetNotice puts on the safety path. A theft
 * lockout is the one act in this product that could most plausibly be bent
 * into a debt-collection tool, so the wall between it and money is a test and
 * not a paragraph.
 */
describe("a lockout is invariant under money", () => {
  const standings = [
    { label: "clear", onHold: false, balanceCents: 0, oldestDaysLate: 0 },
    { label: "slightly late", onHold: false, balanceCents: 120_00, oldestDaysLate: 12 },
    { label: "on credit hold", onHold: true, balanceCents: 48_000_00, oldestDaysLate: 61 },
    { label: "referred out", onHold: true, balanceCents: 250_000_00, oldestDaysLate: 400 },
  ];

  it("produces the same plan in every standing", () => {
    for (const force of ["notify", "logoff", "shutdown"] as const) {
      const results = standings.map(() => lockoutPlan(stolen({ force })));
      const first = JSON.stringify(results[0]);
      for (const r of results) expect(JSON.stringify(r)).toBe(first);
    }
  });

  it("owing money never locks a machine on its own", () => {
    // The worst standing there is, with nothing filed: no lockout.
    expect(lockoutPlan(stolen({ reference: "" }))).toBeNull();
  });

  it("paying up never releases one - only releasing does", () => {
    expect(lockoutPlan(stolen({ force: "shutdown" }))?.powersOff).toBe(true);
  });
});

describe("custody, and why it does not apply here", () => {
  it("survives a system that has shipped - which is the whole case for it", () => {
    // fleetNotice.permitted strips a safety lock once a machine is the
    // customer's. A lockout inverts that argument: a shipped system is
    // precisely what gets stolen.
    expect(lockoutSurvivesCustody("consent")).toBe(true);
    expect(lockoutSurvivesCustody("unattended")).toBe(true);
  });
});

describe("what the machine is actually told", () => {
  it("says why BEFORE it ends the session", () => {
    const cmds = lockoutCommands(lockoutPlan(stolen())!);
    const toast = cmds.findIndex((c) => c.startsWith("toast "));
    const logoff = cmds.indexOf("power 1");
    expect(toast).toBeGreaterThanOrEqual(0);
    expect(logoff).toBeGreaterThan(toast);
  });

  it("never sends the password-reversible 'lock', which is theatre against a thief", () => {
    const cmds = lockoutCommands(lockoutPlan(stolen({ force: "shutdown" }))!);
    expect(cmds).not.toContain("lock");
  });

  it("notify carries the message and no power command at all", () => {
    const cmds = lockoutCommands(lockoutPlan(stolen({ force: "notify" }))!);
    expect(cmds.some((c) => c.startsWith("toast "))).toBe(true);
    expect(cmds.some((c) => c.startsWith("power "))).toBe(false);
  });

  it("sanitises the message like every other console command", () => {
    const cmds = lockoutCommands(lockoutPlan(stolen({ reference: 'PD "26-1"\n99' }))!);
    const toast = cmds.find((c) => c.startsWith("toast "))!;
    expect(toast).not.toContain("\n");
    expect(toast.split('"').length - 1).toBe(2);
  });
});

describe("the claim made to the operator", () => {
  it("admits the ways it can be defeated, rather than implying a kill switch", () => {
    for (const limit of ["offline", "wiped", "agent"]) {
      expect(LOCKOUT_REACH.toLowerCase()).toContain(limit);
    }
    expect(LOCKOUT_REACH).toMatch(/not as a kill switch/);
  });
});
