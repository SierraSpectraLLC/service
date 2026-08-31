// What maintenance costs - the question job costing has never asked.
//
// The gap, as the shop put it: "It seems like it already accepts costs related
// to work orders. What about maintenance?" It did not. costingBoard reads
// closed work orders and joins parts, hours and expenses on work_order_id; a
// completed PM is a Done task carrying its schedule's id, so every preventive
// job the shop had ever done was invisible on the money side. The parts were
// already stamped - lib/agreementUsage sums them, for the sole purpose of
// keeping them OFF a contract's parts allowance - so the money was computed in
// order not to be billed, and then never shown leaving.
//
// The hard part is not the sum, it is the ATTRIBUTION: pm_schedule_id names
// the recurring schedule and not the visit, so a quarterly PM is one id and
// twelve completions. Most of what is pinned here is that rule holding at its
// edges, because a part landing on the wrong cycle is a wrong number that
// looks completely reasonable.
import { describe, expect, it } from "vitest";
import { pmCosts, type PmCompletion, type PmPart } from "@/lib/pmCosting";

const TODAY = "2026-08-31";

const done = (over: Partial<PmCompletion> = {}): PmCompletion => ({
  taskId: 1, scheduleId: 7, title: "Quarterly source clean",
  orgName: "Puget Diagnostics", systemName: "LCMS-8050 + LC-40",
  href: "/instruments/3#task-1", completedOn: "2026-08-14",
  ...over,
});

const part = (over: Partial<PmPart> = {}): PmPart => ({
  scheduleId: 7, installedOn: "2026-08-14", costCents: 41200, onWorkOrder: "",
  ...over,
});

describe("what a completed maintenance job cost", () => {
  it("puts the parts fitted for it against it", () => {
    const b = pmCosts([done()], [part(), part({ costCents: 8600 })], TODAY, 90);
    expect(b.rows).toHaveLength(1);
    expect(b.rows[0]!.partsCents).toBe(49800);
    expect(b.rows[0]!.parts).toBe(2);
    expect(b.totalCents).toBe(49800);
  });

  it("counts a kit once, not twice over", () => {
    /*
     * "Whether it's a full kit or individual components." A kit line carries
     * the money and its contents are written at zero cost by the parts schema,
     * so the box and everything in it sums to the price of the box. No special
     * case here, and that is the point - it is worth a test precisely because
     * it looks like the place a double charge would hide.
     */
    const kit = part({ costCents: 120000 });
    const contents = [0, 0, 0, 0].map(() => part({ costCents: 0 }));
    const b = pmCosts([done()], [kit, ...contents], TODAY, 90);
    expect(b.rows[0]!.partsCents).toBe(120000);
  });

  it("reports nothing billed, because a PM bills nothing", () => {
    // No margin, no percentage, no revenue field to be wrong about. An invoice
    // points at a work order or an agreement and never at a schedule, so the
    // only honest figure a PM has is what it cost.
    const b = pmCosts([done()], [part()], TODAY, 90);
    expect(Object.keys(b.rows[0]!)).not.toContain("billedCents");
    expect(Object.keys(b.rows[0]!)).not.toContain("marginPct");
  });
});

describe("which cycle a part belongs to", () => {
  const cycles = [
    done({ taskId: 1, completedOn: "2026-02-10" }),
    done({ taskId: 2, completedOn: "2026-05-12" }),
    done({ taskId: 3, completedOn: "2026-08-14" }),
  ];

  it("lands on the completion it was fitted for, not the newest one", () => {
    // Fitted on the day of the May visit. A rule that simply took the latest
    // completion would have charged August for it, and August's margin - and
    // May's - would both have been wrong while looking entirely plausible.
    const b = pmCosts(cycles, [part({ installedOn: "2026-05-12" })], TODAY, 365);
    expect(b.rows.find((r) => r.taskId === 2)!.partsCents).toBe(41200);
    expect(b.rows.some((r) => r.taskId === 3)).toBe(false);
  });

  it("puts a part fitted between visits on the next one to finish", () => {
    // Ordered in June, fitted in June, and the job it was fitted FOR is the
    // August visit - the next time anybody completed that schedule.
    const b = pmCosts(cycles, [part({ installedOn: "2026-06-20" })], TODAY, 365);
    expect(b.rows.find((r) => r.taskId === 3)!.partsCents).toBe(41200);
  });

  it("holds a part fitted since the last visit until the next one completes", () => {
    // Real money, and not yet on a finished job. Charging it to the August
    // visit that has already been signed off would rewrite a closed number.
    const b = pmCosts(cycles, [part({ installedOn: "2026-08-25" })], TODAY, 365);
    expect(b.totalCents).toBe(0);
    expect(b.quiet).toBe(3);
  });

  it("needs every completion, not only the window's", () => {
    /*
     * THE REASON pmCostingBoard reads every Done PM record rather than the
     * window's. Handed only what the 30-day window shows, a seal fitted in
     * February has no earlier completion to land on and falls onto August -
     * February's spend, dressed up as this month's.
     */
    const seal = part({ installedOn: "2026-02-10" });
    const whole = pmCosts(cycles, [seal], TODAY, 30);
    expect(whole.rows).toHaveLength(0);       // it belongs to February, out of window

    const windowOnly = pmCosts([cycles[2]!], [seal], TODAY, 30);
    expect(windowOnly.rows[0]!.partsCents).toBe(41200);  // the bug, if the loader narrowed
  });

  it("never fitted is never spent", () => {
    // Matches lib/agreementUsage: a part in a box has not been spent on the
    // job yet. A blank date also cannot be placed on a cycle at all.
    const b = pmCosts([done()], [part({ installedOn: "" })], TODAY, 90);
    expect(b.totalCents).toBe(0);
    expect(b.quiet).toBe(1);
  });
});

