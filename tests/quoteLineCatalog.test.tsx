// @vitest-environment jsdom
//
// Building a quote out of the parts catalog instead of out of memory.
//
// Asked for: "I need to be able to search for parts/part numbers when building
// quotes", "if a part isn't available, allow me to add it quickly while
// building the quote", and "we should also have part numbers for labor and
// travel". The line editor took a description, a quantity and a price typed
// from nothing - so the same seal went onto three quotes under three
// spellings at three prices, and an hour of LC/MS work had no number at all.
//
// What these pin is the pick: one choice fills the number, the name, the kind
// of charge, the unit and the price, and the price is the SELL price rather
// than what the shop pays a vendor for it.
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

type Written = {
  kind: string; description: string; partNumber?: string; unit?: string;
  qty: number; unitCents: number;
};
const addQuoteLine = vi.fn(async (_id?: number, _line?: Written) => ({}));
vi.mock("@/app/actions", () => ({
  addQuoteLine: (...a: unknown[]) => addQuoteLine(...(a as [])),
  addInvoiceLine: vi.fn(async () => ({})),
  removeQuoteLine: vi.fn(async () => ({})),
  removeInvoiceLine: vi.fn(async () => ({})),
  catalogForLookup: vi.fn(async () => ({ parts: BOOK })),
  catalogBook: vi.fn(async () => ({ assetTypes: [], modelsByType: {}, makers: [], today: "2026-09-03" })),
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }) }));

const part = (over: Record<string, unknown>) => ({
  id: 1, partNumber: "", name: "", manufacturer: "", mfrPartNumber: "", kind: "part",
  archived: false, aliases: [], photoUrl: "", vendor: "", priceCents: null, isOem: false,
  rateCents: 0, unit: "", ...over,
});

/** What catalogForLookup would hand a field: things, and the hours beside them. */
const BOOK = [
  part({ id: 1, partNumber: "G6303-80060", name: "Rotor seal", manufacturer: "Agilent", vendor: "Agilent", priceCents: 10000 }),
  part({ id: 2, partNumber: "TZ3O", name: "Travel Zone-3 Overnight", kind: "travel", rateCents: 95000, unit: "trip" }),
  part({ id: 3, partNumber: "LABOR-LCP", name: "Labor, LC/MS Preferred", kind: "labor", rateCents: 18500, unit: "h" }),
];

afterEach(() => { cleanup(); addQuoteLine.mockClear(); });

const draft = async (over: Record<string, unknown> = {}) => {
  const InvoiceLineList = (await import("@/components/InvoiceLineList")).default;
  return render(
    <InvoiceLineList lines={[]} totalCents={0} editable
      target={{ kind: "quote", id: 5 }} partsMarkupBps={4000} {...over} />,
  );
};

/** Type into the number field and take what the book offers. */
const pick = async (into: string, typed: string, offered: RegExp) => {
  fireEvent.change(screen.getByLabelText(into), { target: { value: typed } });
  const row = await screen.findByRole("option", { name: offered });
  fireEvent.click(row);
};

describe("finding a part while building a quote", () => {
  it("offers the book off a number fragment, and off what the thing is called", async () => {
    await draft();
    fireEvent.change(screen.getByLabelText("Part number"), { target: { value: "G6303" } });
    expect(await screen.findByRole("option", { name: /Rotor seal/ })).toBeTruthy();

    // The other half of the row searches the same book: somebody who knows
    // what it is called and not its number ends in the same place.
    fireEvent.change(screen.getByLabelText("Line description"), { target: { value: "rotor" } });
    expect((await screen.findAllByRole("option", { name: /Rotor seal/ })).length).toBeGreaterThan(0);
  });

  it("fills the number, the name and the SELL price on one pick", async () => {
    await draft();
    await pick("Part number", "G6303", /Rotor seal/);
    expect((screen.getByLabelText("Part number") as HTMLInputElement).value).toBe("G6303-80060");
    expect((screen.getByLabelText("Line description") as HTMLInputElement).value).toBe("Rotor seal");
    /*
     * $100 landed cost at a 40% markup is $140. The vendor's $100 is what the
     * SHOP pays; putting it on a quote sells the part at cost. The formula is
     * lib/billing's, so the quote and the invoice that follows it cannot
     * disagree about what a part sells for.
     */
    expect((screen.getByLabelText("Unit price in dollars") as HTMLInputElement).value).toBe("140.00");
  });

  it("shows what it would be quoted at, not what the shop pays for it", async () => {
    await draft();
    fireEvent.change(screen.getByLabelText("Part number"), { target: { value: "G6303" } });
    const row = await screen.findByRole("option", { name: /Rotor seal/ });
    expect(row.textContent).toContain("$140");
    expect(row.textContent).not.toContain("$100");
  });

  it("writes the number onto the line, where the description used to swallow it", async () => {
    await draft();
    await pick("Part number", "G6303", /Rotor seal/);
    fireEvent.click(screen.getByRole("button", { name: "Add line" }));
    await waitFor(() => expect(addQuoteLine).toHaveBeenCalled());
    expect(addQuoteLine.mock.calls[0][1]).toMatchObject({
      kind: "part", partNumber: "G6303-80060", description: "Rotor seal", unitCents: 14000,
    });
  });

  it("leaves a price somebody already typed alone", async () => {
    // A quote is where a shop discounts. A rate typed over is a decision
    // somebody made on this job, and the pick must not undo it.
    await draft();
    fireEvent.change(screen.getByLabelText("Unit price in dollars"), { target: { value: "99" } });
    await pick("Part number", "G6303", /Rotor seal/);
    expect((screen.getByLabelText("Unit price in dollars") as HTMLInputElement).value).toBe("99");
  });

  it("still adds on Enter, the way the plain description field did", async () => {
    // The field grew a dropdown; it must not have stopped being one you can
    // type into and press Enter on.
    await draft();
    fireEvent.change(screen.getByLabelText("Line description"), { target: { value: "Crate and freight" } });
    fireEvent.change(screen.getByLabelText("Unit price in dollars"), { target: { value: "250" } });
    fireEvent.keyDown(screen.getByLabelText("Line description"), { key: "Enter" });
    await waitFor(() => expect(addQuoteLine).toHaveBeenCalled());
  });

  it("still takes a number nobody has catalogued, typed as it stands", async () => {
    // The rule the whole catalog is built around: nothing here may prevent a
    // line being written. A quote must not wait on the parts book.
    await draft();
    fireEvent.change(screen.getByLabelText("Line description"), { target: { value: "Crate and freight" } });
    fireEvent.change(screen.getByLabelText("Unit price in dollars"), { target: { value: "250" } });
    fireEvent.click(screen.getByRole("button", { name: "Add line" }));
    await waitFor(() => expect(addQuoteLine).toHaveBeenCalled());
    expect(addQuoteLine.mock.calls[0][1]).toMatchObject({
      description: "Crate and freight", partNumber: "", unitCents: 25000,
    });
  });
});

