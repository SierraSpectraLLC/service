// What a workspace is entitled to.
//
// These rules decide whether somebody can keep working, so the ones that matter
// most are about NOT stopping people: a workspace that predates the column, a
// value nobody recognises, and a workspace somebody paid for all have to read as
// full. The expensive mistake here runs one way - billing a customer who already
// paid, or walling a shop out of their own records - so every ambiguity falls
// open rather than shut.
import { describe, expect, it } from "vitest";
import {
  addClientProblem, cleanPlan, freeAllowance, FREE_CLIENTS, FREE_CLIENTS_MAX,
  grantProblem, inviteCountProblem, invitePlanProblem, isFree, mayAddClient,
  mayInviteOffPlatform, OPEN_INVITES, planLabel, PLAN_LABEL,
} from "@/lib/plan";

describe("blank is full, and stays full", () => {
  it("reads every workspace that predates the column as full", () => {
    /*
     * The column arrives with DEFAULT '' on a table of paying customers. If
     * blank meant anything but full, the deploy that added it would have
     * downgraded all of them at once.
     */
    expect(isFree("")).toBe(false);
    expect(isFree(null)).toBe(false);
    expect(isFree(undefined)).toBe(false);
    expect(mayAddClient("", 400)).toBe(true);
    expect(mayInviteOffPlatform("")).toBe(true);
  });

  it("reads a value nobody recognises as full, not as limited", () => {
    // Same direction. A typo in a console, a half-finished migration, a plan
    // name from a future version - none of those should lock a shop out of
    // records they are working from.
    expect(cleanPlan("pro")).toBe("");
    expect(cleanPlan("FREE")).toBe("");     // exact, lowercase, or it is full
    expect(isFree("free ")).toBe(true);     // whitespace is not a decision
    expect(mayAddClient("something-else", 99)).toBe(true);
  });

  it("names both states in words somebody would say out loud", () => {
    expect(PLAN_LABEL[""]).toBe("Full");
    expect(PLAN_LABEL.free).toContain("one client");
  });
});

describe("one client, and it is the one they were handed", () => {
  it("lets the handed-over client in and stops at the next", () => {
    expect(FREE_CLIENTS).toBe(1);
    // The workspace is created empty and materialize puts the first one in.
    expect(mayAddClient("free", 0)).toBe(true);
    expect(mayAddClient("free", 1)).toBe(false);
  });

  it("holds the line if a workspace somehow got past it once", () => {
    // Not <= FREE_CLIENTS. A workspace at two clients is already over, and the
    // check must not read that as permission for a third.
    expect(mayAddClient("free", 2)).toBe(false);
  });

  it("says what is happening rather than selling", () => {
    const msg = addClientProblem("free", 1, "joe@ridgelinefield.com")!;
    expect(msg).toContain("came free with the client you were handed");
    expect(msg).toContain("joe@ridgelinefield.com");
    // No figure. A price belongs in a conversation and on an invoice, not
    // compiled into a bundle where changing it is a deploy.
    expect(msg).not.toMatch(/\$|\d+\s*\/\s*mo|month/i);
  });

  it("still reads as a sentence when nobody is named", () => {
    const msg = addClientProblem("free", 1, "")!;
    expect(msg).toContain("subscription.");
    expect(msg).not.toContain("Ask .");
  });

  it("is silent when there is nothing to say", () => {
    expect(addClientProblem("free", 0, "x@y.test")).toBeNull();
    expect(addClientProblem("", 9000, "x@y.test")).toBeNull();
  });
});

