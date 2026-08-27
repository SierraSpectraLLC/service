// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import Landing from "@/components/Landing";
import { EMPTY_LIBRARY } from "@/lib/landingData";

/**
 * The landing page serves two audiences on purpose - a lab that needs an
 * instrument fixed, and a service company that wants the system the fixing
 * runs on. A page that blurred them would serve neither, so both doors are
 * asserted here rather than left to whoever edits the copy next.
 *
 * The contact address is the part that fails quietly: a public "talk to us"
 * button pointing at nothing looks exactly like one that works, and the only
 * person who finds out is the customer who wrote and got no answer.
 *
 * The rest of this file guards the three things the page can now get wrong
 * that it could not before: advertising a library with nothing in it, going
 * white-on-white under a pale header colour, and losing its call to action
 * when no enquiry address is configured.
 */
afterEach(cleanup);

const library = {
  models: 42,
  makers: ["Agilent", "Shimadzu", "Thermo"],
  featured: [
    { name: "6495C", manufacturer: "Agilent", assetType: "Mass spec", slug: "agilent-6495c" },
    { name: "LCMS-8060", manufacturer: "Shimadzu", assetType: "Mass spec", slug: "shimadzu-lcms-8060" },
  ],
};

const props = {
  brandName: "Ridgeline",
  operatorName: "Sierra Spectra",
  tagline: "instrument portal",
  catalogOn: true,
  contactEmail: "hello@ridgelinefield.com",
  headerColor: "#172A4A",
  library,
};

describe("both audiences get a door", () => {
  it("names the service side and the software side", () => {
    render(<Landing {...props} />);
    expect(screen.getByText(/For laboratories/i)).toBeTruthy();
    expect(screen.getByText(/For service companies/i)).toBeTruthy();
  });

  it("credits the operator for the service work, not the platform", () => {
    // The software repairs nothing. Saying who does is what keeps it honest.
    render(<Landing {...props} />);
    expect(screen.getAllByText(/Sierra Spectra/).length).toBeGreaterThan(0);
    expect(screen.getByText(/Run your shop on Ridgeline/i)).toBeTruthy();
  });

  it("does not credit an operator that is just the platform under another hat", () => {
    render(<Landing {...props} operatorName="Ridgeline" />);
    expect(screen.queryByText(/from Ridgeline/)).toBeNull();
    expect(screen.queryByText(/Operated by/)).toBeNull();
  });

  it("gives the page exactly one h1", () => {
    // This is the only page on the instance robots.ts lets anybody index.
    render(<Landing {...props} />);
    expect(document.querySelectorAll("h1").length).toBe(1);
    expect(document.querySelectorAll("h2").length).toBeGreaterThan(1);
  });
});

describe("the contact button never points at nothing", () => {
  it("mails the configured address, one subject per audience", () => {
    render(<Landing {...props} />);
    const hrefs = Array.from(document.querySelectorAll("a[href^='mailto:']"))
      .map((a) => a.getAttribute("href") ?? "");
    for (const h of hrefs) expect(h).toContain("hello@ridgelinefield.com");
    // Different subjects, so an enquiry arrives already sorted. Every mailto
    // on the page is distinct: two doors and the footer's plain "Contact".
    expect(hrefs.length).toBe(3);
    expect(new Set(hrefs).size).toBe(3);
  });

  it("keeps a call to action when no address is set", () => {
    // Blank is a supported state (lib/brand), and the page used to answer it
    // by rendering two doors with no way through either of them.
    render(<Landing {...props} contactEmail="" />);
    expect(document.querySelectorAll("a[href^='mailto:']").length).toBe(0);
    expect(screen.getByText(/For laboratories/i)).toBeTruthy();
    expect(document.querySelectorAll("a[href='/login']").length).toBeGreaterThan(0);
  });
});

