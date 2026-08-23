import { describe, expect, it } from "vitest";
import {
  blindShipNote, canExpedite, effectiveDays, isStalePrice, offerSummary, offersFor,
  priceAgeDays, rankOffers, STALE_PRICE_DAYS, type Offer,
} from "@/lib/sourcing";
import { suggestOrders } from "@/lib/po";

const offer = (over: Partial<Offer>): Offer => ({
  partNumber: "EXT255H", vendor: "V", isOem: false, priceCents: 10000,
  leadDays: null, dropShips: false, expediteOk: false, ...over,
});

describe("effectiveDays", () => {
  it("adds the cross-dock toll only when the vendor cannot drop-ship", () => {
    expect(effectiveDays(offer({ leadDays: 3, dropShips: true }), 2)).toBe(3);
    expect(effectiveDays(offer({ leadDays: 3, dropShips: false }), 2)).toBe(5);
  });
  it("keeps an unrecorded lead time unknown rather than guessing zero", () => {
    expect(effectiveDays(offer({ leadDays: null }), 2)).toBeNull();
  });
  it("never subtracts a negative cross-dock", () => {
    expect(effectiveDays(offer({ leadDays: 3 }), -5)).toBe(3);
  });
});

describe("rankOffers", () => {
  const agilent = offer({ vendor: "Agilent", isOem: true, priceCents: 21000, leadDays: 2, dropShips: false });
  const ff = offer({ vendor: "Frit & Ferrule", priceCents: 16500, leadDays: 3, dropShips: true, expediteOk: true });
  const mystery = offer({ vendor: "SurplusCo", priceCents: 9000, leadDays: null, dropShips: true });

  it("cheapest is price first, whatever the speed", () => {
    const r = rankOffers([agilent, ff, mystery], { mode: "cheapest", crossDockDays: 1 });
    expect(r.map((o) => o.vendor)).toEqual(["SurplusCo", "Frit & Ferrule", "Agilent"]);
  });
  it("fastest compares door to door: OEM's 2d loses to a drop-shipper's 3d once cross-dock is paid", () => {
    const r = rankOffers([agilent, ff], { mode: "fastest", crossDockDays: 2 });
    // Agilent: 2 + 2 cross-dock = 4. F&F: 3 direct.
    expect(r[0].vendor).toBe("Frit & Ferrule");
  });
  it("an unknown lead time sorts behind every known one", () => {
    const r = rankOffers([mystery, ff], { mode: "fastest", crossDockDays: 1 });
    expect(r.map((o) => o.vendor)).toEqual(["Frit & Ferrule", "SurplusCo"]);
  });
  it("urgent narrows to overnight-capable drop-shippers, or says nothing can", () => {
    const r = rankOffers([agilent, ff, mystery], { mode: "cheapest", urgent: true, crossDockDays: 1 });
    expect(r.map((o) => o.vendor)).toEqual(["Frit & Ferrule"]);
    expect(rankOffers([agilent, mystery], { mode: "fastest", urgent: true, crossDockDays: 1 })).toEqual([]);
  });
  it("offersFor matches part numbers the book's loose way", () => {
    const r = offersFor([agilent, offer({ partNumber: " ext255h ", vendor: "Other", priceCents: 1 })],
      "EXT255H", { mode: "cheapest", crossDockDays: 1 });
    expect(r).toHaveLength(2);
    expect(r[0].vendor).toBe("Other");
  });
});

describe("canExpedite", () => {
  it("overnight needs both the will and the drop-ship lane", () => {
    expect(canExpedite({ expediteOk: true, dropShips: true })).toBe(true);
    expect(canExpedite({ expediteOk: true, dropShips: false })).toBe(false);
    expect(canExpedite({ expediteOk: false, dropShips: true })).toBe(false);
  });
});

describe("staleness", () => {
  it("ages a price in whole days", () => {
    expect(priceAgeDays("2026-05-01T12:00:00Z", "2026-08-23")).toBeGreaterThan(STALE_PRICE_DAYS);
    expect(priceAgeDays("2026-08-20T00:00:00Z", "2026-08-23")).toBe(3);
  });
  it("flags only what is actually past the window", () => {
    expect(isStalePrice("2026-05-01T00:00:00Z", "2026-08-23")).toBe(true);
    expect(isStalePrice("2026-08-01T00:00:00Z", "2026-08-23")).toBe(false);
  });
});

describe("offerSummary and blindShipNote", () => {
  it("reads as the fine print a buyer needs", () => {
    const s = offerSummary(offer({ leadDays: 3, dropShips: true, expediteOk: true }), 1);
    expect(s).toBe("3d door to door · drop-ships · overnight ok");
    expect(offerSummary(offer({}), 1)).toBe("lead time unknown · via the shop");
  });
  it("keeps the vendor's name out of the box", () => {
    const n = blindShipNote("Ridgeline", "Lab Zen - Building 4");
    expect(n).toContain('read "Ridgeline"');
    expect(n).toContain("Blind ship to Lab Zen - Building 4");
    expect(n).toContain("no vendor invoice");
  });
});

describe("suggestOrders with a mode", () => {
  const short = [{ partNumber: "EXT255H", name: "Turbo", qty: 0, minQty: 1 }];
  const book = [
    offer({ vendor: "SurplusCo", priceCents: 9000, leadDays: 9, dropShips: true }),
    offer({ vendor: "Frit & Ferrule", priceCents: 16500, leadDays: 2, dropShips: true }),
  ];
  it("cheapest stays the default composer behavior", () => {
    const groups = suggestOrders(short as never, book);
    expect(groups[0].vendor).toBe("SurplusCo");
  });
  it("fastest re-routes the same shortage to the quicker vendor", () => {
    const groups = suggestOrders(short as never, book, { mode: "fastest", crossDockDays: 1 });
    expect(groups[0].vendor).toBe("Frit & Ferrule");
  });
});
