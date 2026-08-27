// What a document is called.
//
// The one thing in a billing system a client quotes back at you a year later,
// so the rules get held down hard. Two failures matter more than the rest and
// both have a block below: a number that repeats (two invoices called the same
// thing is an argument nobody wins), and a job counter that leaks between jobs
// (every job's first invoice must be 1, not "wherever the workspace got to").
import { describe, expect, it } from "vitest";
import {
  DEFAULT_SCHEME, alphaOf, alphaValue, jobOf, jobScoped, matcher, nextJob,
  nextNumber, nextRevision, parse, parseScheme, preview, render, serializeScheme,
  templateProblems, type Scheme,
} from "@/lib/docNumber";

/** The scheme this feature was built for, as the worked example throughout. */
const SIERRA: Scheme = {
  templates: {
    work_order: "{job:6}",
    quote: "Q{job:6}_{alpha}",
    invoice: "{job:6}_INV{seq}",
    purchase_order: "{job:6}_PO{seq}",
  },
  jobStart: 30120,
};

describe("filling a template in", () => {
  it("pads to the width the token asks for", () => {
    // 30120 is written 030120. The padding is why.
    expect(render("{job:6}_INV{seq}", { job: 30120, seq: 1 })).toBe("030120_INV1");
    expect(render("PO-{seq}", { seq: 1042 })).toBe("PO-1042");
    expect(render("{job:6}", { job: 212 })).toBe("000212");
  });

  it("counts in letters where a shop counts in letters", () => {
    expect(render("Q{job:6}_{alpha}", { job: 30120, seq: 1 })).toBe("Q030120_A");
    expect(render("Q{job:6}_{alpha}", { job: 30120, seq: 2 })).toBe("Q030120_B");
  });

  it("runs past Z rather than starting again", () => {
    expect(alphaOf(26)).toBe("Z");
    expect(alphaOf(27)).toBe("AA");
    expect(alphaOf(52)).toBe("AZ");
    expect(alphaOf(0)).toBe("");
    for (const n of [1, 2, 26, 27, 100, 703]) expect(alphaValue(alphaOf(n))).toBe(n);
  });
});

describe("reading a number back apart", () => {
  it("uses the template rather than guessing at trailing digits", () => {
    /*
     * The bug the old rule had. nextWoNumber took "the digits at the end" off
     * whatever it found - on 030120_INV1 that is the 1, so the next invoice
     * for a DIFFERENT job came out 030120_INV2 and the job thread was lost.
     */
    expect(parse("{job:6}_INV{seq}", "030120_INV1")).toEqual({ job: 30120, seq: 1 });
    expect(parse("{job:6}_INV{seq}", "030212_INV7")).toEqual({ job: 30212, seq: 7 });
    expect(parse("Q{job:6}_{alpha}", "Q030120_B")).toEqual({ job: 30120, seq: 2 });
    expect(parse("PO-{seq}", "PO-1042")).toEqual({ job: null, seq: 1042 });
  });

  it("refuses a number that is not this shape at all", () => {
    expect(parse("{job:6}_INV{seq}", "INV-1043")).toBeNull();
    expect(parse("PO-{seq}", "030120_PO1")).toBeNull();
    // Anchored at both ends: a number that merely CONTAINS the shape is not it.
    expect(parse("PO-{seq}", "X-PO-1042")).toBeNull();
    expect(parse("PO-{seq}", "PO-1042-B")).toBeNull();
  });

  it("escapes the literal parts, so a dot is a dot", () => {
    expect(matcher("A.B{seq}").test("AXB1")).toBe(false);
    expect(matcher("A.B{seq}").test("A.B1")).toBe(true);
  });
});

describe("the next number", () => {
  it("carries on the workspace counter when there is no job thread", () => {
    expect(nextNumber("PO-{seq}", ["PO-1041", "PO-1042"])).toBe("PO-1043");
    expect(nextNumber("PO-{seq}", [])).toBe("PO-1");
  });

  it("starts every job again at one", () => {
    /*
     * The property that makes a job number a thread rather than a decoration.
     * Job 030212's first invoice is INV1 even though the workspace has issued
     * seven invoices on job 030120.
     */
    const used = ["030120_INV1", "030120_INV2", "030120_INV3"];
    expect(nextNumber(SIERRA.templates.invoice, used, { job: 30120 })).toBe("030120_INV4");
    expect(nextNumber(SIERRA.templates.invoice, used, { job: 30212 })).toBe("030212_INV1");
  });

  it("lettered quotes count within the job too", () => {
    expect(nextNumber(SIERRA.templates.quote, ["Q030120_A"], { job: 30120 })).toBe("Q030120_B");
    expect(nextNumber(SIERRA.templates.quote, ["Q030120_A", "Q030120_B"], { job: 30212 })).toBe("Q030212_A");
  });

  it("ignores numbers from another scheme rather than guessing at them", () => {
    // A workspace that changed its shape, or a number typed in during a
    // migration. Neither should drag the new counter somewhere odd.
    expect(nextNumber("PO-{seq}", ["PO-1041", "030120_PO9", "nonsense"])).toBe("PO-1042");
  });

  it("returns nothing rather than a half-rendered number", () => {
    // A job-scoped template with no job would otherwise put a literal {job}
    // on an invoice. The caller allocates a job first.
    expect(nextNumber(SIERRA.templates.invoice, [])).toBe("");
  });

  it("never repeats a number already in use", () => {
    // The property that matters most, checked by walking a workspace forward.
    const used: string[] = [];
    for (let i = 0; i < 40; i++) {
      const n = nextNumber("INV-{seq}", used);
      expect(used).not.toContain(n);
      used.push(n);
    }
  });
});