describe("the library is the lead-gen surface", () => {
  it("links the one page a stranger can use before talking to anybody", () => {
    render(<Landing {...props} />);
    expect(document.querySelector("a[href='/equipment']")).toBeTruthy();
  });

  it("links each featured model's own page", () => {
    // The apex is the highest-authority page on the site, so these chips are
    // the way in for pages that would otherwise only be reachable from
    // /equipment. See the internal-linking note on the equipment index.
    render(<Landing {...props} />);
    expect(document.querySelector("a[href='/equipment/agilent-6495c']")).toBeTruthy();
    expect(document.querySelector("a[href='/equipment/shimadzu-lcms-8060']")).toBeTruthy();
  });

  it("says nothing about a library that is switched off", () => {
    render(<Landing {...props} catalogOn={false} />);
    expect(document.querySelector("a[href='/equipment']")).toBeNull();
  });

  it("says nothing about a library with nothing published in it", () => {
    // The module can be on before anybody has published a model, and an apex
    // that sends a stranger to an empty index has spent the one click it had.
    render(<Landing {...props} library={EMPTY_LIBRARY} />);
    expect(document.querySelector("a[href='/equipment']")).toBeNull();
    expect(screen.queryByText(/Models documented/i)).toBeNull();
    // The doors are the content; the exhibit is the evidence.
    expect(screen.getByText(/For laboratories/i)).toBeTruthy();
  });

  it("counts only what it can prove", () => {
    render(<Landing {...props} />);
    expect(screen.getByText("42")).toBeTruthy();
    expect(screen.getByText("3")).toBeTruthy();
  });
});

describe("the hero survives the instance's own colours", () => {
  // jsdom normalises any colour it is handed to "rgb(r, g, b)".
  const heroFg = () =>
    ((document.querySelector(".lp-hero") as HTMLElement | null)?.style.color ?? "")
      .replace(/\s/g, "");

  it("goes white on a dark header colour", () => {
    render(<Landing {...props} headerColor="#172A4A" />);
    expect(heroFg()).toBe("rgb(255,255,255)");
  });

  it("goes navy on a pale one, rather than white on white", () => {
    // An operator may paint the header any hex. A hero that assumed navy was
    // unreadable for every one of them who picked something light.
    render(<Landing {...props} headerColor="#F2E9C8" />);
    expect(heroFg()).toBe("rgb(23,42,74)");
  });
});

/**
 * The page's styling is one block of globals.css, and once already it was
 * lost whole.
 *
 * A branch that forked before the landing page landed rewrote globals.css for
 * its own reasons; the merge took that side, and all 277 lines of `.lp` went
 * with it. Every test in this file still passed - they assert markup, and the
 * markup was untouched - so the front door shipped as unstyled HTML: buttons
 * rendered as bare underlined links running into each other, the hero and the
 * exhibit as a wall of left-aligned text. Nothing anywhere said the classes
 * this component names have to exist.
 *
 * This does. It is a cheap check for a whole category of silent breakage: not
 * "does the CSS look right", which no unit test can answer, but "is it there
 * at all", which is the way it actually failed.
 */
describe("the styles the page names actually exist", () => {
  const COMPONENT = readFileSync("src/components/Landing.tsx", "utf8");
  const CSS = readFileSync("src/app/globals.css", "utf8");

  it("defines every lp-* class the component uses", () => {
    // Comments in the component quote class names as prose; strip them so a
    // reference in a note is not mistaken for one in the markup.
    const markup = COMPONENT.replace(/\/\*[\s\S]*?\*\//g, "");
    const used = [...new Set([...markup.matchAll(/\blp-[a-z0-9-]+/g)].map((m) => m[0]))].sort();
    // If this ever reaches zero the component stopped using the block, and
    // the check below is passing for the wrong reason.
    expect(used.length).toBeGreaterThan(15);
    const missing = used.filter((c) => !new RegExp(`\\.${c}[\\s,{:.>]`).test(CSS));
    expect(missing, `classes used by Landing.tsx with no rule in globals.css: ${missing.join(", ")}`)
      .toEqual([]);
  });

  it("still declares the scale the block is built on", () => {
    // The root element is `.lp` itself, which carries every --lp-* token the
    // rest of the block reads. Losing just this rule would leave every class
    // defined and every size resolving to nothing.
    expect(CSS).toMatch(/\.lp \{/);
    for (const token of ["--lp-h1", "--lp-h2", "--lp-lead", "--lp-body", "--lp-meta"]) {
      expect(CSS, `${token} is not declared`).toContain(`${token}:`);
    }
  });
});
