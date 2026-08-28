// A multi-year award, and the day a decision has to be made.
//
// The worked example is the solicitation this was built for: a base year and
// four option years, Sep 29 to Sep 28, 60 days' notice on each option. What is
// held down hardest is LAPSED - an option nobody exercised in time - because it
// is the one state nothing else in the app can express and the one that costs a
// year of revenue when it goes unnoticed.
import { describe, expect, it } from "vitest";
import {
  awardLine, awardValue, daysToDecide, decisionsDue, exerciseProblems,
  optionDeadline, periodStanding, periodValue, standingWord, type AwardLike, type PeriodLike,
} from "@/lib/award";
import { formatCents } from "@/lib/money";

const AWARD: AwardLike = { awardedOn: "2026-08-30", optionNoticeDays: 60 };

/** Period i of a five-year award starting 2026-09-29, at $68k rising 3%. */
const period = (i: number, over: Partial<PeriodLike> = {}): PeriodLike => ({
  periodIndex: i,
  status: i === 0 ? "active" : "draft",
  startsOn: `${2026 + i}-09-29`,
  endsOn: `${2027 + i}-09-28`,
  renewNoticeDays: 60,
  billAmountCents: Math.round(6_800_000 * 1.03 ** i),
  valueCents: null,
  ...over,
});

const LADDER = [0, 1, 2, 3, 4].map((i) => period(i));

describe("where a period stands", () => {
  const today = "2027-01-15";   // inside the base year

  it("tells the base year from the options behind it", () => {
    expect(periodStanding(LADDER[0], today)).toBe("running");
    expect(periodStanding(LADDER[1], today)).toBe("option");
    expect(periodStanding(LADDER[4], today)).toBe("option");
  });

  it("calls an unexercised option LAPSED once its term has begun", () => {
    /*
     * The state worth the money, and the one no existing vocabulary has. On
     * 2027-10-01 option year 1 was due to start on 2027-09-29 and is still a
     * draft: the window closed. "Draft" would leave it sitting on a list
     * looking available, which is how a year goes missing.
     */
    expect(periodStanding(LADDER[1], "2027-10-01")).toBe("lapsed");
    expect(periodStanding(LADDER[1], "2027-09-28")).toBe("option");
  });

  it("separates exercised from started", () => {
    // Agreed in July for a term beginning in September. Neither an option any
    // more nor in force yet, and reporting it as either is wrong.
    const taken = period(1, { status: "active" });
    expect(periodStanding(taken, "2027-07-01")).toBe("taken");
    expect(periodStanding(taken, "2027-10-01")).toBe("running");
  });

  it("never says the base year was exercised", () => {
    // Nobody exercised it - it was committed the day the award was signed, and
    // between then and its start date that is what it is. "Exercised" on
    // period 0 is wrong in a way somebody will query.
    const notYet = period(0, { status: "active", startsOn: "2026-09-29" });
    expect(periodStanding(notYet, "2026-08-27")).toBe("taken");
    expect(standingWord("taken", 0)).toBe("Committed");
    expect(standingWord("taken", 1)).toBe("Exercised");
    expect(standingWord("lapsed", 0)).toBe(standingWord("lapsed", 3));
  });

  it("keeps a decision somebody made", () => {
    expect(periodStanding(period(2, { status: "cancelled" }), today)).toBe("declined");
  });

  it("is finished once its term is over", () => {
    expect(periodStanding(LADDER[0], "2028-01-01")).toBe("over");
  });
});

describe("the day it has to be decided", () => {
  it("counts back the notice from the period's start", () => {
    expect(optionDeadline(LADDER[1], AWARD)).toBe("2027-07-31");
    expect(daysToDecide(LADDER[1], AWARD, "2027-07-01")).toBe(30);
    expect(daysToDecide(LADDER[1], AWARD, "2027-08-15")).toBe(-15);
  });

  it("has no deadline when there is no start date to count from", () => {
    // Better than a date computed from nothing, which would be confidently wrong.
    expect(optionDeadline({ startsOn: "" }, AWARD)).toBe("");
    expect(daysToDecide(period(1, { startsOn: "" }), AWARD, "2027-07-01")).toBeNull();
  });
});

