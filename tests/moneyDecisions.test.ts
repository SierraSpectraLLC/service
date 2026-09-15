// The one list the Home page and the digest rank from. Pure.
import { describe, expect, it } from "vitest";
import { decisionsFrom, digestInputFrom, rankDecisions, type DecisionSources } from "@/lib/money/decisions";

const EMPTY: DecisionSources = {
  today: "2026-09-15", drafts: [], overdue: [], unbilled: [], reports: [], billsDue: [], posReceived: [],
  unmatchedBank: { count: 0, cents: 0 }, stripeCents: 0, installments: [], holds: [], payroll: null,
  staleQuotes: [], brokenPromises: [], openDisputes: [],
};

describe("decisionsFrom", () => {
  it("is empty when nothing is waiting", () => {
    expect(decisionsFrom(EMPTY)).toEqual([]);
  });

  it("ranks problems before warnings before chores, and bigger money first inside a band", () => {
    const list = decisionsFrom({
      ...EMPTY,
      drafts: [{ id: 1, number: "INV-1", orgName: "LabZen", totalCents: 900000, workOrderId: null }],
      overdue: [{ id: 2, number: "INV-2", orgName: "Cascade", daysLate: 4, balanceCents: 100, promiseBroken: false, disputed: false }],
      unmatchedBank: { count: 2, cents: 50 },
      holds: [{ orgId: 9, orgName: "Vega", worstDays: 61, owedCents: 800 }],
    });
    expect(list.map((d) => d.key)).toEqual(["hold-9", "overdue-2", "bank-unmatched", "draft-1"]);
  });

  it("puts the button beside the row: send, pay, run, draft", () => {
    const list = decisionsFrom({
      ...EMPTY,
      drafts: [{ id: 1, number: "INV-1", orgName: "LabZen", totalCents: 10, workOrderId: null }],
      posReceived: [{ id: 5, number: "PO-5", vendor: "Agilent", title: "Lamp", cents: 20, receivedOn: "2026-09-10" }],
      payroll: { ym: "2026-09", grossCents: 30, runOn: "2026-09-30", people: 2 },
      unbilled: [{ woId: 8, number: "WO-8", orgName: "LabZen", title: "PM", daysClosed: 3, valueCents: 40 }],
    });
    expect(list.map((d) => d.action.kind).sort()).toEqual(["draft-invoice", "pay-po", "run-payroll", "send-invoice"]);
  });

  it("leaves a job closed today alone, and an installment more than three weeks out", () => {
    const list = decisionsFrom({
      ...EMPTY,
      unbilled: [{ woId: 8, number: "WO-8", orgName: "LabZen", title: "PM", daysClosed: 0, valueCents: 40 }],
      installments: [{ agreementId: 1, orgName: "LabZen", title: "Gold", cents: 10, on: "2026-12-01" }],
    });
    expect(list).toEqual([]);
  });

  it("colours a bill by how close its day is", () => {
    const list = decisionsFrom({
      ...EMPTY,
      billsDue: [
        { id: 1, payee: "Rent", kind: "rent", cents: 1, on: "2026-09-14", portalUrl: "" },
        { id: 2, payee: "Verizon", kind: "phone", cents: 1, on: "2026-09-17", portalUrl: "https://pay.example" },
        { id: 3, payee: "Insurance", kind: "insurance", cents: 1, on: "2026-10-01", portalUrl: "" },
      ],
    });
    expect(list.map((d) => [d.key, d.tone, d.action.kind === "link" ? d.action.label : ""])).toEqual([
      ["bill-1-2026-09-14", "bad", "Bills"], ["bill-2-2026-09-17", "warn", "Pay"], ["bill-3-2026-10-01", "", "Bills"],
    ]);
  });

  it("only surfaces a claim that has been submitted", () => {
    const list = decisionsFrom({
      ...EMPTY,
      reports: [
        { id: 1, person: "Ana", title: "Fresno trip", status: "submitted", cents: 5, submittedOn: "2026-09-12" },
        { id: 2, person: "Bo", title: "Draft", status: "open", cents: 5, submittedOn: "" },
      ],
    });
    expect(list.map((d) => d.key)).toEqual(["report-1"]);
  });
});

describe("rankDecisions", () => {
  it("is stable for equal tone and money", () => {
    const a = { key: "a", tone: "" as const, title: "", detail: "", cents: 1, href: "", action: { kind: "link" as const, href: "", label: "" } };
    const b = { ...a, key: "b" };
    expect(rankDecisions([a, b]).map((d) => d.key)).toEqual(["a", "b"]);
  });
});

describe("digestInputFrom", () => {
  it("projects the same sources the page ranks", () => {
    const s: DecisionSources = {
      ...EMPTY,
      overdue: [{ id: 2, number: "INV-2", orgName: "Cascade", daysLate: 4, balanceCents: 100, promiseBroken: false, disputed: false }],
      unbilled: [{ woId: 8, number: "WO-8", orgName: "LabZen", title: "PM", daysClosed: 3, valueCents: 40 }],
    };
    const d = digestInputFrom(s);
    expect(JSON.stringify(d)).toContain("INV-2");
    expect(JSON.stringify(d)).toContain("WO-8");
  });
});
