import { describe, expect, it } from "vitest";
import { canKick, daysSince, parkedDaysBefore, queueView } from "@/lib/queue";

const d = (iso: string) => new Date(iso);
const HOUSE = null;
const LABZEN = 7;
const ACME = 9;

describe("daysSince", () => {
  it("floors to whole days", () => {
    expect(daysSince(d("2026-08-01T00:00:00Z"), d("2026-08-07T10:00:00Z"))).toBe(6);
    expect(daysSince(d("2026-08-07T00:00:00Z"), d("2026-08-07T10:00:00Z"))).toBe(0);
    // Clock skew must never read as negative age.
    expect(daysSince(d("2026-08-09T00:00:00Z"), d("2026-08-07T00:00:00Z"))).toBe(0);
  });
});

describe("queueView", () => {
  it("is the house's move when nobody else holds it", () => {
    expect(queueView({ role: "staff", orgId: null }, { queueOrgId: HOUSE })).toBe("mine");
    // ...and NOT the client's move, which is the whole point of the axis.
    expect(queueView({ role: "client_editor", orgId: LABZEN }, { queueOrgId: HOUSE })).toBe("elsewhere");
  });

  it("is the holder's move once parked, including for the house", () => {
    expect(queueView({ role: "client_editor", orgId: LABZEN }, { queueOrgId: LABZEN })).toBe("mine");
    expect(queueView({ role: "owner", orgId: null }, { queueOrgId: LABZEN })).toBe("elsewhere");
    expect(queueView({ role: "client_editor", orgId: ACME }, { queueOrgId: LABZEN })).toBe("elsewhere");
  });
});

describe("canKick", () => {
  const live = { queueOrgId: LABZEN, ownerOrgId: ACME, archived: false };

  it("lets the house move anything live", () => {
    expect(canKick({ role: "staff", orgId: null }, live)).toBe(true);
    expect(canKick({ role: "owner", orgId: null }, { ...live, archived: true })).toBe(false);
  });

  it("lets whoever holds it hand it back", () => {
    expect(canKick({ role: "client_editor", orgId: LABZEN }, live)).toBe(true);
  });

  it("lets the owner pull their own system back", () => {
    expect(canKick({ role: "client_editor", orgId: ACME }, live)).toBe(true);
  });

  it("refuses everyone else, and every viewer", () => {
    expect(canKick({ role: "client_editor", orgId: 99 }, live)).toBe(false);
    expect(canKick({ role: "client_viewer", orgId: LABZEN }, live)).toBe(false);
    expect(canKick({ role: "client_editor", orgId: null }, live)).toBe(false);
  });
});

describe("parkedDaysBefore", () => {
  it("counts only legs held by someone else", () => {
    const legs = [
      { toOrgId: LABZEN, at: d("2026-08-01T00:00:00Z") }, // parked 5 days
      { toOrgId: HOUSE, at: d("2026-08-06T00:00:00Z") },  // ours again
    ];
    expect(parkedDaysBefore(legs, d("2026-08-10T00:00:00Z"))).toBe(5);
  });

  it("clips an open leg at the cutoff", () => {
    const legs = [{ toOrgId: LABZEN, at: d("2026-08-01T00:00:00Z") }];
    expect(parkedDaysBefore(legs, d("2026-08-04T00:00:00Z"))).toBe(3);
  });

  it("ignores moves that happen after the cutoff", () => {
    const legs = [
      { toOrgId: LABZEN, at: d("2026-08-01T00:00:00Z") },
      { toOrgId: HOUSE, at: d("2026-08-03T00:00:00Z") },
      { toOrgId: ACME, at: d("2026-08-20T00:00:00Z") },
    ];
    expect(parkedDaysBefore(legs, d("2026-08-05T00:00:00Z"))).toBe(2);
  });

  it("sums several separate parkings and doesn't care about input order", () => {
    const legs = [
      { toOrgId: HOUSE, at: d("2026-08-04T00:00:00Z") },
      { toOrgId: LABZEN, at: d("2026-08-01T00:00:00Z") }, // 3 days
      { toOrgId: ACME, at: d("2026-08-10T00:00:00Z") },   // 2 days
      { toOrgId: HOUSE, at: d("2026-08-12T00:00:00Z") },
    ];
    expect(parkedDaysBefore(legs, d("2026-08-15T00:00:00Z"))).toBe(5);
  });

  it("is zero for a system that never left our queue", () => {
    expect(parkedDaysBefore([], d("2026-08-15T00:00:00Z"))).toBe(0);
    expect(parkedDaysBefore([{ toOrgId: HOUSE, at: d("2026-08-01T00:00:00Z") }], d("2026-08-15T00:00:00Z"))).toBe(0);
  });
});
