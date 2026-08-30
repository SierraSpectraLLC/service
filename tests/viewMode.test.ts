import { describe, expect, it } from "vitest";
import {
  VIEW_BLURB, VIEW_LABEL, VIEW_MODES, availableViews, isViewPref, mayChooseView,
  resellerView, viewAllowed, viewModeFor,
} from "@/lib/viewMode";

/**
 * Which half of the app a person gets.
 *
 * The app chose between its two client shapes by asking the ORGANIZATION - one
 * flag, everybody inside got the same answer - which is wrong for the person a
 * reselling company puts in charge of the equipment. They opened a pipeline of
 * stock when what they came for was whether the instruments were running.
 *
 * The trap here is the default. Blank has to keep meaning "whatever my company
 * is", forever: read it as a choice and everybody who never touched this gets
 * frozen into whatever shape their org had on the day the column shipped.
 */

describe("following the company by default", () => {
  it("gives a reselling company's people the pipeline", () => {
    expect(viewModeFor("", "", true)).toBe("reseller");
  });

  it("gives a lab's people the equipment view", () => {
    expect(viewModeFor("", "", false)).toBe("lab");
  });

  it("KEEPS FOLLOWING when the company changes shape", () => {
    // Somebody who never touched this must be carried along, not stranded in
    // the shape their org happened to have when the column shipped.
    expect(viewModeFor("", "", false)).toBe("lab");
    expect(viewModeFor("", "", true)).toBe("reseller");
  });

  it("treats a value nobody recognises as no choice at all", () => {
    // A stale cookie, a hand-edited row, a mode this version has dropped -
    // none of them should pin somebody to a view that does not exist.
    for (const junk of ["pipeline", "LAB", "engineer", "true", "0"]) {
      expect(viewModeFor(junk, "", true), junk).toBe("reseller");
      expect(viewModeFor(junk, "", false), junk).toBe("lab");
    }
  });
});

describe("a choice that overrides it", () => {
  it("puts a COO at a reselling company on the equipment view", () => {
    // The reported case, and the whole point.
    expect(viewModeFor("lab", "", true)).toBe("lab");
    expect(resellerView("lab", "", true)).toBe(false);
  });

  it("does NOT put somebody at a lab on the pipeline, even if they ask", () => {
    /* This test used to assert the opposite, and the opposite was wrong: a
       company that does not sell has no pipeline, and showing it an empty one
       is the app telling a lab it is something it is not. The choice is
       between the views the company HAS - see availableViews. */
    expect(viewModeFor("reseller", "", false)).toBe("lab");
  });

  it("is undone by choosing nothing again", () => {
    expect(viewModeFor("", "", true)).toBe("reseller");
  });
});

describe("who is offered the choice", () => {
  it("offers it to everybody, now that the board is universal", () => {
    // Every organization has at least the card landing and the board, so
    // there is always a real choice to teach.
    expect(mayChooseView(true)).toBe(true);
    expect(mayChooseView(false)).toBe(true);
  });
});

describe("what it is called", () => {
  it("names the work, not the data model", () => {
    // "lab mode" and "reseller mode" are what the app calls its own branches.
    // A COO is picking which half of the company they work in.
    expect(VIEW_LABEL.lab).toBe("Equipment");
    expect(VIEW_LABEL.board).toBe("The board");
    expect(VIEW_LABEL.reseller).toBe("Sales pipeline");
    for (const m of VIEW_MODES) expect(VIEW_BLURB[m], m).toBeTruthy();
  });

  it("accepts exactly the modes it offers, plus blank", () => {
    expect(isViewPref("")).toBe(true);
    for (const m of VIEW_MODES) expect(isViewPref(m), m).toBe(true);
    expect(isViewPref("engineer")).toBe(false);
  });
});

describe("a starting view the operator set", () => {
  it("STARTS A COO ON EQUIPMENT AT A RESELLING COMPANY", () => {
    // The point of it existing: he should not have to find a menu on his first
    // morning to stop being shown a pipeline of stock.
    expect(viewModeFor("", "lab", true)).toBe("lab");
  });

  it("loses to what the person chose for themselves", () => {
    // A starting point is a starting point. Once he has decided, an operator
    // changing his start view must not move him.
    expect(viewModeFor("reseller", "lab", true)).toBe("reseller");
    expect(viewModeFor("lab", "reseller", true)).toBe("lab");
  });

  it("beats the company's own default", () => {
    expect(viewModeFor("", "reseller", true)).toBe("reseller");
    expect(viewModeFor("", "lab", true)).toBe("lab");
  });

  it("is ignored when it is not a view at all", () => {
    expect(viewModeFor("", "engineer", true)).toBe("reseller");
  });
});

describe("a standard client can never land on a reseller screen", () => {
  it("has no pipeline to give", () => {
    expect(availableViews(false)).toEqual(["lab", "board"]);
    expect(availableViews(true)).toEqual(["lab", "board", "reseller"]);
    expect(viewAllowed("reseller", false)).toBe(false);
    expect(viewAllowed("lab", false)).toBe(true);
  });

  it("CLAMPS A CHOICE MADE BEFORE THE COMPANY STOPPED RESELLING", () => {
    // The write paths refuse it, but the org flag can change underneath a
    // choice that was legitimate when it was made. Clamping at read time is
    // what makes the guarantee hold without either write path being revisited.
    expect(viewModeFor("reseller", "", false)).toBe("lab");
  });

  it("clamps a starting view set before the company stopped reselling", () => {
    expect(viewModeFor("", "reseller", false)).toBe("lab");
  });

  it("clamps both at once", () => {
    expect(viewModeFor("reseller", "reseller", false)).toBe("lab");
    expect(resellerView("reseller", "reseller", false)).toBe(false);
  });

  it("still offers a lab the board", () => {
    // The clamp is about the view the company lacks, never about choice
    // itself: the board is the same scoped rows on a denser table, and every
    // company has it.
    expect(mayChooseView(false)).toBe(true);
    expect(viewAllowed("board", false)).toBe(true);
  });
});

describe("the board, for anybody", () => {
  it("is a choice at a lab and at a reseller alike", () => {
    expect(viewModeFor("board", "", false)).toBe("board");
    expect(viewModeFor("board", "", true)).toBe("board");
  });

  it("can be where the operator starts somebody", () => {
    // The point of the feature: a client who should open on the operator's
    // own table does, before they ever find a menu.
    expect(viewModeFor("", "board", false)).toBe("board");
    expect(viewModeFor("", "board", true)).toBe("board");
  });

  it("is NEVER a default", () => {
    // A company is a lab or a reseller; the board is a way of reading either.
    // Nobody lands on it without somebody - themselves or their operator -
    // having chosen it.
    expect(viewModeFor("", "", false)).toBe("lab");
    expect(viewModeFor("", "", true)).toBe("reseller");
  });

  it("loses to the person's own choice like any starting view", () => {
    expect(viewModeFor("lab", "board", false)).toBe("lab");
    expect(viewModeFor("board", "lab", false)).toBe("board");
  });

  it("does not read as a reseller anywhere", () => {
    // The nav asks resellerView to pick its shape; a client on the board
    // still gets the equipment nav, not the pipeline's.
    expect(resellerView("board", "", true)).toBe(false);
  });
});
