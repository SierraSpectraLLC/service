// A wait nobody owes a move on.
//
// The report, about a UV-VIS handed back to its owner after a finished PM:
// "I don't like this giant 'waiting on client' banner - I don't care. It's out
// of my hands, it's in theirs. The system is marked 'in service' so it doesn't
// matter to me."
//
// The banner was right about the facts and wrong about all of them. The system
// WAS with Modesto Irrigation District, it HAD been for nineteen days, and the
// reason on it read "Maintenance Complete - OK to Run" - which is the sentence
// that says nobody is waiting on anything. Amber, at the top of the record,
// with a Move it button, for nineteen days of a machine running correctly in
// somebody else's lab.
//
// The cause: the page asked queueView (who holds it) and never queueNeedsThem
// (does anybody owe a move). It had the second question already - it just
// asked it about the VIEWER, and on a staff screen the answer is structurally
// no, because a system parked with a client is by definition not blocked on
// us. Asked about the HOLDER it separates the two waits that were one colour.
import { describe, expect, it } from "vitest";
import { settledWait } from "@/lib/queue";
import { standingTone } from "@/lib/panelMode";
import { queueNeedsThem } from "@/lib/clientView";

describe("what counts as settled", () => {
  it("is a wait with somebody else and nothing owed", () => {
    expect(settledWait({ isStaff: true, isMine: false, pendingOnHolder: false })).toBe(true);
  });

  it("is not settled while they owe a move", () => {
    // PM fallen due on a system in their lab: only they can grant the window,
    // so the wait is real and the banner has something to say.
    expect(settledWait({ isStaff: true, isMine: false, pendingOnHolder: true })).toBe(false);
  });

  it("is never settled when we are the ones holding it", () => {
    // Ours to move is not a wait at all, and the line says something else.
    expect(settledWait({ isStaff: true, isMine: true, pendingOnHolder: false })).toBe(false);
  });

  it("is never settled on a client's screen", () => {
    /*
     * The asymmetry is deliberate, not an oversight. "With Sierra Spectra" at
     * the top of a client's record is the answer to WHERE IS MY INSTRUMENT -
     * the single most useful sentence on that page - and suppressing it
     * because the shop owes nothing today would delete the answer along with
     * the alarm. Their mirror-image case is the dismissible handback line.
     */
    expect(settledWait({ isStaff: false, isMine: false, pendingOnHolder: false })).toBe(false);
  });
});

describe("the tone the whole record takes from it", () => {
  it("used to go amber on any wait, and no longer does", () => {
    expect(standingTone({ isMine: false, overdue: false })).toBe("warn");
    expect(standingTone({ isMine: false, overdue: false, settled: true })).toBe("good");
  });

  it("keeps amber while a move is genuinely owed", () => {
    expect(standingTone({ isMine: false, overdue: false, settled: false })).toBe("warn");
  });

  it("still goes red when something behind the wait is late", () => {
    /*
     * Settled means nobody owes a MOVE. An overdue task behind the wait means
     * a date somebody committed to has already gone past, which outranks it -
     * otherwise the calmest possible page would be the one furthest behind.
     */
    expect(standingTone({ isMine: false, overdue: true, settled: true })).toBe("bad");
    expect(standingTone({ isMine: true, overdue: true, settled: true })).toBe("bad");
  });

  it("leaves ours-and-fine exactly where it was", () => {
    expect(standingTone({ isMine: true, overdue: false })).toBe("good");
  });
});

describe("what the holder has to owe for the wait to count", () => {
  /*
   * settledWait takes pendingOnHolder as a boolean because only the page can
   * resolve it. These pin the rule it has to resolve it BY - the same one the
   * client's side has always used, so the two screens cannot drift into
   * disagreeing about whether a wait is a wait.
   */
  it("counts maintenance fallen due - only they can grant the window", () => {
    expect(queueNeedsThem({ pmDue: true, blockedOnThem: false })).toBe(true);
  });

  it("counts a block parked on them", () => {
    expect(queueNeedsThem({ pmDue: false, blockedOnThem: true })).toBe(true);
  });

  it("counts a healthy machine sitting in their lab as nothing at all", () => {
    expect(queueNeedsThem({ pmDue: false, blockedOnThem: false })).toBe(false);
  });
});
