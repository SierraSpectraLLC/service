import { describe, expect, it } from "vitest";
import {
  courts, digestCounts, digestDue, followUpsForSystem, handoffFor, pendingForSystem,
  type PendingCtx,
} from "@/lib/digest";
import { digestGapDays, parseDigestDays, serializeDigestDays, windowLabel } from "@/lib/digestDays";

// The digest's hard questions are pinned here, case by case:
//
//   - "whose move is it" (courts: partner / us / supplier) - getting one
//     wrong sends a client an action item that was ours, or hides our own
//     blocker under "waiting on them";
//   - "handed off is not blocked" - a system kicked to the partner's queue
//     left our repair board, and must raise nothing anywhere;
//   - "state facts, don't invent stories" - a part without tracking is "No
//     tracking yet", in the court of whoever ordered it, never a claim about
//     who is telephoning which vendor;
//   - "what do we chase today" - a blocked system with no recorded reason.

const now = new Date("2026-08-21T14:00:00Z");
const days = (n: number) => new Date(now.getTime() - n * 86400000);

const sys = (over: Partial<{
  id: number; externalId: string; stages: string[]; blockedReason: string; blockedSince: Date | null;
}> = {}) => ({
  id: 1, externalId: "T-003", stages: ["Refurbishment"],
  blockedReason: "", blockedSince: null as Date | null, ...over,
});

const ctx = (over: Partial<PendingCtx> = {}): PendingCtx => ({
  sectionOrgId: 5,
  orgName: (id) => (id === 5 ? "LabZen" : id === 9 ? "GMI" : "Sierra Spectra"),
  operatorName: "Sierra Spectra",
  blockedTasks: [], waitingWorkOrders: [], openParts: [],
  now,
  ...over,
});

const part = (over: Partial<PendingCtx["openParts"][number]> = {}) => ({
  name: "Rotor seal", status: "Needed", eta: "", tracking: "",
  requestedOrgId: null, requestedAt: null, poId: null, ...over,
});

describe("handed off is not blocked", () => {
  const queued = {
    id: 1, externalId: "P-001",
    queueOrgId: 5, queueReason: "Caffeine Checkout passed", queueSince: days(7), createdAt: days(90),
  };

  it("a system in another org's queue is a handoff: name, holder, reason, age", () => {
    expect(handoffFor(queued, "Shimadzu LC-2040C Plus", ctx().orgName, now)).toEqual({
      systemId: 1, externalId: "P-001", label: "Shimadzu LC-2040C Plus", holder: "LabZen",
      reason: "Caffeine Checkout passed", days: 7,
    });
  });

  it("no queueSince falls back to createdAt; our own queue is no handoff", () => {
    expect(handoffFor({ ...queued, queueSince: null }, "", ctx().orgName, now)?.days).toBe(90);
    expect(handoffFor({ ...queued, queueOrgId: null }, "", ctx().orgName, now)).toBeNull();
  });

  it("a handed-off system chases nothing, even blocked with no reason", () => {
    expect(followUpsForSystem(
      { id: 1, externalId: "P-001", stages: ["Waiting / blocked"], queueOrgId: 5, lead: "Joe", blockedReason: "" },
      0,
    )).toEqual([]);
  });
});

