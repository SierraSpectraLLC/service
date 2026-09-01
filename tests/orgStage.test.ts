// Where we stand with a company: client, prospect, former client.
//
// The first two came from one report - "I sent a quote to Federon, but now
// they're stored in my client list with their equipment" - and were a boolean.
// The third came from the next one:
//
//   "I also want a 'former client' option. That way I can remove their systems
//    from the active queue like a prospect, update any information I receive
//    about their system and keep provenance records / ship those records to
//    other orgs."
//
// A boolean cannot hold three values, and the third is not the negation of
// either existing one. What this file pins is the vocabulary itself: that
// unknown reads as client, that both non-client stages are held back for the
// same reason, and that the SQL list and the predicate cannot drift apart -
// which they did once already, and which is the failure that takes a working
// machine off a shop's board on a deploy.
import { describe, expect, it } from "vitest";
import {
  HELD_STAGES, ORG_STAGES, STAGE_TONE, STAGE_WORD,
  heldOutOfFleet, isOrgStage, stageHint, stageOf,
} from "@/lib/orgStage";

describe("reading the column", () => {
  it("knows the three", () => {
    expect(ORG_STAGES).toEqual(["client", "prospect", "former"]);
    for (const s of ORG_STAGES) expect(stageOf(s)).toBe(s);
  });

  it("reads anything else as a client", () => {
    /*
     * Every row that existed before the column did, plus a stage written by a
     * newer deploy than the one reading it. The direction matters: falling
     * back to "client" puts a machine on the board, and falling back the other
     * way makes one disappear with nothing throwing.
     */
    expect(stageOf("")).toBe("client");
    expect(stageOf(null)).toBe("client");
    expect(stageOf(undefined)).toBe("client");
    expect(stageOf("lapsed")).toBe("client");
    expect(stageOf(7)).toBe("client");
  });

  it("validates strictly at the door, even though it reads loosely", () => {
    // A server action takes whatever the wire hands it, and a stage nobody
    // defined would read as "client" everywhere downstream - so writing one
    // has to be refused rather than quietly accepted and then ignored.
    expect(isOrgStage("former")).toBe(true);
    expect(isOrgStage("lapsed")).toBe(false);
    expect(isOrgStage("")).toBe(false);
  });
});

describe("the one rule the stages share", () => {
  it("holds a prospect and a former client back, and nobody else", () => {
    expect(heldOutOfFleet("client")).toBe(false);
    expect(heldOutOfFleet("prospect")).toBe(true);
    expect(heldOutOfFleet("former")).toBe(true);
  });

  it("does not hold back a row nobody has set", () => {
    expect(heldOutOfFleet("")).toBe(false);
    expect(heldOutOfFleet(null)).toBe(false);
  });

  it("keeps the SQL list and the predicate agreeing", () => {
    /*
     * THE ONE THAT ALREADY BIT. fleetHold asked the database `stage <>
     * 'client'` while heldOutOfFleet asked stageOf() - and those two disagree
     * about an empty string, so a blank column would have taken a machine off
     * the board while every UI on top of it still called the company a client.
     * Deriving the list from the predicate is what makes that unrepresentable.
     */
    for (const s of ORG_STAGES) {
      expect(`${s}: ${HELD_STAGES.includes(s)}`).toBe(`${s}: ${heldOutOfFleet(s)}`);
    }
  });
});

describe("the words a person reads", () => {
  it("says former client, not former", () => {
    // "former" is the column. Nobody says it out loud.
    expect(STAGE_WORD.former).toBe("former client");
  });

  it("gives every stage a word and a tone", () => {
    for (const s of ORG_STAGES) {
      expect(STAGE_WORD[s]).toBeTruthy();
      expect(STAGE_TONE[s]).toBeTruthy();
    }
  });

  it("colours a former client neutral rather than bad", () => {
    // A company that stopped buying is a fact about the past, not a fault.
    // Red here would be the roster editorializing about the shop's business.
    expect(STAGE_TONE.former).toBe("neutral");
    expect(STAGE_TONE.prospect).toBe("warn");
  });
});

describe("what the org page says about the consequence", () => {
  it("names the company and counts their systems", () => {
    expect(stageHint("prospect", "Federon", 4)).toContain("Federon");
    expect(stageHint("prospect", "Federon", 1)).toContain("system is");
    expect(stageHint("prospect", "Federon", 4)).toContain("systems are");
  });

  it("tells a former client's reader that nothing was lost", () => {
    /*
     * The half of this feature that is not about hiding anything. A shop that
     * suspects marking a dead account will lose the history leaves it in the
     * fleet instead, which is the state the option exists to end - so the
     * sentence beside the button has to say the history survives.
     */
    const hint = stageHint("former", "Bayline", 3);
    expect(hint).toMatch(/still on file/);
    expect(hint).toMatch(/service history/);
    expect(hint).toMatch(/off the board/);
  });

  it("says nothing alarming about a client", () => {
    expect(stageHint("client", "Puget", 2)).toContain("in the working fleet");
  });
});
