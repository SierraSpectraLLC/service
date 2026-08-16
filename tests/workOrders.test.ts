import { describe, expect, it } from "vitest";
import {
  ageDays, closeLine, moverOf, nextWoNumber, severityOf, sortWorkOrders, targetDay, woAcceptsWork,
  woLate, woLine, woLive, woMove, woMoves, woOpen, woSettled, WO_STATES,
} from "@/lib/workOrders";

const wo = (over: Partial<{
  number: string; severity: string; state: string; openedOn: string; assignee: string;
}> = {}) => ({
  number: "WO-1001", severity: "Degraded", state: "open", openedOn: "2026-08-01",
  assignee: "", ...over,
});

describe("which orders are still owed", () => {
  it("splits the six states into work to do, work done, and filed", () => {
    expect(WO_STATES.filter(woOpen)).toEqual(["open", "active", "waiting"]);
    expect(WO_STATES.filter(woSettled)).toEqual(["closed", "cancelled"]);
    // Resolved is neither: the work is done, nobody has accepted it yet.
    expect(WO_STATES.filter((s) => !woOpen(s) && !woSettled(s))).toEqual(["resolved"]);
    // And every state is live until it is settled - no state falls off both lists.
    expect(WO_STATES.filter(woLive)).toEqual(WO_STATES.filter((s) => !woSettled(s)));
  });

  it("takes new work until it is filed, not until the work is done", () => {
    expect(woAcceptsWork("active")).toBe(true);
    expect(woAcceptsWork("waiting")).toBe(true);
    // "I forgot to log Tuesday" arrives after the job was finished.
    expect(woAcceptsWork("resolved")).toBe(true);
    // Logging March's job with today's hours is a misclick, not a correction.
    expect(woAcceptsWork("closed")).toBe(false);
    expect(woAcceptsWork("cancelled")).toBe(false);
  });
});

describe("how urgent, and by when", () => {
  it("reads the words the request form offers", () => {
    expect(severityOf("Down").targetDays).toBe(0);
    expect(severityOf("degraded").rank).toBe(1);
    expect(severityOf("Planned").targetDays).toBe(30);
  });

  it("falls to the middle on anything it doesn't recognize", () => {
    // Not "Down": a request arriving with a broken form must not read as an
    // emergency, and must not vanish to the bottom of the list either.
    expect(severityOf("").key).toBe("Degraded");
    expect(severityOf("URGENT!!!").key).toBe("Degraded");
  });

  it("dates the target from the day it was asked for", () => {
    expect(targetDay("Down", "2026-08-12")).toBe("2026-08-12");
    expect(targetDay("Degraded", "2026-08-12")).toBe("2026-08-15");
    expect(targetDay("Planned", "2026-12-15")).toBe("2027-01-14");
  });

  it("calls an order late only while it is still open", () => {
    expect(woLate(wo({ severity: "Down" }), "2026-08-02")).toBe(true);
    expect(woLate(wo({ severity: "Down", state: "closed" }), "2026-09-01")).toBe(false);
    expect(woLate(wo({ severity: "Planned" }), "2026-08-15")).toBe(false);
  });

  it("counts age in whole days and never backwards", () => {
    expect(ageDays("2026-08-01", "2026-08-01")).toBe(0);
    expect(ageDays("2026-08-01", "2026-08-04")).toBe(3);
    // A clock skew or a bad row must not print "-2 days" at a client.
    expect(ageDays("2026-08-10", "2026-08-01")).toBe(0);
    expect(ageDays("nonsense", "2026-08-01")).toBe(0);
  });
});

describe("who may move a work order where", () => {
  const cases: [string, string, "house" | "requester", boolean][] = [
    // The house runs the job.
    ["open", "active", "house", true],
    ["active", "resolved", "house", true],
    ["waiting", "active", "house", true],
    ["resolved", "closed", "house", true],
    ["closed", "active", "house", true],
    ["open", "closed", "house", false],   // finish it before you file it
    ["open", "open", "house", false],

    // The requester asked; they did not take the job on.
    ["open", "cancelled", "requester", true],
    ["resolved", "closed", "requester", true],
    ["resolved", "active", "requester", true],
    ["closed", "active", "requester", true],
    ["open", "resolved", "requester", false],
    ["open", "active", "requester", false],
    ["active", "cancelled", "requester", false],
  ];

  for (const [from, to, who, ok] of cases) {
    it(`${who}: ${from} -> ${to} ${ok ? "allowed" : "refused"}`, () => {
      expect(woMove(from, to, who).ok).toBe(ok);
    });
  }

  it("never lets a client declare their own job finished", () => {
    const res = woMove("active", "resolved", "requester");
    expect(res.ok).toBe(false);
    expect(res.ok === false && res.error).toBe("The service team marks work resolved.");
  });

  it("tells a client to ask rather than just refusing, once work has started", () => {
    const res = woMove("active", "cancelled", "requester");
    expect(res.ok === false && res.error).toMatch(/ask the service team/);
  });

  it("refuses states that are not states at all", () => {
    expect(woMove("open", "finished", "house").ok).toBe(false);
    expect(woMove("gone", "active", "house").ok).toBe(false);
  });

  it("offers nothing on an order the mover has no business in", () => {
    expect(woMoves("waiting", "requester")).toEqual([]);
    expect(woMoves("cancelled", "requester")).toEqual([]);
  });

  it("agrees with itself: every offered move is an allowed move", () => {
    for (const who of ["house", "requester"] as const) {
      for (const from of WO_STATES) {
        for (const to of woMoves(from, who)) {
          expect(woMove(from, to, who).ok, `${who} ${from}->${to}`).toBe(true);
        }
      }
    }
  });
});

