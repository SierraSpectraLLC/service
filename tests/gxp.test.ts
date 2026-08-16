import { describe, expect, it } from "vitest";
import {
  daysUntil, expiryAttention, expiryLabel, qualsOf, qualStanding,
} from "@/lib/gxp";

const TODAY = "2026-08-16";

describe("expiring documents", () => {
  it("splits expired from expiring-soon and lets undated files rest", () => {
    const docs = [
      { name: "cal cert", expiresOn: "2026-08-01" },   // lapsed
      { name: "balance cert", expiresOn: "2026-09-30" }, // inside 60 days
      { name: "next year", expiresOn: "2027-08-01" },
      { name: "manual", expiresOn: "" },
    ];
    const a = expiryAttention(docs, TODAY);
    expect(a.expired.map((d) => d.name)).toEqual(["cal cert"]);
    expect(a.soon.map((d) => d.name)).toEqual(["balance cert"]);
  });

  it("counts the day itself as still current", () => {
    expect(daysUntil("2026-08-16", TODAY)).toBe(0);
    expect(expiryAttention([{ expiresOn: TODAY }], TODAY).expired).toHaveLength(0);
    expect(expiryLabel(TODAY, TODAY)).toBe("expires today");
    expect(expiryLabel("2026-08-14", TODAY)).toBe("expired 2d ago");
    expect(expiryLabel("2026-09-15", TODAY)).toBe("expires in 30d");
  });
});

describe("qualification standing", () => {
  const base = { expired: 0, expiringSoon: 0, packageComplete: null };

  it("is Qualified when the record is clean", () => {
    const s = qualStanding({ ...base, quals: [{ qualification: "IQ", open: 0, done: 3 }] });
    expect(s.label).toBe("Qualified");
    expect(s.reasons).toEqual([]);
  });

  it("is Not qualified while a qualification has never been completed", () => {
    const s = qualStanding({ ...base, quals: [{ qualification: "OQ", open: 4, done: 0 }] });
    expect(s.label).toBe("Not qualified");
    expect(s.reasons[0]).toContain("OQ has never been completed");
  });

  it("treats requal work in flight as Attention, not disqualification", () => {
    // The system WAS qualified; the annual OQ generating new tasks is lapsing,
    // not a system that never worked. Different conversation.
    const s = qualStanding({ ...base, quals: [{ qualification: "OQ", open: 2, done: 5 }] });
    expect(s.label).toBe("Attention");
    expect(s.reasons[0]).toContain("OQ rework open");
  });

  it("lapsed paper is Attention; an incomplete declared package is harder", () => {
    expect(qualStanding({ ...base, quals: [], expired: 1 }).label).toBe("Attention");
    expect(qualStanding({ ...base, quals: [], packageComplete: false }).label).toBe("Not qualified");
    // No package declared at all is not a failure - the tags work without it.
    expect(qualStanding({ ...base, quals: [] }).label).toBe("Qualified");
  });

  it("keeps every reason, worst first", () => {
    const s = qualStanding({
      quals: [{ qualification: "PQ", open: 1, done: 2 }],
      expired: 2, expiringSoon: 1, packageComplete: false,
    });
    expect(s.label).toBe("Not qualified");
    expect(s.reasons).toHaveLength(4);
  });
});

describe("grouping tagged tasks", () => {
  it("buckets by qualification in run order and skips untagged work", () => {
    expect(qualsOf([
      { qualification: "OQ", state: "Done" },
      { qualification: "OQ", state: "Open" },
      { qualification: "IQ", state: "Done" },
      { qualification: "", state: "Open" },
    ])).toEqual([
      { qualification: "IQ", open: 0, done: 1 },
      { qualification: "OQ", open: 1, done: 1 },
    ]);
  });
});
