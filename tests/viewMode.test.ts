import { describe, expect, it } from "vitest";
import {
  VIEW_BLURB, VIEW_LABEL, VIEW_MODES, isViewPref, mayChooseView, resellerView, viewModeFor,
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
    expect(viewModeFor("", true)).toBe("reseller");
  });

  it("gives a lab's people the equipment view", () => {
    expect(viewModeFor("", false)).toBe("lab");
  });

  it("KEEPS FOLLOWING when the company changes shape", () => {
    // Somebody who never touched this must be carried along, not stranded in
    // the shape their org happened to have when the column shipped.
    expect(viewModeFor("", false)).toBe("lab");
    expect(viewModeFor("", true)).toBe("reseller");
  });

  it("treats a value nobody recognises as no choice at all", () => {
    // A stale cookie, a hand-edited row, a mode this version has dropped -
    // none of them should pin somebody to a view that does not exist.
    for (const junk of ["pipeline", "LAB", "engineer", "true", "0"]) {
      expect(viewModeFor(junk, true), junk).toBe("reseller");
      expect(viewModeFor(junk, false), junk).toBe("lab");
    }
  });
});

describe("a choice that overrides it", () => {
  it("puts a COO at a reselling company on the equipment view", () => {
    // The reported case, and the whole point.
    expect(viewModeFor("lab", true)).toBe("lab");
    expect(resellerView("lab", true)).toBe(false);
  });

  it("puts somebody at a lab on the pipeline if they ask", () => {
    expect(viewModeFor("reseller", false)).toBe("reseller");
  });

  it("is undone by choosing nothing again", () => {
    expect(viewModeFor("", true)).toBe("reseller");
  });
});

describe("who is offered the choice", () => {
  it("offers it where the company does both", () => {
    expect(mayChooseView(true)).toBe(true);
  });

  it("does not offer a pipeline to a company that has never sold anything", () => {
    // An empty second view in a menu is a feature that teaches somebody the
    // app is not for them.
    expect(mayChooseView(false)).toBe(false);
  });
});

describe("what it is called", () => {
  it("names the work, not the data model", () => {
    // "lab mode" and "reseller mode" are what the app calls its own branches.
    // A COO is picking which half of the company they work in.
    expect(VIEW_LABEL.lab).toBe("Equipment");
    expect(VIEW_LABEL.reseller).toBe("Sales pipeline");
    for (const m of VIEW_MODES) expect(VIEW_BLURB[m], m).toBeTruthy();
  });

  it("accepts exactly the modes it offers, plus blank", () => {
    expect(isViewPref("")).toBe(true);
    for (const m of VIEW_MODES) expect(isViewPref(m), m).toBe(true);
    expect(isViewPref("engineer")).toBe(false);
  });
});