describe("which side of the job somebody is on", () => {
  const sierra = { isHouse: true, orgId: null, houseOrgId: 1 };
  const acme = { isHouse: true, orgId: null, houseOrgId: 2 };
  const labzen = { isHouse: false, orgId: 7, houseOrgId: null };
  const someoneElse = { isHouse: false, orgId: 9, houseOrgId: null };
  const order = { tenantOrgId: 1, orgId: 7 };

  it("is the house to the company whose workspace the order lives in", () => {
    expect(moverOf(sierra, order, 7)).toBe("house");
  });

  it("is nobody to a second service company working the same system", () => {
    // Acme can read it and can put work on it. Acme does not close Sierra's job.
    expect(moverOf(acme, order, 7)).toBe(null);
  });

  it("is the requester to the org that asked", () => {
    expect(moverOf(labzen, order, 7)).toBe("requester");
  });

  it("is the requester to the system's owner even when somebody else raised it", () => {
    // Our engineer opens an order on LabZen's instrument. It is still LabZen's
    // job to accept.
    expect(moverOf(labzen, { tenantOrgId: 1, orgId: null }, 7)).toBe("requester");
  });

  it("is nobody to another client entirely", () => {
    expect(moverOf(someoneElse, order, 7)).toBe(null);
    expect(moverOf({ isHouse: false, orgId: null, houseOrgId: null }, order, 7)).toBe(null);
  });

  it("treats the single-house instance, where nothing is stamped, as the house", () => {
    expect(moverOf({ isHouse: true, orgId: null, houseOrgId: null }, { tenantOrgId: null, orgId: 7 }, 7))
      .toBe("house");
  });
});

describe("the order a list is read in", () => {
  it("puts what is owed first, worst first, oldest first", () => {
    const list = [
      wo({ number: "A", state: "closed", openedOn: "2026-08-10" }),
      wo({ number: "B", severity: "Question", openedOn: "2026-08-09" }),
      wo({ number: "C", severity: "Down", openedOn: "2026-08-10" }),
      wo({ number: "D", severity: "Down", openedOn: "2026-08-09" }),
    ];
    // C and D are both late (Down is wanted the same day); D waited longer.
    expect(sortWorkOrders(list, "2026-08-11").map((w) => w.number)).toEqual(["D", "C", "B", "A"]);
  });

  it("shows finished work newest first, because that list answers a different question", () => {
    const list = [
      wo({ number: "OLD", state: "closed", openedOn: "2026-01-02" }),
      wo({ number: "NEW", state: "closed", openedOn: "2026-08-02" }),
    ];
    expect(sortWorkOrders(list, "2026-08-11").map((w) => w.number)).toEqual(["NEW", "OLD"]);
  });

  it("leaves the caller's array alone", () => {
    const list = [wo({ number: "B" }), wo({ number: "A" })];
    sortWorkOrders(list, "2026-08-11");
    expect(list.map((w) => w.number)).toEqual(["B", "A"]);
  });
});

describe("the line under the title", () => {
  it("says how long it has waited and who has it", () => {
    expect(woLine(wo({ assignee: "Joe Harris" }), "2026-08-04")).toBe("Open · 3 days · Joe Harris");
  });

  it("says nobody has it, rather than leaving a gap", () => {
    expect(woLine(wo(), "2026-08-01")).toBe("Open · today · unassigned");
  });

  it("marks it late and counts the work on it", () => {
    expect(woLine(wo({ severity: "Down", state: "active" }), "2026-08-03", { tasks: 4, done: 1 }))
      .toBe("In progress · 2 days · late · 1/4 done · unassigned");
  });

  it("drops the running commentary once it is finished", () => {
    expect(woLine(wo({ state: "closed" }), "2026-09-01")).toBe("Closed");
  });
});

describe("the close-out", () => {
  it("counts what went into the job rather than asking for it again", () => {
    expect(closeLine("Replaced the deuterium lamp and re-ran the baseline.", { tasks: 3, minutes: 150, parts: 1 }))
      .toBe("Replaced the deuterium lamp and re-ran the baseline. (3 tasks, 2.5h, 1 part)");
  });

  it("says only what is true", () => {
    expect(closeLine("Advised over the phone.", { tasks: 0, minutes: 0, parts: 0 }))
      .toBe("Advised over the phone.");
    expect(closeLine("Fitted a seal.", { tasks: 1, minutes: 0, parts: 2 }))
      .toBe("Fitted a seal. (1 task, 2 parts)");
  });
});

describe("numbering", () => {
  it("counts on from the highest used, never on how many exist", () => {
    // WO-1002 deleted: counting rows would hand 1002 out twice, and a number
    // quoted on the phone has to mean one job forever.
    expect(nextWoNumber(["WO-1001", "WO-1003"])).toBe("WO-1004");
    expect(nextWoNumber([])).toBe("WO-1001");
    expect(nextWoNumber(["WO-1001", "not a number"])).toBe("WO-1002");
  });
});
