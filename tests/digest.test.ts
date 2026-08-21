import { describe, expect, it } from "vitest";
import {
  courts, digestCounts, followUpsForSystem, handoffFor, pendingForSystem, type PendingCtx,
} from "@/lib/digest";

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

const sys = (over: Partial<{ id: number; externalId: string; stages: string[] }> = {}) => ({
  id: 1, externalId: "T-003", stages: ["Refurbishment"], ...over,
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
  requestedOrgId: null, requestedAt: null, ...over,
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
      { id: 1, externalId: "P-001", stages: ["Waiting / blocked"], queueOrgId: 5, lead: "Joe" },
      0,
    )).toEqual([]);
  });
});

describe("whose court a wait sits in", () => {
  it("a clean moving system pends nothing", () => {
    expect(pendingForSystem(sys(), ctx())).toEqual([]);
  });

  it("the Waiting / blocked stage adds no line of its own - blocked TASKS are the reasons", () => {
    expect(pendingForSystem(sys({ stages: ["Waiting / blocked"] }), ctx())).toEqual([]);
    const [item] = pendingForSystem(
      sys({ stages: ["Waiting / blocked"] }),
      ctx({ blockedTasks: [{ title: "Vacuum won't hold" }] }),
    );
    expect(item).toMatchObject({ court: "us", what: "Blocked task: Vacuum won't hold" });
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

  it("a part we still need to order is ours", () => {
    const [item] = pendingForSystem(sys(), ctx({ openParts: [part()] }));
    expect(item).toMatchObject({ court: "us", what: "Part needed: Rotor seal" });
  });

  it("a part moving WITH tracking rides with the supplier", () => {
    const moving = pendingForSystem(sys(), ctx({
      openParts: [part({ name: "Ion gauge", status: "Ordered", tracking: "1Z999", eta: "Aug 28" })],
    }))[0];
    expect(moving).toMatchObject({ court: "supplier", what: "Part on order: Ion gauge - ETA Aug 28" });
  });

  it("no tracking is a plain stated fact in the court of whoever ordered - no invented vendor-chasing", () => {
    // We ordered it (nobody was asked): ours to produce a number.
    const ours = pendingForSystem(sys(), ctx({
      openParts: [part({ name: "H-ESI Needle Seal", status: "Ordered", tracking: "" })],
    }))[0];
    expect(ours).toMatchObject({ court: "us", what: "No tracking yet for H-ESI Needle Seal" });
    // The partner ordered it (we asked them): the tracking is theirs to share.
    const theirs = pendingForSystem(sys(), ctx({
      openParts: [part({ name: "H-ESI Needle Seal", status: "Ordered", tracking: "", requestedOrgId: 5, requestedAt: days(3) })],
    }))[0];
    expect(theirs).toMatchObject({ court: "partner", who: "LabZen", what: "No tracking yet for H-ESI Needle Seal", days: 3 });
  });

  it("a backorder with no date reads the same way, courted by the orderer", () => {
    const ours = pendingForSystem(sys(), ctx({
      openParts: [part({ name: "Filament", status: "Backordered" })],
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
  const ours = (stages: string[] = ["Refurbishment"], lead = "Joe") =>
    ({ id: 1, externalId: "T-003", stages, queueOrgId: null, lead });

  it("blocked with no recorded reason pesters the lead for one; a blocked task IS the reason", () => {
    const [f] = followUpsForSystem(ours(["Waiting / blocked"]), 0);
    expect(f.text).toBe("Blocked with no recorded reason - ask Joe what's blocking and what clears it");
    expect(followUpsForSystem(ours(["Waiting / blocked"]), 1)).toEqual([]);
    const [anon] = followUpsForSystem(ours(["Waiting / blocked"], ""), 0);
    expect(anon.text).toMatch(/ask the team/);
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
      work: [], activity: "",
    };
    const n = digestCounts([section]);
    expect(n).toEqual({ systems: 2, partner: 1, us: 1, supplier: 1, followUps: 1, handoffs: 1, gas: 1 });
  });
});
