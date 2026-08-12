import { describe, expect, it } from "vitest";
import { pmHandoff, type HandoffContext } from "@/lib/pmQueue";

/**
 * This decision fires from a cron with nobody watching, on systems that belong to
 * clients. The two failures that matter are opposite: leaving a due instrument
 * showing as the client's problem, which is how a contract quietly lapses, and
 * moving a client's instrument into the wrong provider's queue.
 */
const ctx = (over: Partial<HandoffContext> = {}): HandoffContext => ({
  queueOrgId: 7,            // the client holds it while it works
  operatorOrgId: 1,         // the organization our engineers sign in as
  shares: [{ orgId: 7, kind: "client" }, { orgId: 1, kind: "provider" }],
  archived: false,
  ...over,
});

describe("handing a due system to whoever services it", () => {
  it("moves it from the client's queue to the operator's", () => {
    expect(pmHandoff(ctx())).toEqual({ move: true, toOrgId: 1, why: "maintenance is due" });
  });

  it("prefers the operator's own organization over another provider", () => {
    // Our engineers sign in as that org, so a system parked there lands on their
    // dashboard rather than on the platform owner's.
    const d = pmHandoff(ctx({
      shares: [{ orgId: 7, kind: "client" }, { orgId: 1, kind: "provider" }, { orgId: 9, kind: "provider" }],
    }));
    expect(d).toEqual({ move: true, toOrgId: 1, why: "maintenance is due" });
  });

  it("uses the only provider when the operator has no organization of its own", () => {
    const d = pmHandoff(ctx({ operatorOrgId: null, shares: [{ orgId: 9, kind: "provider" }] }));
    expect(d).toEqual({ move: true, toOrgId: 9, why: "maintenance is due" });
  });
});

describe("when it should stay where it is", () => {
  it("leaves a system already in our queue alone", () => {
    expect(pmHandoff(ctx({ queueOrgId: null }))).toEqual({ move: false, why: "already in our queue" });
  });

  it("leaves a system already with a provider alone", () => {
    expect(pmHandoff(ctx({ queueOrgId: 1 }))).toEqual({ move: false, why: "already with a provider" });
  });

  it("refuses to choose between two providers", () => {
    // Guessing would put a client's instrument in a competitor's queue. The task
    // still exists and still reads as overdue; only the queue stays put.
    const d = pmHandoff(ctx({
      operatorOrgId: null,
      shares: [{ orgId: 8, kind: "provider" }, { orgId: 9, kind: "provider" }],
    }));
    expect(d).toEqual({ move: false, why: "more than one provider has access" });
  });

  it("does nothing when nobody who could service it has access", () => {
    const d = pmHandoff(ctx({ shares: [{ orgId: 7, kind: "client" }] }));
    expect(d).toEqual({ move: false, why: "no provider has access" });
  });

  it("never touches an archived system", () => {
    expect(pmHandoff(ctx({ archived: true }))).toEqual({ move: false, why: "the system is archived" });
  });
});
