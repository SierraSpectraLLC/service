// Handing a client to a shop that is not on Ridgeline yet.
//
// The pure half: how long a door stays open, whether it has been walked
// through, and what a stranger may be told before they commit to anything.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  companyProblems, daysLeft, inviteOpen, inviteState, looksLikeToken,
  pitchLine, HANDOFF_DAYS,
} from "@/lib/handoff";

const row = (over: Partial<{ status: string; openedAt: Date | null; expiresOn: string }> = {}) => ({
  status: "pending", openedAt: null as Date | null, expiresOn: "2026-09-27", ...over,
});

describe("where an invitation stands", () => {
  it("tells sent from read, which is what decides whether to telephone", () => {
    expect(inviteState(row(), "2026-08-28")).toBe("sent");
    expect(inviteState(row({ openedAt: new Date() }), "2026-08-28")).toBe("opened");
  });

  it("closes on the day after it expires, not on the day", () => {
    expect(inviteState(row(), "2026-09-27")).toBe("sent");
    expect(inviteState(row(), "2026-09-28")).toBe("expired");
  });

  it("lets a settled invitation keep saying what it settled as", () => {
    /* Expiry is about a door still standing open. An invitation accepted in
       March still reads "Joined" in December - the alternative tells somebody
       their own conversion expired. */
    const old = { expiresOn: "2026-01-01" };
    expect(inviteState(row({ ...old, status: "accepted" }), "2026-08-28")).toBe("accepted");
    expect(inviteState(row({ ...old, status: "declined" }), "2026-08-28")).toBe("declined");
    expect(inviteState(row({ ...old, status: "withdrawn" }), "2026-08-28")).toBe("withdrawn");
  });

  it("never expires one with no date on it", () => {
    // Rows from before the column existed are open, not dead.
    expect(inviteState(row({ expiresOn: "" }), "2030-01-01")).toBe("sent");
  });

  it("knows which ones may still be walked through", () => {
    expect(inviteOpen("sent")).toBe(true);
    expect(inviteOpen("opened")).toBe(true);
    for (const s of ["accepted", "declined", "withdrawn", "expired"] as const) {
      expect(inviteOpen(s), s).toBe(false);
    }
  });
});

describe("the clock on the page", () => {
  it("counts whole days and stops at zero", () => {
    expect(daysLeft("2026-09-07", "2026-08-28")).toBe(10);
    expect(daysLeft("2026-08-28", "2026-08-28")).toBe(0);
    expect(daysLeft("2026-08-01", "2026-08-28")).toBe(0);
  });

  it("says nothing rather than guessing", () => {
    expect(daysLeft("", "2026-08-28")).toBeNull();
    expect(daysLeft("soon", "2026-08-28")).toBeNull();
  });

  it("gives a month, which is long enough to think and short enough to matter", () => {
    expect(HANDOFF_DAYS).toBe(30);
  });
});

describe("the one field the accept form asks for", () => {
  it("takes a company name and nothing else", () => {
    expect(companyProblems("Northwest Instrument Services")).toEqual([]);
  });

  it("refuses a blank and refuses a essay", () => {
    expect(companyProblems("   ")[0]).toContain("called");
    expect(companyProblems("x".repeat(61))[0]).toContain("60");
  });
});

describe("the token is the authorization, so it has to be a token", () => {
  it("refuses anything short or shaped wrong before any lookup happens", () => {
    expect(looksLikeToken("abc")).toBe(false);
    expect(looksLikeToken("")).toBe(false);
    // A path traversal, a wildcard and a quote all fail the shape test.
    expect(looksLikeToken("../../etc/passwd-aaaaaaaaaaaaa")).toBe(false);
    expect(looksLikeToken("%' OR 1=1 --aaaaaaaaaaaaaaaaaaa")).toBe(false);
  });

  it("accepts what crypto.randomBytes(18).toString('base64url') makes", () => {
    // 18 bytes is 24 base64url characters, which is the floor.
    expect(looksLikeToken("Zm9vYmFyYmF6cXV1eHF1dXg")).toBe(false);   // 23
    expect(looksLikeToken("Zm9vYmFyYmF6cXV1eHF1dXhf")).toBe(true);   // 24
    expect(looksLikeToken("a-b_c".repeat(6))).toBe(true);
  });
});

describe("what the page leads with", () => {
  it("says the work and the sender, never the client - and keeps the state's case", () => {
    const line = pitchLine("12 systems across 2 sites in CA", "Sierra Spectra");
    expect(line).toBe("Sierra Spectra wants to hand you 12 systems across 2 sites in CA");
    expect(line).not.toContain("Emery");
  });
});

describe("the page an accepted invitation renders", () => {
  it("is a success page, because the person reading it is the one who accepted", () => {
    /*
     * Found by driving it. Accepting revalidates, the server component re-runs,
     * and by then the invitation is accepted - so the screen that REPLACES the
     * form is the accepted one. It used to say "somebody has taken this one
     * on", which told the person who had just converted that they had failed,
     * at the one moment in the funnel where that costs everything.
     *
     * Safe because there is no second audience: the only reader of an
     * unguessable token is the shop it was sent to.
     */
    const src = readFileSync("src/app/handoff/[token]/page.tsx", "utf8");
    expect(src).toMatch(/state === "accepted"/);
    expect(src).not.toMatch(/Somebody has taken this one on/);
    // And the closed branch no longer has to speak for acceptance.
    expect(src).toMatch(/This offer has closed/);
  });
});
