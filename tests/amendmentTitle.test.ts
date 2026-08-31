// What an amendment is called. Pure, no database.
//
// The name is the whole reason an amendment reads as one: it carries the
// trip's own name, so a shop scanning the desk sees two rows that are
// obviously the same trip rather than "Reno install" and whatever somebody
// typed the second time.
import { describe, expect, it } from "vitest";
import { REPORT_TITLE_MAX, amendmentTitle, settledReport } from "@/lib/expenseReports";

describe("amendmentTitle", () => {
  it("keeps the trip's name and says what it is", () => {
    expect(amendmentTitle("Reno install, week of the 12th"))
      .toBe("Reno install, week of the 12th - amendment");
  });

  it("numbers the next one instead of stacking the word", () => {
    // "Reno install - amendment - amendment" is the shape this exists to
    // avoid: three corrections in and the name is longer than the trip.
    const one = amendmentTitle("Reno install");
    const two = amendmentTitle(one);
    const three = amendmentTitle(two);
    expect(two).toBe("Reno install - amendment 2");
    expect(three).toBe("Reno install - amendment 3");
  });

  it("reads an en dash the same as a hyphen", () => {
    // Somebody's phone will autocorrect one into the other, and a name that
    // fails to parse gets "- amendment" glued onto "- amendment".
    expect(amendmentTitle("Reno install – amendment")).toBe("Reno install - amendment 2");
  });

  it("does not mistake a trip that is merely about an amendment", () => {
    // The suffix has to be at the END and in the shape this writes it. A
    // contract amendment trip is a trip, not a second pass at a claim.
    expect(amendmentTitle("Contract amendment meeting"))
      .toBe("Contract amendment meeting - amendment");
  });

  it("trims the trip, never the word that says what it is", () => {
    /*
     * A title cut blind at the cap loses its tail, and the tail is the only
     * part that says this is a correction - so the base is trimmed to make
     * room BEFORE the suffix goes on.
     */
    const long = "R".repeat(REPORT_TITLE_MAX);
    const out = amendmentTitle(long);
    expect(out.length).toBeLessThanOrEqual(REPORT_TITLE_MAX);
    expect(out.endsWith(" - amendment")).toBe(true);
  });

  it("still names something when the original named nothing", () => {
    expect(amendmentTitle("")).toBe("Amendment");
    expect(amendmentTitle("   ")).toBe("Amendment");
  });
});

describe("settledReport", () => {
  it("is the two statuses whose rows are fixed", () => {
    expect([settledReport("submitted"), settledReport("paid")]).toEqual([true, true]);
    expect([settledReport("draft"), settledReport("returned")]).toEqual([false, false]);
  });
});
