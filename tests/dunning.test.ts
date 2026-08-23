// The ladder, the fee arithmetic and the promise rule. Pure functions, no DB.
import { describe, expect, it } from "vitest";
import { DEFAULT_POLICY, type BillingPolicy } from "@/lib/billingPolicy";
import {
  brokenPromiseLine, contactFor, feeFor, isReferred, LADDER, ladderFor,
  nextAction, promiseBroken, rungDate, RUNG_BY_KEY,
} from "@/lib/dunning";

const policy = (over: Partial<BillingPolicy> = {}): BillingPolicy => ({
  ...DEFAULT_POLICY,
  escalation: [
    { name: "K. Osei", role: "Lab manager" },
    { name: "R. Chen", role: "Purchasing director" },
    { name: "M. Vance", role: "Controller" },
  ],
  ...over,
});

describe("the ladder is data", () => {
  it("runs from a nudge before the due date to a packet at ninety days", () => {
    expect(LADDER.map((r) => r.key)).toEqual(["nudge", "due", "statement", "fee", "owner", "final", "refer"]);
    expect(LADDER[0].offsetDays).toBe(-7);
    expect(LADDER[LADDER.length - 1].offsetDays).toBe(90);
  });

  it("dates each rung off the due date", () => {
    expect(rungDate("2026-08-11", RUNG_BY_KEY.nudge)).toBe("2026-08-04");
    expect(rungDate("2026-08-11", RUNG_BY_KEY.due)).toBe("2026-08-11");
    expect(rungDate("2026-08-11", RUNG_BY_KEY.owner)).toBe("2026-09-25");
    expect(rungDate("", RUNG_BY_KEY.due)).toBe("");
  });

  it("addresses a new person at each rung past the first", () => {
    const p = policy();
    expect(contactFor(RUNG_BY_KEY.nudge, p)).toBeNull();
    expect(contactFor(RUNG_BY_KEY.statement, p)?.name).toBe("K. Osei");
    expect(contactFor(RUNG_BY_KEY.owner, p)?.name).toBe("R. Chen");
    expect(contactFor(RUNG_BY_KEY.final, p)?.name).toBe("M. Vance");
  });

  it("falls back to the last named escalation, never down to the billing contact", () => {
    const p = policy({ escalation: [{ name: "K. Osei", role: "Lab manager" }] });
    expect(contactFor(RUNG_BY_KEY.final, p)?.name).toBe("K. Osei");
    expect(contactFor(RUNG_BY_KEY.final, policy({ escalation: [] }))).toBeNull();
  });
});

describe("ladderFor / nextAction", () => {
  const base = { dueOn: "2026-07-12", policy: policy(), log: [] as { rung: string; sentOn: string }[] };

  it("marks what has been sent, what is due and what is ahead", () => {
    const steps = ladderFor({ ...base, today: "2026-07-20", log: [{ rung: "nudge", sentOn: "2026-07-05" }] });
    expect(steps.find((s) => s.rung.key === "nudge")?.state).toBe("done");
    expect(steps.find((s) => s.rung.key === "due")?.state).toBe("now");
    expect(steps.find((s) => s.rung.key === "statement")?.state).toBe("ahead");
  });

  it("acts on the furthest rung due, not the earliest missed one", () => {
    // Fifty days past due with nothing sent: the answer is the owner letter,
    // not three reminders it should have had in July.
    const step = nextAction({ ...base, today: "2026-08-31" });
    expect(step?.rung.key).toBe("owner");
    expect(step?.contact?.name).toBe("R. Chen");
  });

  it("has nothing to do before the first rung comes round", () => {
    expect(nextAction({ ...base, today: "2026-07-01" })).toBeNull();
  });

  it("has nothing to do when every due rung has been sent", () => {
    const log = [{ rung: "nudge", sentOn: "2026-07-05" }, { rung: "due", sentOn: "2026-07-12" }];
    expect(nextAction({ ...base, today: "2026-07-14", log })).toBeNull();
  });

  it("skips a rung when a promise was broken", () => {
    const plain = nextAction({ ...base, today: "2026-07-28" });
    expect(plain?.rung.key).toBe("statement");
    const after = nextAction({ ...base, today: "2026-07-28", promiseBroken: true });
    expect(after?.rung.key).toBe("fee");
    expect(after?.contact?.name).toBe("K. Osei");
  });

  it("knows a referred invoice is off the ladder", () => {
    expect(isReferred([{ rung: "owner", sentOn: "x" }])).toBe(false);
    expect(isReferred([{ rung: "refer", sentOn: "x" }])).toBe(true);
  });

  it("never has a rung due without a due date", () => {
    expect(nextAction({ ...base, dueOn: "", today: "2026-12-31" })).toBeNull();
  });
});