describe("what needs deciding", () => {
  it("raises an option before the last legal day, not on it", () => {
    // 2027-07-01 is 30 days from the deadline: inside the default window.
    const due = decisionsDue(LADDER, AWARD, "2027-07-01");
    expect(due.map((d) => d.period.periodIndex)).toEqual([1]);
    expect(due[0].days).toBe(30);
  });

  it("says nothing while every decision is a year out", () => {
    expect(decisionsDue(LADDER, AWARD, "2027-01-15")).toEqual([]);
  });

  it("always surfaces a lapsed one, whatever the window", () => {
    // The most urgent conversation on the list and the one nobody is having.
    const due = decisionsDue(LADDER, AWARD, "2027-10-05");
    expect(due.map((d) => d.standing)).toContain("lapsed");
  });

  it("soonest first", () => {
    const due = decisionsDue(LADDER, AWARD, "2027-07-01", 500);
    expect(due.map((d) => d.period.periodIndex)).toEqual([1, 2]);
  });
});

describe("what the award is worth", () => {
  it("never reports the total on its own", () => {
    /*
     * "A $361,000 award" is four fifths a hope. One year is committed and the
     * rest is a series of decisions somebody else makes, so a forecast built
     * on the total is a forecast of another company's intentions.
     */
    const v = awardValue(LADDER, "2027-01-15");
    expect(v.committedCents).toBe(LADDER[0].billAmountCents);
    expect(v.optionCents).toBe(LADDER.slice(1).reduce((a, p) => a + p.billAmountCents, 0));
    expect(v.committedCents + v.optionCents).toBe(v.totalCents);
    expect(v.optionCents).toBeGreaterThan(v.committedCents * 3);
  });

  it("moves a year out of options when it is exercised, and out of both when it lapses", () => {
    const taken = [period(0, { status: "active" }), period(1, { status: "active" }), period(2)];
    const t = awardValue(taken, "2027-07-01");
    expect(t.optionCents).toBe(period(2).billAmountCents);
    expect(t.lostCents).toBe(0);

    const lost = awardValue(taken, "2028-10-05");   // period 2 never exercised
    expect(lost.lostCents).toBe(period(2).billAmountCents);
    expect(lost.optionCents).toBe(0);
  });

  it("takes what it bills, falling back to what somebody wrote down", () => {
    expect(periodValue(period(0, { billAmountCents: 0, valueCents: 500_000 }))).toBe(500_000);
    expect(periodValue(period(0, { billAmountCents: 100, valueCents: 500_000 }))).toBe(100);
  });
});

describe("exercising one", () => {
  it("allows an option and refuses what is already decided", () => {
    expect(exerciseProblems(LADDER[1], "2027-07-01")).toEqual([]);
    expect(exerciseProblems(LADDER[0], "2027-01-15")[0]).toContain("in force");
    expect(exerciseProblems(period(2, { status: "cancelled" }), "2027-01-15")[0]).toContain("declined");
  });

  it("warns about a late exercise rather than refusing it", () => {
    /*
     * A client CAN come back late, and a shop that cannot record that has to
     * lie in its own books. But it back-dates a term that has already partly
     * run, so it is said out loud.
     */
    const late = exerciseProblems(LADDER[1], "2027-10-05");
    expect(late[0]).toContain("back-dates");
  });
});

describe("the sentence a person reads", () => {
  it("leads with what is decided and names the next decision", () => {
    const line = awardLine(LADDER, AWARD, "2027-07-01", formatCents);
    expect(line).toContain("committed");
    expect(line).toContain("still optional");
    expect(line).toContain("must be decided by 2027-07-31");
    expect(line).toContain("30 days");
  });

  it("says so when one has gone", () => {
    expect(awardLine(LADDER, AWARD, "2027-10-05", formatCents)).toContain("lapsed on 2027-07-31");
  });

  it("has nothing to say about no periods", () => {
    expect(awardLine([], AWARD, "2027-07-01", formatCents)).toBe("");
  });
});