describe("whose court a wait sits in", () => {
  it("a clean moving system pends nothing", () => {
    expect(pendingForSystem(sys(), ctx())).toEqual([]);
  });

  it("a blocked system leads with the reason it was blocked for, aged from then", () => {
    const [item] = pendingForSystem(
      sys({
        stages: ["Waiting / blocked"],
        blockedReason: "waiting on LabZen to approve the quote", blockedSince: days(6),
      }), ctx());
    expect(item).toMatchObject({
      court: "us", who: "Sierra Spectra",
      what: "Blocked: waiting on LabZen to approve the quote", days: 6,
    });
  });

  it("blocked with no reason says nothing here - the chase list asks instead", () => {
    expect(pendingForSystem(sys({ stages: ["Waiting / blocked"] }), ctx())).toEqual([]);
  });

  it("blocked tasks list beneath the reason, as their own lines", () => {
    const items = pendingForSystem(
      sys({ stages: ["Waiting / blocked"], blockedReason: "no bench space" }),
      ctx({ blockedTasks: [{ title: "Vacuum won't hold" }] }),
    );
    expect(items.map((x) => x.what)).toEqual([
      "Blocked: no bench space", "Blocked task: Vacuum won't hold",
    ]);
  });

  it("Waiting to ship is ours - the system is done, the shipment is not", () => {
    const [item] = pendingForSystem(sys({ stages: ["Checkout", "Waiting to ship"] }), ctx());
    expect(item.court).toBe("us");
    expect(item.what).toMatch(/waiting to ship/i);
  });

  it("a waiting work order follows who raised it: the partner's is theirs, anyone else's is ours", () => {
    const theirs = pendingForSystem(sys(), ctx({
      waitingWorkOrders: [{ number: "WO-1042", title: "Baseline noise", orgId: 5 }],
    }))[0];
    expect(theirs).toMatchObject({ court: "partner", who: "LabZen" });
    const ours = pendingForSystem(sys(), ctx({
      waitingWorkOrders: [{ number: "", title: "Leak check", orgId: null }],
    }))[0];
    expect(ours.court).toBe("us");
    expect(ours.what).toBe("Work order waiting: Leak check");
  });

  it("a part asked of the partner is their move, aged from when we asked", () => {
    const [item] = pendingForSystem(sys(), ctx({
      openParts: [part({ name: "Turbo pump", requestedOrgId: 5, requestedAt: days(5) })],
    }));
    expect(item).toMatchObject({ court: "partner", who: "LabZen", what: "Part to order: Turbo pump", days: 5 });
  });

  // The default nobody had set: a part needed for a client's own instrument
  // is bought with the client's money. Reading every unrequested part as ours
  // told them their purchasing was our job.
  it("an unrequested part on a partner's system is theirs to buy - their machine, their money", () => {
    const [item] = pendingForSystem(sys(), ctx({ openParts: [part({ name: "AOC-20S Mounting Bracket" })] }));
    expect(item).toMatchObject({
      court: "partner", who: "LabZen", what: "Part to order: AOC-20S Mounting Bracket", days: null,
    });
  });

  it("a part we put on one of our own purchase orders is ours, whosever system it is", () => {
    const [item] = pendingForSystem(sys(), ctx({ openParts: [part({ poId: 42 })] }));
    expect(item).toMatchObject({ court: "us", who: "Sierra Spectra", what: "Part needed: Rotor seal" });
  });

  it("on the house's own work every part is ours, purchase order or not", () => {
    const [item] = pendingForSystem(sys(), ctx({ sectionOrgId: null, openParts: [part()] }));
    expect(item).toMatchObject({ court: "us", what: "Part needed: Rotor seal" });
  });

  it("a part moving WITH tracking rides with the supplier", () => {
    const moving = pendingForSystem(sys(), ctx({
      openParts: [part({ name: "Ion gauge", status: "Ordered", tracking: "1Z999", eta: "Aug 28" })],
    }))[0];
    expect(moving).toMatchObject({ court: "supplier", what: "Part on order: Ion gauge - ETA Aug 28" });
  });

  it("no tracking is a plain stated fact in the buyer's court - no invented vendor-chasing", () => {
    // Their instrument, no purchase order of ours: their order, their number.
    const theirs = pendingForSystem(sys(), ctx({
      openParts: [part({ name: "H-ESI Needle Seal", status: "Ordered", tracking: "" })],
    }))[0];
    expect(theirs).toMatchObject({ court: "partner", who: "LabZen", what: "No tracking yet for H-ESI Needle Seal" });
    // We raised the purchase order, so the number is ours to produce.
    const ours = pendingForSystem(sys(), ctx({
      openParts: [part({ name: "H-ESI Needle Seal", status: "Ordered", tracking: "", poId: 42 })],
    }))[0];
    expect(ours).toMatchObject({ court: "us", who: "Sierra Spectra" });
  });

  it("a backorder with no date reads the same way, courted by the buyer", () => {
    const ours = pendingForSystem(sys(), ctx({
      sectionOrgId: null, openParts: [part({ name: "Filament", status: "Backordered" })],
    }))[0];
    expect(ours).toMatchObject({ court: "us", what: "Backordered: Filament - no firm ETA yet" });
    const theirs = pendingForSystem(sys(), ctx({
      openParts: [part({ name: "Filament", status: "Backordered", requestedOrgId: 9 })],
    }))[0];
    expect(theirs).toMatchObject({ court: "partner", who: "GMI" });
  });

  it("closed part statuses never pend - the caller filters, but a stray one is inert", () => {
    expect(pendingForSystem(sys(), ctx({
      openParts: [part({ status: "Installed" })],
    }))).toEqual([]);
  });
});

describe("the chase list", () => {
  const ours = (stages: string[] = ["Refurbishment"], lead = "Joe", blockedReason = "") =>
    ({ id: 1, externalId: "T-003", stages, queueOrgId: null, lead, blockedReason });

  it("blocked with no recorded reason pesters the lead for one", () => {
    const [f] = followUpsForSystem(ours(["Waiting / blocked"]), 0);
    expect(f.text).toBe("Blocked with no recorded reason - ask Joe what's blocking and what clears it");
    const [anon] = followUpsForSystem(ours(["Waiting / blocked"], ""), 0);
    expect(anon.text).toMatch(/ask the team/);
  });

  it("a recorded reason, or a blocked task standing in for one, ends the asking", () => {
    expect(followUpsForSystem(ours(["Waiting / blocked"], "Joe", "waiting on the quote"), 0)).toEqual([]);
    expect(followUpsForSystem(ours(["Waiting / blocked"]), 1)).toEqual([]);
  });

  it("an unblocked system chases nothing", () => {
    expect(followUpsForSystem(ours(), 0)).toEqual([]);
  });
});

