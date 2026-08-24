// The statement arithmetic: standing reconciled against the ledger, aging
// measured from the due date, disputes ageing without being asked for, and the
// loop bar. Pure functions, no DB.
import { describe, expect, it } from "vitest";
import {
  aging, bucketOf, daysBetween, dueDate, invoiceView, isOpen, loopBar,
  statementFor, type InvoiceRow,
} from "@/lib/statement";

const line = (cents: number, covered = false) => ({ qty: 1, unitCents: cents, covered });

const inv = (over: Partial<InvoiceRow> = {}): InvoiceRow => ({
  id: 1, number: "INV-1001", orgId: 1, status: "sent",
  issuedOn: "2026-07-12", dueOn: "2026-08-11", lines: [line(100000)], ...over,
});

describe("dueDate / daysBetween", () => {
  it("adds the terms to the issue date", () => {
    expect(dueDate("2026-07-12", 30)).toBe("2026-08-11");
    expect(dueDate("2026-08-19", 14)).toBe("2026-09-02");
  });
  it("has no answer without an issue date", () => {
    expect(dueDate("", 30)).toBe("");
    expect(daysBetween("", "2026-08-11")).toBe(0);
  });
  it("counts backwards as a negative", () => {
    expect(daysBetween("2026-08-11", "2026-08-01")).toBe(-10);
  });
});

describe("invoiceView", () => {
  it("reads paid off the ledger even when the column still says sent", () => {
    const v = invoiceView(inv({ paidCents: [100000] }), "2026-09-01");
    expect(v.standing).toBe("paid");
    expect(v.balanceCents).toBe(0);
    expect(v.daysLate).toBe(0);
  });

  it("ages from the due date, not the issue date", () => {
    const v = invoiceView(inv(), "2026-08-22");
    expect(v.standing).toBe("overdue");
    expect(v.daysLate).toBe(11);
  });

  it("calls an invoice due soon inside the window and open outside it", () => {
    expect(invoiceView(inv(), "2026-08-06").standing).toBe("due");
    expect(invoiceView(inv(), "2026-07-20").standing).toBe("sent");
  });

  it("keeps a disputed invoice aging while asking only for the rest", () => {
    const v = invoiceView(inv({ lines: [line(84000), line(34000)], disputedCents: 34000 }), "2026-08-22");
    expect(v.balanceCents).toBe(118000);
    expect(v.payableCents).toBe(84000);
    expect(v.daysLate).toBe(11);
    expect(v.standing).toBe("overdue");
  });

  it("adds fees to the balance and subtracts payments", () => {
    const v = invoiceView(inv({ feeCents: [5800], paidCents: [40000] }), "2026-08-01");
    expect(v.feesCents).toBe(5800);
    expect(v.balanceCents).toBe(65800);
  });

  it("never ages a draft or a void", () => {
    expect(invoiceView(inv({ status: "draft", dueOn: "" }), "2026-09-01").standing).toBe("draft");
    expect(invoiceView(inv({ status: "void" }), "2026-09-01").daysLate).toBe(0);
  });

  it("holds a referred invoice at referred, however it sums", () => {
    expect(invoiceView(inv({ status: "referred" }), "2026-09-01").standing).toBe("referred");
  });

  it("never goes overdue without a due date", () => {
    expect(invoiceView(inv({ dueOn: "" }), "2027-01-01").standing).toBe("sent");
  });
});

describe("aging", () => {
  it("buckets on days late", () => {
    expect(bucketOf(0)).toBe("current");
    expect(bucketOf(1)).toBe("d30");
    expect(bucketOf(30)).toBe("d30");
    expect(bucketOf(31)).toBe("d60");
    expect(bucketOf(61)).toBe("d90");
  });

  it("counts only open invoices", () => {
    const views = [
      invoiceView(inv({ id: 1, dueOn: "2026-08-11", lines: [line(100000)] }), "2026-08-22"),
      invoiceView(inv({ id: 2, dueOn: "2026-09-30", lines: [line(50000)] }), "2026-08-22"),
      invoiceView(inv({ id: 3, lines: [line(90000)], paidCents: [90000] }), "2026-08-22"),
      invoiceView(inv({ id: 4, status: "draft", lines: [line(70000)] }), "2026-08-22"),
    ];
    const a = aging(views);
    expect(a.total).toBe(150000);
    expect(a.buckets.d30).toBe(100000);
    expect(a.buckets.current).toBe(50000);
    expect(views.filter(isOpen)).toHaveLength(2);
  });
});

describe("statementFor", () => {
  const rows: InvoiceRow[] = [
    inv({ id: 1, number: "INV-0087", orgId: 2, dueOn: "2026-07-12", lines: [line(390000)], feeCents: [5800] }),
    inv({ id: 2, number: "INV-0092", orgId: 1, dueOn: "2026-09-02", lines: [line(118000)], disputedCents: 34000 }),
    inv({ id: 3, number: "INV-0089", orgId: 1, lines: [line(62000)], paidCents: [62000] }),
  ];

  it("answers for one org and nobody else", () => {
    const s = statementFor({ orgId: 1, invoices: rows, today: "2026-08-22" });
    expect(s.open.map((v) => v.number)).toEqual(["INV-0092"]);
    expect(s.openCents).toBe(118000);
    expect(s.payableCents).toBe(84000);
    expect(s.disputedCents).toBe(34000);
  });

  it("puts the oldest debt first and reports how old it is", () => {
    const s = statementFor({ orgId: 2, invoices: rows, today: "2026-08-22" });
    expect(s.openCents).toBe(395800);
    expect(s.oldestDaysLate).toBe(41);
  });

  it("sums the window's payments without inventing any", () => {
    const s = statementFor({ orgId: 1, invoices: rows, today: "2026-08-22", paidCents: [62000, 131000] });
    expect(s.paidCents).toBe(193000);
  });
});

describe("loopBar", () => {
  it("splits open money at the due date", () => {
    const views = [
      invoiceView(inv({ id: 1, dueOn: "2026-08-11", lines: [line(842000)] }), "2026-08-22"),
      invoiceView(inv({ id: 2, dueOn: "2026-09-30", lines: [line(538000)] }), "2026-08-22"),
    ];
    const bar = loopBar({ quoted: [432000], approved: [257500], unbilled: [1186000], views, paid: [1924000] });
    expect(bar.pastDueCents).toBe(842000);
    expect(bar.currentCents).toBe(538000);
    expect(bar.quotedCents).toBe(432000);
    expect(bar.unbilledCents).toBe(1186000);
    expect(bar.paidCents).toBe(1924000);
  });
});
