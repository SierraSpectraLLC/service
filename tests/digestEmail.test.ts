// The partner digest as an EMAIL: the constraints that decide whether it
// survives the trip (no classes, no stylesheet, no clipping) and the content
// rules that decide whether it should have been sent at all.
import { describe, expect, it } from "vitest";
import type { PendingItem } from "@/lib/digest";
import {
  age, firstName, internalRemark, mergeAsks, partnerPreheader, partnerView,
  renderPartnerDigest, renderPartnerDigestText, MAX_IN_WORK,
} from "@/lib/digestPartner";
import { TONE_HEX } from "@/lib/tones";

const pending = (over: Partial<PendingItem> = {}): PendingItem => ({
  systemId: 1, externalId: "T-001", court: "partner", who: "Lab Zen",
  what: "No tracking yet for H-ESI needle seal", days: 5,
  cause: "part-tracking", subject: "H-ESI needle seal",
  ...over,
});

const board = (over: Partial<{
  externalId: string; label: string; stages: string[];
  gases: { gas: string; status: string }[]; openParts: number; lead: string;
}> = {}) => ({
  externalId: "T-001", label: "Thermo Altis LC-MS/MS", stages: ["Waiting / blocked"],
  gases: [], openParts: 2, lead: "joe.vincent", ...over,
});

const view = (over: Partial<Parameters<typeof partnerView>[0]["section"]> = {}) => partnerView({
  section: {
    name: "Lab Zen",
    board: [board()],
    pending: [pending()],
    handoffs: [],
    ...over,
  },
  operatorName: "Sierra Spectra",
  dateLabel: "Sat Aug 22",
  portalUrl: "https://service.example.com",
  blockedStage: "Waiting / blocked",
  stageHex: () => TONE_HEX.bad,
  gasBlocking: (s) => s === "Empty" || s === "Low",
});

const render = (v = view()) => renderPartnerDigest(v, partnerPreheader(v));

describe("email constraints", () => {
  it("carries no class attributes and no stylesheet beyond the MSO block", () => {
    const html = render();
    expect(html).not.toMatch(/\sclass=/);
    // The one permitted <style> is the Outlook conditional, and nothing else.
    const styleTags = html.match(/<style[\s>]/g) ?? [];
    expect(styleTags).toHaveLength(1);
    expect(html).toContain("<!--[if mso]><style>");
    expect(html).not.toMatch(/display:\s*(flex|grid)/);
    expect(html).not.toMatch(/<link[^>]+stylesheet/);
  });

  it("is a 600px table that can shrink, with the preheader first in the body", () => {
    const html = render();
    expect(html).toContain('role="presentation"');
    expect(html).toContain('width="600"');
    // Fluid with a ceiling, never a fixed 600: a table told to be 600px wide
    // cannot shrink below it, and a phone gets a horizontal scrollbar.
    expect(html).toContain("width:100%;max-width:600px");
    expect(html).not.toContain("width:600px;max-width");
    const body = html.slice(html.indexOf("<body"));
    // The hidden line has to beat every table cell to the inbox preview.
    expect(body.indexOf("display:none;max-height:0")).toBeLessThan(body.indexOf("<table"));
  });

  it("stays under 80 KB on a fleet big enough to clip, and says what it left out", () => {
    const many = Array.from({ length: 200 }, (_, i) =>
      board({ externalId: `SYS-${i}`, label: `Agilent 6495C triple quadrupole unit ${i}`, lead: "chris.bell" }));
    const v = view({ board: many });
    const html = renderPartnerDigest(v, partnerPreheader(v));
    expect(Buffer.byteLength(html, "utf8")).toBeLessThan(80 * 1024);
    expect(v.inWork).toHaveLength(MAX_IN_WORK);
    expect(v.moreInWork).toBe(200 - MAX_IN_WORK);
    expect(html).toContain(`${200 - MAX_IN_WORK} more in work`);
  });

  it("renders a plain-text alternative from the same data", () => {
    const v = view();
    const text = renderPartnerDigestText(v, partnerPreheader(v));
    expect(text).not.toContain("<");
    expect(text).toContain("NEEDS LAB ZEN (1)");
    expect(text).toContain("T-001");
    expect(text).toContain("Tracking numbers for H-ESI needle seal");
  });
});

describe("nothing internal reaches the client", () => {
  it("recognises sheet-sync and parity remarks wherever they were typed", () => {
    expect(internalRemark("No longer on the Google sheet")).toBe(true);
    expect(internalRemark("parity diff on stages")).toBe(true);
    expect(internalRemark("[internal] chase Joe about this")).toBe(true);
    expect(internalRemark("Waiting on a roughing pump")).toBe(false);
  });

  it("drops an internal blocked reason instead of publishing it", () => {
    const v = view({
      pending: [pending({ court: "us", who: "Sierra Spectra", cause: "blocked", subject: "No longer on the Google sheet" })],
    });
    const html = renderPartnerDigest(v, partnerPreheader(v));
    expect(v.blocked).toHaveLength(0);
    expect(html).not.toContain("Google sheet");
    expect(html.toLowerCase()).not.toContain("parity");
  });

  it("keeps an internal handback reason out of the row it would have led", () => {
    const v = view({
      handoffs: [{ externalId: "G-007", label: "Agilent UPLC", holder: "Lab Zen", reason: "not on sheet", days: 2 }],
    });
    expect(v.handedBack[0].what).toBe("");
    expect(renderPartnerDigest(v, partnerPreheader(v))).not.toContain("not on sheet");
  });
});

