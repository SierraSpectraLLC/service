import { describe, expect, it } from "vitest";
import { courts, digestCounts, pendingForSystem, type PendingCtx } from "@/lib/digest";

// The digest's one hard question is "whose move is it" - the classification
// that turns a pile of stages, queues, tasks and part statuses into three
// courts: the partner's, ours, a supplier's. Getting a court wrong sends a
// client an action item that was ours, or lets our own blocker hide under
// "waiting on them" - so the mapping is pinned here, case by case.

const now = new Date("2026-08-21T14:00:00Z");
const days = (n: number) => new Date(now.getTime() - n * 86400000);

const sys = (over: Partial<Parameters<typeof pendingForSystem>[0]> = {}) => ({
  id: 1, externalId: "T-003", stages: ["Refurbishment"],
  queueOrgId: null, queueReason: "", queueSince: null, createdAt: days(30),
  ...over,
});

const ctx = (over: Partial<PendingCtx> = {}): PendingCtx => ({
  sectionOrgId: 5,
  orgName: (id) => (id === 5 ? "LabZen" : id === 9 ? "GMI" : "Sierra Spectra"),
  operatorName: "Sierra Spectra",
  blockedTasks: [], waitingWorkOrders: [], openParts: [],
  now,
  ...over,
});

describe("whose court a wait sits in", () => {
  it("a clean moving system pends nothing", () => {
    expect(pendingForSystem(sys(), ctx())).toEqual([]);
  });

  it("a parked system is the queue holder's move, with the reason and the age", () => {
    const items = pendingForSystem(
      sys({ queueOrgId: 5, queueReason: "waiting on their N2 tech", queueSince: days(12) }),
      ctx(),
    );
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ court: "partner", who: "LabZen", what: "waiting on their N2 tech", days: 12 });
  });

  it("a queue with no reason still reads as their move; no since falls back to createdAt", () => {
    const [item] = pendingForSystem(sys({ queueOrgId: 9 }), ctx());
    expect(item.court).toBe("partner");
    expect(item.who).toBe("GMI");
    expect(item.days).toBe(30);
  });

  it("the queue suppresses the softer Waiting / blocked stage reading", () => {
    const items = pendingForSystem(
      sys({ queueOrgId: 5, stages: ["Waiting / blocked"] }), ctx(),
    );
    expect(items).toHaveLength(1);
    expect(items[0].court).toBe("partner");
  });

  it("Waiting / blocked with nobody holding the queue is ours", () => {
    const [item] = pendingForSystem(sys({ stages: ["Waiting / blocked"] }), ctx());
    expect(item).toMatchObject({ court: "us", who: "Sierra Spectra" });
  });

  it("Waiting to ship is ours - the system is done, the shipment is not", () => {
    const [item] = pendingForSystem(sys({ stages: ["Checkout", "Waiting to ship"] }), ctx());
    expect(item.court).toBe("us");
    expect(item.what).toMatch(/waiting to ship/i);
  });

  it("a blocked task is ours", () => {
    const [item] = pendingForSystem(sys(), ctx({ blockedTasks: [{ title: "Vacuum won't hold" }] }));
    expect(item).toMatchObject({ court: "us", what: "Blocked task: Vacuum won't hold" });
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

  it("parts split three ways: asked-of-them, needed-by-us, riding-on-a-supplier", () => {
    const items = pendingForSystem(sys(), ctx({
      openParts: [
        { name: "Turbo pump", status: "Needed", eta: "", requestedOrgId: 5 },
        { name: "Rotor seal", status: "Needed", eta: "", requestedOrgId: null },
        { name: "Ion gauge", status: "Ordered", eta: "Aug 28", requestedOrgId: null },
        { name: "Septa kit", status: "In transit", eta: "", requestedOrgId: null },
        { name: "Filament", status: "Backordered", eta: "", requestedOrgId: null },
      ],
    }));
    expect(items.map((x) => x.court)).toEqual(["partner", "us", "supplier", "supplier", "supplier"]);
    expect(items[0]).toMatchObject({ who: "LabZen", what: "Part to order: Turbo pump" });
    expect(items[2].what).toBe("Part on order: Ion gauge - ETA Aug 28");
    expect(items[3].what).toBe("Part in transit: Septa kit");
    expect(items[4].what).toBe("Part backordered: Filament");
  });

  it("closed part statuses never pend - the caller filters, but a stray one is inert", () => {
    const items = pendingForSystem(sys(), ctx({
      openParts: [{ name: "Liner", status: "Installed", eta: "", requestedOrgId: null }],
    }));
    expect(items).toEqual([]);
  });
});

describe("grouping and totals", () => {
  const mixed = pendingForSystem(
    sys({ queueOrgId: 5, queueSince: days(3) }),
    ctx({
      blockedTasks: [{ title: "a" }],
      openParts: [{ name: "b", status: "Ordered", eta: "", requestedOrgId: null }],
    }),
  );

  it("courts() splits into the three reading groups", () => {
    const c = courts(mixed);
    expect(c.partner).toHaveLength(1);
    expect(c.us).toHaveLength(1);
    expect(c.supplier).toHaveLength(1);
  });

  it("digestCounts sums pendings across sections and boards", () => {
    const section = {
      orgId: 5, name: "LabZen", board: [{} as never, {} as never], pending: mixed,
      gas: [{ externalId: "T-003", gas: "Helium", status: "Low", note: "" }],
      work: [], activity: "",
    };
    const n = digestCounts([section]);
    expect(n).toEqual({ systems: 2, partner: 1, us: 1, supplier: 1, gas: 1 });
  });
});