describe("room given by hand, on top of the tier", () => {
  it("leaves every workspace that was never granted anything exactly where it was", () => {
    // The column arrives DEFAULT 0 on a table of free workspaces. If zero read
    // as anything but the tier, the deploy adding it would have changed what
    // every one of them is entitled to.
    expect(freeAllowance(0)).toBe(FREE_CLIENTS);
    expect(freeAllowance(null)).toBe(FREE_CLIENTS);
    expect(freeAllowance(undefined)).toBe(FREE_CLIENTS);
    expect(mayAddClient("free", 1)).toBe(false);
  });

  it("moves the wall for the one workspace that was given more", () => {
    expect(mayAddClient("free", 1, 2)).toBe(true);   // the second client lands
    expect(mayAddClient("free", 2, 2)).toBe(false);  // the third does not
  });

  it("only ever adds - a grant under the tier is not a way to give less", () => {
    /*
     * A lever that could put a workspace BELOW what every free workspace gets
     * is one somebody eventually pulls by accident, and the shop it lands on
     * is mid-job. Under the tier reads as the tier, in both directions.
     */
    expect(freeAllowance(-4)).toBe(FREE_CLIENTS);
    expect(freeAllowance(1)).toBe(FREE_CLIENTS);
    expect(mayAddClient("free", 0, -4)).toBe(true);
  });

  it("reads a number nobody meant as the tier rather than as a lockout", () => {
    expect(freeAllowance(Number.NaN)).toBe(FREE_CLIENTS);
    expect(freeAllowance("2" as unknown as number)).toBe(2);   // a form value
    expect(freeAllowance(2.9)).toBe(2);                        // no half clients
  });

  it("stops well short of giving the product away", () => {
    expect(freeAllowance(9999)).toBe(FREE_CLIENTS_MAX);
    expect(grantProblem(FREE_CLIENTS_MAX)).toBeNull();
    expect(grantProblem(FREE_CLIENTS_MAX + 1)).toContain("subscription");
    expect(grantProblem(-1)).toContain("whole number");
    expect(grantProblem(1.5)).toContain("whole number");
    expect(grantProblem(Number.NaN)).toContain("whole number");
  });

  it("changes nothing for a workspace that is not on the free tier", () => {
    // The grant is read on the free tier alone. A full workspace with a number
    // sitting on it is still simply full.
    expect(mayAddClient("", 900, 2)).toBe(true);
    expect(planLabel("", 3)).toBe(PLAN_LABEL[""]);
  });

  it("says what a shop actually has, so nobody 'fixes' the row", () => {
    expect(planLabel("free", 0)).toBe(PLAN_LABEL.free);
    expect(planLabel("free", 2)).toBe("Free - 2 clients");
  });

  it("does not tell a shop it was handed one client when it was handed two", () => {
    const one = addClientProblem("free", 1, "joe@ridgelinefield.com")!;
    expect(one).toContain("came free with the client you were handed");
    const two = addClientProblem("free", 2, "joe@ridgelinefield.com", 2)!;
    expect(two).toContain("covers 2 clients");
    expect(two).toContain("joe@ridgelinefield.com");
    // Still no figure, for the same reason as the sentence above it.
    expect(two).not.toMatch(/\$|\d+\s*\/\s*mo|month/i);
    // And it is silent while there is still room.
    expect(addClientProblem("free", 1, "x@y.test", 2)).toBeNull();
  });
});

describe("the faucet", () => {
  it("will not let a free workspace mint another one", () => {
    /*
     * Accepting an invitation opens a workspace. A workspace that could send
     * invitations could open more of them: hand your only client on, and two
     * free workspaces stand where one did, then four. It needs no bad faith -
     * one person with a second address walks the chain by accident - and every
     * step costs a tenant and earns nothing.
     */
    expect(mayInviteOffPlatform("free")).toBe(false);
    expect(invitePlanProblem("free", "joe@ridgelinefield.com")).toContain("opens a workspace");
  });

  it("leaves the door open to companies already here", () => {
    // Sharing with an existing workspace creates none - it moves a client
    // between two that exist, and one of them is paying.
    expect(invitePlanProblem("free", "x@y.test")).toContain("already here");
  });

  it("does not fence a paying workspace out of the feature that sells the product", () => {
    expect(mayInviteOffPlatform("")).toBe(true);
    expect(invitePlanProblem("", "x@y.test")).toBeNull();
  });

  it("caps how many invitations are in flight, whoever is sending", () => {
    /*
     * Not a revenue limit. An invitation is an email this platform sends to a
     * stranger on somebody else's say-so, and a surface that sends an unbounded
     * number of those is a spam cannon with our return address on it.
     */
    expect(inviteCountProblem(OPEN_INVITES - 1)).toBeNull();
    expect(inviteCountProblem(OPEN_INVITES)).toContain("still open");
    expect(OPEN_INVITES).toBeGreaterThan(10);   // a real list must never see it
  });
});
