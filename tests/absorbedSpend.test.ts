// What the shop has eaten for a client, per client. Pure, no DB.
import { describe, expect, it } from "vitest";
import { absorbedSpend, type AbsorbedExpense, type AbsorbedReport } from "@/lib/absorbedSpend";

const TODAY = "2026-08-31";

const report = (over: Partial<AbsorbedReport> = {}): AbsorbedReport => ({
  id: 1, orgId: 41, orgName: "LabZen", title: "Turbo controller for the QE",
  person: "Tess Nakamura", status: "paid", submittedOn: "2026-08-20", ...over,
});
const row = (over: Partial<AbsorbedExpense> = {}): AbsorbedExpense => ({
  reportId: 1, amountCents: 42_000, incurredOn: "2026-08-18", ...over,
});

describe("absorbedSpend", () => {
  it("adds a client's claims up, biggest bill first, newest claim first", () => {
    const b = absorbedSpend(
      [
        report(),
        report({ id: 2, title: "Courier to Reno", submittedOn: "2026-08-05" }),
        report({ id: 3, orgId: 42, orgName: "Rival Labs", title: "A seal" }),
      ],
      [
        row(),
        row({ reportId: 1, amountCents: 3_000, incurredOn: "2026-08-19" }),
        row({ reportId: 2, amountCents: 8_000, incurredOn: "2026-08-04" }),
        row({ reportId: 3, amountCents: 60_000, incurredOn: "2026-08-10" }),
      ],
      TODAY, 30,
    );
    expect(b.rows.map((c) => [c.orgName, c.totalCents])).toEqual([["Rival Labs", 60_000], ["LabZen", 53_000]]);
    expect(b.rows[1].claims.map((k) => [k.id, k.amountCents, k.on]))
      .toEqual([[1, 45_000, "2026-08-19"], [2, 8_000, "2026-08-04"]]);
    expect(b.totalCents).toBe(113_000);
  });

  it("counts nothing from a returned claim - refused money is not spend", () => {
    const b = absorbedSpend([report({ status: "returned" })], [row()], TODAY, 30);
    expect(b.rows).toEqual([]);
  });

  it("counts a draft: the money left when the part was bought, not when the paperwork was", () => {
    const b = absorbedSpend([report({ status: "draft" })], [row()], TODAY, 30);
    expect(b.totalCents).toBe(42_000);
    expect(b.rows[0].claims[0].status).toBe("draft");
  });

  it("places a row by the day it was spent, and an undated row by the claim's submission", () => {
    const b = absorbedSpend(
      [report({ submittedOn: "2026-08-20" })],
      [
        row({ incurredOn: "2026-05-02" }),                        // out of a 30-day window
        row({ amountCents: 1_000, incurredOn: "" }),               // lands on 2026-08-20
      ],
      TODAY, 30,
    );
    expect(b.totalCents).toBe(1_000);
    expect(b.rows[0].claims[0].on).toBe("2026-08-20");
  });

  it("drops a claim whose rows all fall outside the window rather than listing it at zero", () => {
    const b = absorbedSpend([report()], [row({ incurredOn: "2025-01-01" })], TODAY, 90);
    expect(b.rows).toEqual([]);
  });
});