describe("the job thread", () => {
  it("takes the next job from the documents, not from a counter", () => {
    /*
     * A stored counter is one more thing to be wrong after a restore, a manual
     * insert, or a number typed by hand. The documents are the record: if
     * 030212 exists then 030212 is taken, whatever any counter believes.
     */
    expect(nextJob(SIERRA, { invoice: ["030212_INV1"], work_order: ["030190"] })).toBe(30213);
    expect(nextJob(SIERRA, {})).toBe(30120);
  });

  it("has no job to allocate on a scheme without one", () => {
    // Nothing is job-scoped, so the whole idea is absent - and jobStart is not
    // silently applied to a workspace that does not work that way.
    expect(jobScoped(DEFAULT_SCHEME.templates.invoice)).toBe(false);
    expect(nextJob(DEFAULT_SCHEME, { invoice: ["INV-1042"] })).toBe(DEFAULT_SCHEME.jobStart);
  });

  it("reads a document's job off its own number", () => {
    // How an invoice inherits its job's thread with nothing storing it twice.
    expect(jobOf(SIERRA, "work_order", "030212")).toBe(30212);
    expect(jobOf(SIERRA, "quote", "Q030120_A")).toBe(30120);
    expect(jobOf(DEFAULT_SCHEME, "invoice", "INV-1043")).toBeNull();
    expect(jobOf(SIERRA, "invoice", "typed by hand")).toBeNull();
  });
});

describe("revisions", () => {
  it("keeps the number and wears a suffix", () => {
    // A revision is the same offer argued again, not a new document.
    expect(nextRevision("Q030120_A")).toBe("Q030120_Ar1");
    expect(nextRevision("Q030120_Ar1")).toBe("Q030120_Ar2");
  });

  it("bumps rather than stacks", () => {
    expect(nextRevision("Q030120_A", ["Q030120_Ar1", "Q030120_Ar2"])).toBe("Q030120_Ar3");
    expect(nextRevision("Q030120_Ar1")).not.toContain("r1r");
  });
});

describe("a template that cannot work says so", () => {
  it("insists on a counter", () => {
    // Without one every document of that kind is called the same thing.
    expect(templateProblems("PO-")).toContain("Needs {seq} or {alpha} so each one is different");
    expect(templateProblems("INV-")).toContain("Needs {seq} or {alpha} so each one is different");
  });

  it("accepts a bare {job}, which names one document per job", () => {
    // What a work order is in a job-numbered shop: the job IS the work order,
    // and a second one means a second job. The job counter is the uniqueness.
    expect(templateProblems("{job:6}")).toEqual([]);
    expect(templateProblems("{job:6}_INV")).toEqual([]);
  });

  it("refuses two counters, an unknown token, or a space", () => {
    expect(templateProblems("{seq}-{alpha}").length).toBeGreaterThan(0);
    expect(templateProblems("PO {seq}")).toContain("No spaces - a number gets pasted into emails and file names");
    expect(templateProblems("{nope}{seq}").some((p) => p.includes("Unknown token"))).toBe(true);
  });

  it("passes the two real shapes", () => {
    for (const t of Object.values(SIERRA.templates)) expect(templateProblems(t)).toEqual([]);
    for (const t of Object.values(DEFAULT_SCHEME.templates)) expect(templateProblems(t)).toEqual([]);
  });
});

describe("the preview an editor shows", () => {
  it("shows a job rolling over, so the thread is visible", () => {
    expect(preview(SIERRA, "invoice")).toEqual(["030120_INV1", "030120_INV2", "030121_INV1"]);
    expect(preview(SIERRA, "quote")).toEqual(["Q030120_A", "Q030120_B", "Q030121_A"]);
  });

  it("shows a plain counter running on", () => {
    expect(preview(DEFAULT_SCHEME, "purchase_order")).toEqual(["PO-1001", "PO-1002", "PO-1003"]);
  });

  it("shows nothing for a template that would not work", () => {
    expect(preview({ ...DEFAULT_SCHEME, templates: { ...DEFAULT_SCHEME.templates, invoice: "INV-" } }, "invoice"))
      .toEqual([]);
  });
});

describe("what the column holds", () => {
  it("round-trips a real scheme", () => {
    expect(parseScheme(serializeScheme(SIERRA))).toEqual(SIERRA);
  });

  it("stores blank for the stock shape, so a default can move later", () => {
    expect(serializeScheme(DEFAULT_SCHEME)).toBe("");
    expect(parseScheme("")).toEqual(DEFAULT_SCHEME);
  });

  it("keeps numbering documents when the stored scheme has gone bad", () => {
    /*
     * These names go on paper a client keeps. A workspace whose column holds
     * rubbish must still be able to name an invoice - falling back field by
     * field means one broken template costs one template, not the whole shape.
     */
    expect(parseScheme("not json")).toEqual(DEFAULT_SCHEME);
    const partial = parseScheme(JSON.stringify({
      templates: { invoice: "{job:6}_INV{seq}", quote: "Q-" },   // quote has no counter
      jobStart: 30120,
    }));
    expect(partial.templates.invoice).toBe("{job:6}_INV{seq}");
    expect(partial.templates.quote).toBe(DEFAULT_SCHEME.templates.quote);
    expect(partial.jobStart).toBe(30120);
  });
});
