// One client's fleet, written down for somebody outside the workspace.
//
// The recipient is frequently a competitor, so the tests that matter most are
// the negative ones: what a brief must never contain. The row type is the real
// guard - there is nowhere to put a price - and these hold the renderers to it
// so that a later edit which adds one has to come through here first.
import { describe, expect, it } from "vitest";
import {
  briefProblems, buildFleetBrief, fleetBriefBody, fleetBriefSubject, groupBySite, moduleLine,
  parseRecipients, renderFleetBriefHtml, renderFleetBriefText, systemMeta,
  type FleetRow,
} from "@/lib/fleetBrief";

const sys = (over: Partial<FleetRow> & { externalId: string }): FleetRow => ({
  label: "LC-MS", category: "LC-MS", siteName: "Hayward", modules: [],
  state: "ok", coverage: "ours", coverageBadge: "Under contract", ...over,
});

const EMERY: FleetRow[] = [
  sys({
    externalId: "EP-001", label: "LC-MS", siteName: "Hayward",
    modules: [
      { kind: "Mass Spec", model: "Altis", serial: "12345", manufacturer: "Thermo" },
      { kind: "Pump", model: "nXDS15i", serial: "A77", manufacturer: "Edwards" },
    ],
  }),
  sys({ externalId: "EP-002", siteName: "Hayward", state: "down", coverage: "lapsed", coverageBadge: "Contract lapsed" }),
  sys({ externalId: "EP-010", siteName: "Alameda", coverage: "theirs", coverageBadge: "Agilent" }),
  sys({ externalId: "EP-011", siteName: "Alameda", coverage: "unknown", coverageBadge: "No contract on file" }),
];

const BRIEF = buildFleetBrief({
  client: "Emery Pharma", from: "Joe at Sierra Spectra", today: "2026-08-27", rows: EMERY,
});

describe("what a brief must never carry", () => {
  const text = renderFleetBriefText(BRIEF);
  const html = renderFleetBriefHtml(BRIEF, { name: "Sierra Spectra" });

  it("has no money in it anywhere", () => {
    /*
     * The recipient is often a competitor and what a job cost is the owner's
     * business. The FleetRow type has no cost field at all, which is what
     * really prevents this - these assertions are the alarm on the door.
     */
    for (const out of [text, html]) {
      expect(out).not.toContain("$");
      expect(out).not.toMatch(/\bUSD\b/);
    }
    // The words, checked against the BODY rather than the whole rendering: the
    // footer deliberately says "nothing here is a price or a quote", and a
    // test that cannot tell a disclaimer from a leak would have to be deleted
    // the first time somebody read it.
    expect(fleetBriefBody(BRIEF)).not.toMatch(/\b(price|invoice|quote[ds]?|cost)\b/i);
  });

  it("says out loud that it is equipment only", () => {
    expect(renderFleetBriefHtml(BRIEF, { name: "Sierra Spectra" }))
      .toContain("nothing here is a price");
  });

  it("carries no purchase order, no note thread and no contact details", () => {
    for (const out of [text, html]) {
      expect(out).not.toMatch(/\bPO\b|purchase order/i);
      expect(out).not.toMatch(/@[a-z]+\.[a-z]+/i);   // no lead's address, no site contact
    }
  });
});

describe("what it does carry", () => {
  it("leads with the client's own estate, not with our share of it", () => {
    // coverageSummary counts ANY live contract - a peer asking "who has this
    // one" wants the true answer, not ours.
    // Two of the four: one ours, one Agilent's. Lapsed and unknown are not
    // covered, and "no contract ON FILE" is the honest word for the last one.
    expect(BRIEF.headline).toBe("4 instruments · 2 under a service contract");
  });

  it("names every module with its model and serial", () => {
    // The whole point of the exercise: models and serials live on the modules,
    // not on the system.
    const text = renderFleetBriefText(BRIEF);
    expect(text).toContain("Mass Spec · Thermo Altis · SN 12345");
    expect(text).toContain("Pump · Edwards nXDS15i · SN A77");
  });

  it("says who already has a contract on each one", () => {
    // The reason a peer asks at all.
    const text = renderFleetBriefText(BRIEF);
    expect(text).toContain("Agilent");
    expect(text).toContain("Contract lapsed");
  });

  it("names the sender, because a list nobody can trace is not actionable", () => {
    expect(renderFleetBriefText(BRIEF)).toContain("From Joe at Sierra Spectra");
  });

  it("titles itself with the client and the day, because these get filed", () => {
    expect(fleetBriefSubject(BRIEF)).toBe("Emery Pharma - fleet summary (2026-08-27)");
  });
});

