import { describe, expect, it } from "vitest";
import {
  lineTotalCents, poTotals, lineOutstanding, statusAfterReceipt, suggestOrders, nextPoNumber,
  poEditable, poReceivable,
} from "@/lib/po";

const l = (qtyOrdered: number, qtyReceived: number, unitCents: number | null) => ({ qtyOrdered, qtyReceived, unitCents });

describe("line math", () => {
  it("multiplies out, or admits it can't", () => {
    expect(lineTotalCents(l(3, 0, 12900))).toBe(38700);
    expect(lineTotalCents(l(3, 0, null))).toBeNull();
  });

  it("never reports negative outstanding when a vendor over-ships", () => {
    expect(lineOutstanding(l(2, 5, 100))).toBe(0);
  });
});

describe("poTotals", () => {
  it("sums priced lines and counts the unpriced ones separately", () => {
    const t = poTotals([l(2, 0, 5000), l(1, 0, null), l(4, 4, 250)]);
    expect(t.cents).toBe(11000);
    expect(t.priced).toBe(2);
    expect(t.unpriced).toBe(1);
    expect(t.ordered).toBe(7);
    expect(t.received).toBe(4);
    expect(t.outstanding).toBe(3);
  });

  it("doesn't let an over-shipped line inflate the received count", () => {
    expect(poTotals([l(2, 9, 100)]).received).toBe(2);
  });
});

describe("statusAfterReceipt", () => {
  it("settles only when nothing is outstanding", () => {
    expect(statusAfterReceipt([l(2, 2, 100), l(1, 1, 100)])).toBe("received");
    expect(statusAfterReceipt([l(2, 1, 100), l(1, 0, 100)])).toBe("partial");
    expect(statusAfterReceipt([l(2, 0, 100)])).toBe("sent");
  });

  it("counts an over-shipment as settled", () => {
    expect(statusAfterReceipt([l(2, 3, 100)])).toBe("received");
  });
});

describe("editable / receivable", () => {
  it("locks a PO once the vendor has it, but that's when you receive", () => {
    expect(poEditable("draft")).toBe(true);
    expect(poEditable("sent")).toBe(false);
    expect(poReceivable("draft")).toBe(false);
    expect(poReceivable("sent")).toBe(true);
    expect(poReceivable("partial")).toBe(true);
    expect(poReceivable("received")).toBe(false);
  });
});

describe("suggestOrders", () => {
  const book = [
    { partNumber: "228-35145-91", vendor: "Shimadzu", isOem: true, priceCents: 12900 },
    { partNumber: "228-35145-91", vendor: "Chrom Tech", isOem: false, priceCents: 9800 },
    { partNumber: "5181-3323", vendor: "Chrom Tech", isOem: false, priceCents: 4200 },
  ];
  const shelf = [
    { partNumber: "228-35145-91", name: "Plunger seals", qty: 1, minQty: 4 },
    { partNumber: "5181-3323", name: "Septa", qty: 0, minQty: 2 },
    { partNumber: "MYSTERY-1", name: "Unpriced widget", qty: 0, minQty: 1 },
    { partNumber: "FINE-1", name: "Plenty", qty: 9, minQty: 2 },
  ];

  it("groups short lines by cheapest vendor and buys back up to the floor", () => {
    const orders = suggestOrders(shelf, book);
    const chrom = orders.find((o) => o.vendor === "Chrom Tech")!;
    expect(chrom.lines.map((x) => x.partNumber).sort()).toEqual(["228-35145-91", "5181-3323"]);
    expect(chrom.lines.find((x) => x.partNumber === "228-35145-91")!.qty).toBe(3);
    expect(chrom.lines.find((x) => x.partNumber === "5181-3323")!.qty).toBe(2);
  });

  it("still suggests a part nobody prices, under a blank vendor, listed last", () => {
    const orders = suggestOrders(shelf, book);
    expect(orders[orders.length - 1].vendor).toBe("");
    expect(orders[orders.length - 1].lines[0].partNumber).toBe("MYSTERY-1");
    expect(orders[orders.length - 1].lines[0].unitCents).toBeNull();
  });

  it("leaves well-stocked lines alone", () => {
    const all = suggestOrders(shelf, book).flatMap((o) => o.lines.map((x) => x.partNumber));
    expect(all).not.toContain("FINE-1");
  });
});

describe("nextPoNumber", () => {
  it("counts up from the highest number ever used, not the row count", () => {
    // PO-1042 was cancelled and deleted; its number must never come back.
    expect(nextPoNumber(["PO-1001", "PO-1042"])).toBe("PO-1043");
    expect(nextPoNumber([])).toBe("PO-1001");
    expect(nextPoNumber(["nonsense"])).toBe("PO-1001");
  });
});