describe("money that another panel already counts", () => {
  it("leaves a work order's part to the work order, and says where it went", () => {
    /*
     * Both panels are on one page. A part carrying a work_order_id is already
     * in the row above, and adding it here would put one purchase into two
     * totals on one screen - which is how two figures come to disagree in
     * front of the customer. The row names the job instead of reading low for
     * no stated reason.
     */
    const b = pmCosts([done()], [
      part({ costCents: 41200 }),
      part({ costCents: 90000, onWorkOrder: "WO-0412" }),
    ], TODAY, 90);
    expect(b.rows[0]!.partsCents).toBe(41200);
    expect(b.rows[0]!.parts).toBe(1);
    expect(b.rows[0]!.note).toBe("parts costed on WO-0412");
  });

  it("still shows a PM whose parts were all costed elsewhere", () => {
    // Zero with an explanation beats an absent row: the PM happened, it took
    // parts, and somebody looking for them needs to be told where they are.
    const b = pmCosts([done()], [part({ onWorkOrder: "WO-0412" })], TODAY, 90);
    expect(b.rows).toHaveLength(1);
    expect(b.rows[0]!.partsCents).toBe(0);
    expect(b.rows[0]!.note).toBe("parts costed on WO-0412");
  });

  it("names each job once, in order", () => {
    const b = pmCosts([done()], [
      part({ onWorkOrder: "WO-0412" }), part({ onWorkOrder: "WO-0412" }),
      part({ onWorkOrder: "WO-0388" }),
    ], TODAY, 90);
    expect(b.rows[0]!.note).toBe("parts costed on WO-0388, WO-0412");
  });
});

describe("the shape of the board", () => {
  it("counts the PMs that took no parts instead of listing them", () => {
    // A quarter of empty rows would bury the ones that cost something, and a
    // figure that silently vanishes is how two screens disagree. Counted.
    const b = pmCosts([
      done({ taskId: 1 }), done({ taskId: 2, scheduleId: 8 }), done({ taskId: 3, scheduleId: 9 }),
    ], [part({ scheduleId: 8 })], TODAY, 90);
    expect(b.rows).toHaveLength(1);
    expect(b.rows[0]!.taskId).toBe(2);
    expect(b.quiet).toBe(2);
  });

  it("is newest first", () => {
    const b = pmCosts([
      done({ taskId: 1, scheduleId: 7, completedOn: "2026-06-01" }),
      done({ taskId: 2, scheduleId: 8, completedOn: "2026-08-14" }),
    ], [part({ scheduleId: 7, installedOn: "2026-06-01" }), part({ scheduleId: 8 })], TODAY, 365);
    expect(b.rows.map((r) => r.taskId)).toEqual([2, 1]);
  });

  it("drops what closed before the window and keeps its parts out of the total", () => {
    const b = pmCosts([
      done({ taskId: 1, scheduleId: 7, completedOn: "2026-01-04" }),
      done({ taskId: 2, scheduleId: 8, completedOn: "2026-08-14" }),
    ], [
      part({ scheduleId: 7, installedOn: "2026-01-04", costCents: 500000 }),
      part({ scheduleId: 8, costCents: 41200 }),
    ], TODAY, 30);
    expect(b.rows).toHaveLength(1);
    expect(b.totalCents).toBe(41200);
  });
});
