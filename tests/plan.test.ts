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
  addClientProblem, cleanPlan, FREE_CLIENTS, inviteCountProblem, invitePlanProblem,
  isFree, mayAddClient, mayInviteOffPlatform, OPEN_INVITES, PLAN_LABEL,
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