describe("hours and trips, quoted off a number", () => {
  it("takes a travel code as a TRAVEL line at its own rate, per trip", async () => {
    await draft();
    // A fragment, not the whole number: a dropdown restating what somebody
    // just typed is noise, so an exact spelling offers nothing.
    await pick("Part number", "TZ3", /Travel Zone-3 Overnight/);
    expect((screen.getByLabelText("Kind of charge") as HTMLSelectElement).value).toBe("travel");
    // Its own rate, untouched by the parts markup - there is no vendor to buy
    // a trip from.
    expect((screen.getByLabelText("Unit price in dollars") as HTMLInputElement).value).toBe("950.00");
    fireEvent.click(screen.getByRole("button", { name: "Add line" }));
    await waitFor(() => expect(addQuoteLine).toHaveBeenCalled());
    expect(addQuoteLine.mock.calls[0][1]).toMatchObject({
      kind: "travel", partNumber: "TZ3O", unit: "trip", qty: 1, unitCents: 95000,
    });
  });

  it("takes a labor code as a LABOR line, billed by the hour", async () => {
    await draft();
    await pick("Line description", "LC/MS", /Labor, LC\/MS Preferred/);
    expect((screen.getByLabelText("Kind of charge") as HTMLSelectElement).value).toBe("labor");
    expect((screen.getByLabelText("Part number") as HTMLInputElement).value).toBe("LABOR-LCP");
    fireEvent.click(screen.getByRole("button", { name: "Add line" }));
    await waitFor(() => expect(addQuoteLine).toHaveBeenCalled());
    expect(addQuoteLine.mock.calls[0][1]).toMatchObject({ kind: "labor", unit: "h", unitCents: 18500 });
  });

  it("prints a flat charge in its own unit rather than claiming an hour", async () => {
    /*
     * The line list read the unit off the KIND, so every travel line said "h"
     * - and a zone-3 overnight quoted per trip printed as "1 h" on a document
     * a client reads.
     */
    await draft({
      lines: [
        { id: 1, kind: "travel", description: "Travel Zone-3 Overnight", detail: "", partNumber: "TZ3O", unit: "trip", qty: 2, unitCents: 95000, covered: false, coveredBy: "" },
        { id: 2, kind: "labor", description: "Labor, LC/MS Preferred", detail: "", partNumber: "LABOR-LCP", unit: "h", qty: 6, unitCents: 18500, covered: false, coveredBy: "" },
        // Written before units existed: it reads exactly as it always did.
        { id: 3, kind: "travel", description: "Travel", detail: "", qty: 3, unitCents: 7500, covered: false, coveredBy: "" },
      ],
      totalCents: 0,
    });
    expect(screen.getByText("2 trip")).toBeTruthy();
    expect(screen.getByText("6 h")).toBeTruthy();
    expect(screen.getByText("3 h")).toBeTruthy();
    // And the number is on the line, for the client's purchasing department.
    expect(screen.getByText("TZ3O")).toBeTruthy();
  });
});

describe("a number the book has never heard of", () => {
  it("is catalogued from the quote, in the form the parts catalog uses", async () => {
    await draft();
    fireEvent.change(screen.getByLabelText("Part number"), { target: { value: "NEW-9000" } });
    fireEvent.change(screen.getByLabelText("Line description"), { target: { value: "Backing pump" } });
    fireEvent.click(screen.getByRole("button", { name: "＋ New part number" }));

    // The same dialog Settings > Parts opens - not a smaller one beside it -
    // arriving filled in with what has already been typed.
    const number = await screen.findByLabelText("Your number *") as HTMLInputElement;
    expect(number.value).toBe("NEW-9000");
    expect((screen.getByPlaceholderText("Agilent 7176 PM Kit") as HTMLInputElement).value)
      .toBe("Backing pump");
  });
});