describe("grouping and totals", () => {
  const mixed = pendingForSystem(
    sys(),
    ctx({
      blockedTasks: [{ title: "a" }],
      waitingWorkOrders: [{ number: "", title: "b", orgId: 5 }],
      openParts: [part({ name: "c", status: "Ordered", tracking: "t" })],
    }),
  );

  it("courts() splits into the three reading groups", () => {
    const c = courts(mixed);
    expect(c.partner).toHaveLength(1);
    expect(c.us).toHaveLength(1);
    expect(c.supplier).toHaveLength(1);
  });

  it("digestCounts sums pendings, chases and handoffs across sections", () => {
    const section = {
      orgId: 5, name: "LabZen", board: [{} as never, {} as never], pending: mixed,
      followUps: [{ systemId: 1, externalId: "T-003", text: "chase" }],
      handoffs: [{ systemId: 2, externalId: "P-001", label: "LC-2040C", holder: "LabZen", reason: "", days: 3 }],
      gas: [{ externalId: "T-003", gas: "Helium", status: "Low", note: "" }],
      failedTests: [{ externalId: "T-003", title: "Flow Check", value: "1.2 mL/min", days: 2, required: true }],
      work: [], activity: "",
    };
    const n = digestCounts([section]);
    expect(n).toEqual({ systems: 2, partner: 1, us: 1, supplier: 1, followUps: 1, handoffs: 1, gas: 1, failed: 1 });
  });
});

// The schedule. The cron fires every hour and this one comparison decides
// whether anything goes out, so the ways it could misfire are the ways the
// digest arrives twice, or at three in the morning, or never.
describe("when an edition is due", () => {
  const at7 = { digestHour: 7, digestLastSentOn: "", digestDays: "" };

  it("waits for the configured hour", () => {
    expect(digestDue(at7, 6, "2026-08-21")).toBe(false);
    expect(digestDue(at7, 7, "2026-08-21")).toBe(true);
  });

  it("never sends twice on the same day, whatever the hour", () => {
    const gone = { digestHour: 7, digestLastSentOn: "2026-08-21", digestDays: "" };
    for (let h = 0; h < 24; h++) expect(digestDue(gone, h, "2026-08-21")).toBe(false);
  });

  it("a missed hour still sends later the same day rather than vanishing", () => {
    // A cron blip at 07:00, or an hour the module spent switched off.
    expect(digestDue(at7, 11, "2026-08-21")).toBe(true);
  });

  it("a new day clears yesterday's stamp", () => {
    const gone = { digestHour: 7, digestLastSentOn: "2026-08-20", digestDays: "" };
    expect(digestDue(gone, 6, "2026-08-21")).toBe(false);
    expect(digestDue(gone, 7, "2026-08-21")).toBe(true);
  });

  it("midnight is an hour like any other - 0 must not read as unset", () => {
    expect(digestDue({ digestHour: 0, digestLastSentOn: "", digestDays: "" }, 0, "2026-08-21")).toBe(true);
  });

  it("rests on days not ticked; blank means every day", () => {
    const weekdaysOnly = { digestHour: 7, digestLastSentOn: "", digestDays: "1,2,3,4,5" };
    expect(digestDue(weekdaysOnly, 9, "2026-08-22")).toBe(false);  // Saturday
    expect(digestDue(weekdaysOnly, 9, "2026-08-23")).toBe(false);  // Sunday
    expect(digestDue(weekdaysOnly, 9, "2026-08-24")).toBe(true);   // Monday
    expect(digestDue(at7, 9, "2026-08-22")).toBe(true);            // no restriction
  });
});

// The window: an edition covers everything since the last one, which is what
// lets a digest rest over the weekend without the weekend's work vanishing.
describe("how far back an edition reaches", () => {
  it("one day after an ordinary morning; three after a Friday-to-Monday rest", () => {
    expect(digestGapDays("2026-08-20", "2026-08-21")).toBe(1);
    expect(digestGapDays("2026-08-21", "2026-08-24")).toBe(3);     // Fri -> Mon
  });

  it("no history reads as one day, and a dormant digest is capped at a week", () => {
    expect(digestGapDays("", "2026-08-21")).toBe(1);
    expect(digestGapDays("not-a-date", "2026-08-21")).toBe(1);
    expect(digestGapDays("2026-06-01", "2026-08-21")).toBe(7);
  });

  it("names its window: yesterday, the weekend, or the day it opens", () => {
    expect(windowLabel(1, 4)).toBe("Since yesterday");
    expect(windowLabel(3, 5)).toBe("Over the weekend");             // Fri -> Mon
    expect(windowLabel(4, 4)).toBe("Since Thursday");               // holiday weekend
  });
});

describe("which days count", () => {
  it("parses loosely, stores canonically, and all seven days is no restriction", () => {
    expect(parseDigestDays("5, 1,1,3")).toEqual([1, 3, 5]);
    expect(parseDigestDays("")).toEqual([]);
    expect(serializeDigestDays([5, 1, 3])).toBe("1,3,5");
    expect(serializeDigestDays([0, 1, 2, 3, 4, 5, 6])).toBe("");
    expect(serializeDigestDays([9, -1] as number[])).toBe("");
  });
});
