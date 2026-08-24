// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import Landing from "@/components/Landing";

/**
 * The landing page serves two audiences on purpose - a lab that needs an
 * instrument fixed, and a service company that wants the system the fixing
 * runs on. A page that blurred them would serve neither, so both doors are
 * asserted here rather than left to whoever edits the copy next.
 *
 * The contact address is the part that fails quietly: a public "talk to us"
 * button pointing at nothing looks exactly like one that works, and the only
 * person who finds out is the customer who wrote and got no answer.
 */
afterEach(cleanup);

const props = {
  brandName: "Ridgeline",
  operatorName: "Sierra Spectra",
  catalogOn: true,
  contactEmail: "hello@ridgelinefield.com",
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
    expect(screen.getByText(/Sierra Spectra/)).toBeTruthy();
    expect(screen.getByText(/Run your shop on Ridgeline/i)).toBeTruthy();
  });

  it("does not credit an operator that is just the platform under another hat", () => {
    render(<Landing {...props} operatorName="Ridgeline" />);
    expect(screen.queryByText(/, from Ridgeline/)).toBeNull();
  });
});

describe("the contact button never points at nothing", () => {
  it("mails the configured address, one subject per audience", () => {
    render(<Landing {...props} />);
    const hrefs = Array.from(document.querySelectorAll("a[href^='mailto:']"))
      .map((a) => a.getAttribute("href") ?? "");
    expect(hrefs.length).toBe(2);
    for (const h of hrefs) expect(h).toContain("hello@ridgelinefield.com");
    // Different subjects, so an enquiry arrives already sorted.
    expect(new Set(hrefs).size).toBe(2);
  });

  it("shows no button at all when no address is set", () => {
    render(<Landing {...props} contactEmail="" />);
    expect(document.querySelectorAll("a[href^='mailto:']").length).toBe(0);
    // The page still stands - the doors are the content, the button is the ask.
    expect(screen.getByText(/For laboratories/i)).toBeTruthy();
  });
});

describe("the library is the lead-gen surface", () => {
  it("links the one page a stranger can use before talking to anybody", () => {
    render(<Landing {...props} />);
    expect(document.querySelector("a[href='/equipment']")).toBeTruthy();
  });

  it("says nothing about a library that is switched off", () => {
    render(<Landing {...props} catalogOn={false} />);
    expect(document.querySelector("a[href='/equipment']")).toBeNull();
  });
});