describe("grouping", () => {
  it("groups by building only when there is more than one", () => {
    const one = groupBySite(EMERY.filter((r) => r.siteName === "Hayward"));
    expect(one).toHaveLength(1);
    expect(one[0].site).toBe("");
    expect(groupBySite(EMERY).map((g) => g.site)).toEqual(["Alameda", "Hayward"]);
  });

  it("gathers systems with no recorded site at the end under a plain word", () => {
    const mixed = [...EMERY, sys({ externalId: "EP-099", siteName: "" })];
    const groups = groupBySite(mixed);
    expect(groups[groups.length - 1].site).toBe("Site not recorded");
    expect(groups[groups.length - 1].rows.map((r) => r.externalId)).toEqual(["EP-099"]);
  });

  it("does not invent a heading when nothing has a site", () => {
    expect(groupBySite([sys({ externalId: "A", siteName: "" })])[0].site).toBe("");
  });

  it("puts what is broken first", () => {
    // A peer scanning this on a phone should hit the down machine first.
    const b = buildFleetBrief({ client: "x", from: "y", today: "2026-08-27", rows: EMERY });
    const hayward = b.groups.find((g) => g.site === "Hayward")!;
    expect(hayward.rows[0].externalId).toBe("EP-002");
  });
});

describe("the second line under a system", () => {
  it("reads where, how and who has it", () => {
    expect(systemMeta(EMERY[1], true)).toBe("Hayward · Down · Contract lapsed");
    // The site is dropped inside a group that already names it.
    expect(systemMeta(EMERY[1], false)).toBe("Down · Contract lapsed");
  });

  it("names a unit even when almost nothing is known about it", () => {
    expect(moduleLine({ kind: "", model: "", serial: "", manufacturer: "" })).toBe("Unit");
    expect(moduleLine({ kind: "Pump", model: "", serial: "", manufacturer: "" })).toBe("Pump");
  });
});

describe("the link, when there is one", () => {
  it("says when it stops working, in both renderings", () => {
    const withLink = buildFleetBrief({
      client: "Emery Pharma", from: "Joe", today: "2026-08-27", rows: EMERY,
      link: { url: "https://x.test/share/abc", expiresOn: "2026-09-10" },
    });
    expect(renderFleetBriefText(withLink)).toContain("stops working on 2026-09-10");
    expect(renderFleetBriefHtml(withLink, { name: "S" })).toContain("2026-09-10");
  });

  it("says nothing at all when there is none", () => {
    expect(renderFleetBriefText(BRIEF)).not.toContain("Live list");
  });
});

describe("who it goes to", () => {
  it("takes a list however somebody typed it", () => {
    expect(parseRecipients("a@x.com, b@y.com;c@z.com\n a@x.com "))
      .toEqual(["a@x.com", "b@y.com", "c@z.com"]);
  });

  it("refuses an empty fleet, an empty list, a crowd and a non-address", () => {
    expect(briefProblems([], ["a@x.com"])[0]).toContain("no systems");
    expect(briefProblems(EMERY, [])[0]).toContain("who it goes to");
    expect(briefProblems(EMERY, ["a@x.com", "b@x.com", "c@x.com", "d@x.com", "e@x.com", "f@x.com"])[0])
      .toContain("At most");
    expect(briefProblems(EMERY, ["not an address"])[0]).toContain("not an address");
  });

  it("is happy with the ordinary case", () => {
    expect(briefProblems(EMERY, ["peer@othershop.com"])).toEqual([]);
  });
});