describe("what the client is asked to do", () => {
  it("merges items that share a system and a cause into one ask", () => {
    const merged = mergeAsks([
      pending({ subject: "H-ESI needle seal" }),
      pending({ subject: "H-ESI needle", days: 9 }),
      pending({ cause: "part-order", subject: "Turbo pump" }),
    ]);
    expect(merged).toHaveLength(2);
    expect(merged[0].subjects).toEqual(["H-ESI needle seal", "H-ESI needle"]);
    expect(merged[0].days).toBe(9); // the oldest wait is the one worth quoting
  });

  it("words each ask as an instruction, with why it matters underneath", () => {
    const v = view({ pending: [pending({ subject: "H-ESI needle seal" }), pending({ subject: "H-ESI needle" })] });
    expect(v.needs).toHaveLength(1);
    expect(v.needs[0].ask).toBe("Tracking numbers for H-ESI needle seal and H-ESI needle");
    expect(v.needs[0].why).toContain("Thermo Altis LC-MS/MS");
    expect(v.needs[0].why).toContain("ordered by Lab Zen 5d ago");
    expect(v.needs[0].why).toContain("we cannot book the work until they land");
  });

  it("puts a supplier wait with us, and names the date when the record has one", () => {
    const v = view({
      pending: [pending({ court: "supplier", who: "supplier", cause: "part-transit", subject: "Ion gauge", days: null, eta: "Aug 28" })],
    });
    expect(v.needs).toHaveLength(0);
    expect(v.blocked[0].ask).toBe("Ion gauge in transit");
    expect(v.blocked[0].why).toContain("ETA Aug 28");
  });
});

describe("the in-work line", () => {
  it("never stacks pills, and says (above) instead of repeating itself", () => {
    const v = view();
    const html = renderPartnerDigest(v, partnerPreheader(v));
    expect(v.inWork[0].status).toBe("waiting on your tracking numbers (above)");
    // One pill per row: the stage, and nothing else wearing a radius.
    expect((html.match(/border-radius:999px/g) ?? [])).toHaveLength(1);
  });

  it("shows gas only when it blocks, and the lead by first name", () => {
    const quiet = view({ board: [board({ gases: [{ gas: "Nitrogen", status: "Connected" }] })] });
    expect(quiet.inWork[0].gasNeed).toBe("");
    const stuck = view({
      board: [board({ gases: [{ gas: "Argon", status: "Empty" }, { gas: "Nitrogen", status: "Connected" }] })],
    });
    expect(stuck.inWork[0].gasNeed).toBe("needs Ar");
    expect(stuck.inWork[0].lead).toBe("Joe");
  });

  it("counts open parts only when there are some", () => {
    const html = render(view({ board: [board({ openParts: 0 })] }));
    expect(html).not.toContain("parts open");
    expect(render()).toContain("2 parts open");
  });
});

describe("shape and wording", () => {
  it("carries only the four sections a client can act on", () => {
    // The internal edition's follow-up list, activity tally, since-yesterday
    // narrative and failed-test card stay ours. A client's narrative is their
    // EOD report; repeating it here would make two emails say one thing.
    const html = render();
    for (const ours of ["Follow up today", "changes logged", "Since yesterday", "Failed tests"]) {
      expect(html).not.toContain(ours);
    }
  });

  it("omits empty sections rather than announcing them", () => {
    const html = render(view({ pending: [], handoffs: [] }));
    expect(html).not.toContain("NEEDS LAB ZEN");
    expect(html).not.toContain("HANDED BACK");
    expect(html).toContain("IN WORK AT SIERRA SPECTRA");
  });

  it("summarises the counts in the preheader", () => {
    const v = view({
      handoffs: [{ externalId: "G-007", label: "Agilent UPLC", holder: "Lab Zen", reason: "repair complete", days: 2 }],
    });
    expect(partnerPreheader(v)).toBe("1 thing needs Lab Zen · 0 blocked with us · 1 handed back · 1 in work");
  });

  it("takes its tile and heading colours from the tone pairs", () => {
    const html = render();
    expect(html).toContain(TONE_HEX.warn.bg);
    expect(html).toContain(TONE_HEX.warn.fg);
    expect(html).toContain(TONE_HEX.good.bg);
    expect(html).toContain(TONE_HEX.neutral.bg);
  });

  it("reads ages in days then weeks, and never shows a username", () => {
    expect(age(2)).toBe("2d");
    expect(age(21)).toBe("3w");
    expect(firstName("joe.vincent@sierraspectra.com")).toBe("Joe");
    expect(firstName("Bill Harner")).toBe("Bill");
    expect(firstName("")).toBe("");
  });
});