describe("feeFor", () => {
  const base = { policy: policy(), dueOn: "2026-07-12", payableCents: 390000 };

  it("charges nothing inside the grace period, and says how long is left", () => {
    const q = feeFor({ ...base, today: "2026-07-18" });
    expect(q.amountCents).toBe(0);
    expect(q.blocked).toContain("4 days to go");
  });

  it("charges nothing before the due date at all", () => {
    expect(feeFor({ ...base, today: "2026-07-01" }).blocked).toBe("This invoice is not late yet.");
  });

  it("accrues simple interest by the day at a monthly rate", () => {
    // 1.5%/mo on $3,900 = $58.50 a month; 41 days late is 31 past a 10-day
    // grace, so 31/30 of a month.
    const q = feeFor({ ...base, today: "2026-08-22" });
    expect(q.amountCents).toBe(6045);
    expect(q.basis).toContain("1.50% per month on $3,900");
    expect(q.basis).toContain("31 days past the 10-day grace period");
  });

  it("charges only on what is actually being asked for", () => {
    // A disputed line is already out of payableCents, so the fee follows it.
    const q = feeFor({ ...base, today: "2026-08-22", payableCents: 84000 });
    expect(q.amountCents).toBe(1302);
  });

  it("posts a flat charge once per late month", () => {
    const flat = policy({ feeType: "flat", flatCents: 7500, graceDays: 3 });
    // Twenty days late, seventeen past a three-day grace: one late period.
    const first = feeFor({ policy: flat, dueOn: "2026-07-12", today: "2026-08-01", payableCents: 390000 });
    expect(first.amountCents).toBe(7500);
    expect(first.basis).toContain("Flat late charge of $75");
    const again = feeFor({
      policy: flat, dueOn: "2026-07-12", today: "2026-08-01",
      payableCents: 390000, postedOn: ["2026-07-16"],
    });
    expect(again.amountCents).toBe(0);
    expect(again.blocked).toContain("already been posted");
    // A second month has elapsed, so a second charge is due.
    const nextMonth = feeFor({
      policy: flat, dueOn: "2026-07-12", today: "2026-08-22",
      payableCents: 390000, postedOn: ["2026-07-16"],
    });
    expect(nextMonth.amountCents).toBe(7500);
  });

  it("charges nothing when the policy says so, or when nothing is owed", () => {
    expect(feeFor({ ...base, today: "2026-09-01", policy: policy({ feeType: "none" }) }).amountCents).toBe(0);
    expect(feeFor({ ...base, today: "2026-09-01", payableCents: 0 }).blocked).toContain("Nothing is being asked for");
    expect(feeFor({ ...base, dueOn: "", today: "2026-09-01" }).blocked).toContain("no due date");
  });

  it("charges on parts alone when the policy says parts", () => {
    const p = policy({ appliesTo: "parts" });
    const q = feeFor({ ...base, policy: p, today: "2026-08-22", partsCents: 100000 });
    expect(q.basis).toContain("$1,000 of parts");
    expect(feeFor({ ...base, policy: p, today: "2026-08-22", partsCents: 0 }).blocked)
      .toContain("charges on parts, and there are none");
  });
});

describe("promises", () => {
  it("is broken only once the day has passed with nothing paid", () => {
    expect(promiseBroken({ promisedOn: "2026-08-20", byName: "K", keptOn: null }, "2026-08-22")).toBe(true);
    expect(promiseBroken({ promisedOn: "2026-08-20", byName: "K", keptOn: null }, "2026-08-20")).toBe(false);
    expect(promiseBroken({ promisedOn: "2026-08-20", byName: "K", keptOn: "2026-08-21" }, "2026-08-22")).toBe(false);
  });

  it("says one sentence the morning after, and nothing when nothing is broken", () => {
    const rows = [
      { promisedOn: "2026-08-20", byName: "K. Osei", keptOn: null },
      { promisedOn: "2026-08-25", byName: "K. Osei", keptOn: null },
    ];
    expect(brokenPromiseLine(rows, "2026-08-22", "INV-0087"))
      .toBe("K. Osei promised INV-0087 by 2026-08-20 - 2 days past the promise.");
    expect(brokenPromiseLine([rows[1]], "2026-08-22", "INV-0087")).toBeNull();
    expect(brokenPromiseLine([], "2026-08-22", "INV-0087")).toBeNull();
  });
});
