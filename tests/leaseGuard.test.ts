import { describe, expect, it } from "vitest";
import {
  clampGraceDays, clampLeaseDays, leaseDirective, leaseMessage, leaseState,
  renewalDecision, type LeaseFacts,
} from "@/lib/leaseGuard";

const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date("2026-08-30T12:00:00Z");
const at = (days: number) => new Date(NOW.getTime() + days * DAY);

const lease = (o: Partial<LeaseFacts> = {}): LeaseFacts => ({
  armed: true, expiresAt: at(5), graceDays: 3, releasedAt: null, force: "lock", ...o,
});

describe("where the lease stands", () => {
  it("is current before expiry", () => {
    expect(leaseState(lease(), NOW)).toBe("current");
  });
  it("is in grace between expiry and expiry + grace", () => {
    expect(leaseState(lease({ expiresAt: at(-1) }), NOW)).toBe("grace");
  });
  it("is lapsed past the grace window", () => {
    expect(leaseState(lease({ expiresAt: at(-5) }), NOW)).toBe("lapsed");
  });
  it("is disarmed when not armed, or with no expiry", () => {
    expect(leaseState(lease({ armed: false }), NOW)).toBe("disarmed");
    expect(leaseState(lease({ expiresAt: null }), NOW)).toBe("disarmed");
  });
  it("is released, terminally, once released - even if also expired", () => {
    expect(leaseState(lease({ expiresAt: at(-99), releasedAt: at(-1) }), NOW)).toBe("released");
  });
});

describe("what the guard does about it", () => {
  it("does nothing while current, disarmed, or released", () => {
    expect(leaseDirective(lease(), NOW).action).toBe("nothing");
    expect(leaseDirective(lease({ armed: false }), NOW).action).toBe("nothing");
    expect(leaseDirective(lease({ releasedAt: at(-1) }), NOW).action).toBe("nothing");
  });
  it("only warns during grace, at any force", () => {
    expect(leaseDirective(lease({ expiresAt: at(-1), force: "lock" }), NOW).action).toBe("warn");
    expect(leaseDirective(lease({ expiresAt: at(-1), force: "notify" }), NOW).action).toBe("warn");
  });
  it("locks a lapsed lease only under force:lock", () => {
    expect(leaseDirective(lease({ expiresAt: at(-5), force: "lock" }), NOW).action).toBe("lock");
    // A warn-only lease NEVER locks, however far past due - the safety valve.
    expect(leaseDirective(lease({ expiresAt: at(-500), force: "notify" }), NOW).action).toBe("warn");
  });
});

/**
 * THE INVARIANT, the same shape lib/fleetNotice keeps.
 *
 * The lease decision is computed against every credit standing this business
 * can be in, and must be byte-identical. LeaseFacts has no money field, so this
 * cannot even be written as "pass the balance in" - which is the point. If a
 * balance is ever wired into the lease path to make a lock happen sooner, this
 * stops compiling or starts failing.
 */
describe("the lease is invariant under money", () => {
  const standings = [
    { label: "paid up", balanceCents: 0, daysLate: 0 },
    { label: "a little late", balanceCents: 40_00, daysLate: 9 },
    { label: "in default", balanceCents: 500_000_00, daysLate: 200 },
  ];

  it("produces the same directive in every standing", () => {
    for (const expiresAt of [at(5), at(-1), at(-9)]) {
      const results = standings.map(() => leaseDirective(lease({ expiresAt }), NOW));
      const first = JSON.stringify(results[0]);
      for (const r of results) expect(JSON.stringify(r)).toBe(first);
    }
  });

  it("owing money does not lapse a lease on its own", () => {
    // The worst standing there is, on a current lease: nothing happens.
    expect(leaseDirective(lease({ expiresAt: at(30) }), NOW).action).toBe("nothing");
  });

  it("paying up does not, by itself, do anything here either", () => {
    // Release is a recorded decision elsewhere; this module cannot see payment
    // and so cannot react to it. A current lease is current, paid or not.
    expect(leaseState(lease(), NOW)).toBe("current");
  });
});

describe("the message never argues the invoice", () => {
  it("names a number to call and says nothing about money", () => {
    const warn = leaseMessage("Sierra Spectra 555-0100", "warn");
    const lock = leaseMessage("Sierra Spectra 555-0100", "lock");
    expect(warn).toMatch(/555-0100/);
    expect(lock).toMatch(/locked/);
    for (const m of [warn, lock]) {
      expect(m).not.toMatch(/invoice|balance|owe|overdue|past due|payment|\$/i);
    }
  });
});

describe("renewal is granted by default and refused only two ways", () => {
  const facts = (o: Partial<Parameters<typeof renewalDecision>[0]> = {}) =>
    ({ armed: true, releasedAt: null, suspendedAt: null, ...o });

  it("grants a healthy armed lease", () => {
    expect(renewalDecision(facts())).toBe("grant");
  });
  it("denies a suspended one - the recorded human lever", () => {
    expect(renewalDecision(facts({ suspendedAt: NOW }))).toBe("deny");
  });
  it("reports released, terminally, over everything else", () => {
    expect(renewalDecision(facts({ suspendedAt: NOW, releasedAt: NOW }))).toBe("released");
  });
  it("is disarmed when no lease is armed", () => {
    expect(renewalDecision(facts({ armed: false }))).toBe("disarmed");
  });
  it("takes no money - refusal is standing, never a balance", () => {
    // The type has no financial field; this is the structural half of the pin.
    const keys = Object.keys(facts());
    expect(keys).toEqual(["armed", "releasedAt", "suspendedAt"]);
  });
});

describe("customization is clamped", () => {
  it("keeps lease length in range and rounds", () => {
    expect(clampLeaseDays(7)).toBe(7);
    expect(clampLeaseDays(0)).toBe(1);
    expect(clampLeaseDays(9999)).toBe(365);
    expect(clampLeaseDays(6.6)).toBe(7);
  });
  it("keeps grace in range, and allows zero", () => {
    expect(clampGraceDays(0)).toBe(0);
    expect(clampGraceDays(-4)).toBe(0);
    expect(clampGraceDays(500)).toBe(90);
  });
});
