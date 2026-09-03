// @vitest-environment jsdom
//
// The letter, on the two screens that show it: the shop's draft and the
// client's copy.
//
// The five things asked for are one document between them - a person named at
// the top, the address it goes to, a description with shape, a discount with a
// reason, and the shop's own notes at the bottom - and a quote where the client
// reads different numbers from the shop is worse than one that omits them.
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const updateQuoteLetter = vi.fn(async (_id?: number, _patch?: Record<string, unknown>) => ({}));
const setQuoteLineDescription = vi.fn(async (_id?: number, _text?: string) => ({}));
vi.mock("@/app/actions", () => ({
  updateQuoteLetter: (...a: unknown[]) => updateQuoteLetter(...(a as [])),
  setQuoteLineDescription: (...a: unknown[]) => setQuoteLineDescription(...(a as [])),
  setInvoiceLineDescription: vi.fn(async () => ({})),
  addQuoteLine: vi.fn(async () => ({})),
  addInvoiceLine: vi.fn(async () => ({})),
  removeQuoteLine: vi.fn(async () => ({})),
  removeInvoiceLine: vi.fn(async () => ({})),
  catalogForLookup: vi.fn(async () => ({ parts: [] })),
  catalogBook: vi.fn(async () => ({ assetTypes: [], modelsByType: {}, makers: [], today: "2026-09-03" })),
  approveQuote: vi.fn(async () => ({})),
  declineQuote: vi.fn(async () => ({})),
  askAboutQuote: vi.fn(async () => ({})),
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }) }));

afterEach(() => { cleanup(); updateQuoteLetter.mockClear(); setQuoteLineDescription.mockClear(); });

const LETTER = {
  attn: "", greeting: "", clientAddress: "", note: "",
  discountPct: 0, discountCents: 0, discountLabel: "",
};

const card = async (over: Record<string, unknown> = {}, letter: Record<string, unknown> = {}) => {
  const QuoteLetterCard = (await import("@/components/QuoteLetterCard")).default;
  return render(
    <QuoteLetterCard quoteId={5} editable subtotalCents={3_600_000}
      orgName="UCSF Hair Analytical Lab"
      billingAddress={"513 Parnassus Ave.\nSan Francisco, CA 94143"}
      letter={{ ...LETTER, ...letter }} {...over} />,
  );
};

describe("addressing a quote to a person, at an address", () => {
  it("previews the line the document will open with", async () => {
    await card();
    // Nobody named yet: the house sentence, said out loud rather than implied.
    expect(screen.getByText(/Thank you for considering us/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Addressed to"), { target: { value: "Hideaki Nakamura" } });
    expect(screen.getByText(/Hideaki, thank you for considering us/)).toBeTruthy();
  });

  it("says where an empty address will send it, and whose it is", async () => {
    await card();
    expect(screen.getByText(/billing address, so it stays right when they move/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Where it goes"), { target: { value: "Box 41\nRichmond, CA" } });
    // The point of a per-quote address: it does not edit the client's record.
    expect(screen.getByText(/The client's billing address is untouched/)).toBeTruthy();
  });

  it("saves the name, the address and the greeting together", async () => {
    await card();
    fireEvent.change(screen.getByLabelText("Addressed to"), { target: { value: "Hideaki" } });
    fireEvent.change(screen.getByLabelText("Where it goes"), { target: { value: "Box 41\nRichmond, CA" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(updateQuoteLetter).toHaveBeenCalled());
    expect(updateQuoteLetter.mock.calls[0][1]).toMatchObject({
      attn: "Hideaki", clientAddress: "Box 41\nRichmond, CA",
    });
  });
});

describe("taking something off the price", () => {
  it("shows the arithmetic before it is saved", async () => {
    await card();
    fireEvent.click(screen.getByRole("button", { name: "$ off" }));
    fireEvent.change(screen.getByLabelText("Amount off, dollars"), { target: { value: "12000" } });
    // $36,000 less $12,000 is $24,000 - the reference quote, to the dollar.
    expect(screen.getByText(/\$36,000 less \$12,000 = \$24,000/)).toBeTruthy();
    expect(screen.getByText(/The deposit and the invoice follow this number/)).toBeTruthy();
  });

  it("sends a percentage as a percentage, and never both", async () => {
    await card({}, { discountCents: 1_200_000 });
    fireEvent.click(screen.getByRole("button", { name: "% off" }));
    fireEvent.change(screen.getByLabelText("Percent off"), { target: { value: "10" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(updateQuoteLetter).toHaveBeenCalled());
    expect(updateQuoteLetter.mock.calls[0][1]).toMatchObject({ discountPct: 10, discountCents: 0 });
  });

  it("reads back what went out once the quote is sent", async () => {
    await card({ editable: false }, {
      attn: "Hideaki", discountCents: 1_200_000, discountLabel: "Pooled repair part allocation",
      note: "HPLC included",
    });
    // No form on a sent quote - rewriting the discount behind the client is not
    // an edit anybody makes quietly.
    expect(screen.queryByLabelText("Addressed to")).toBeNull();
    expect(screen.getByText(/Pooled repair part allocation: -\$12,000/)).toBeTruthy();
    expect(screen.getByText("HPLC included")).toBeTruthy();
  });
});

describe("the lines, and what the client is shown", () => {
  const line = (over: Record<string, unknown> = {}) => ({
    id: 1, kind: "part", description: "Rotor seal", detail: "", partNumber: "",
    qty: 1, unitCents: 100_000, covered: false, coveredBy: "", ...over,
  });

  it("shows a subtotal, the discount by name, and what is owed", async () => {
    const InvoiceLineList = (await import("@/components/InvoiceLineList")).default;
    render(
      <InvoiceLineList lines={[line({ unitCents: 3_600_000 })]} totalCents={2_400_000} editable={false}
        discount={{ label: "Pooled repair part allocation", cents: 1_200_000 }} />,
    );
    expect(screen.getByText("Subtotal")).toBeTruthy();
    // Three times over on a one-line quote: the unit price, the line's amount,
    // and the subtotal beneath them.
    expect(screen.getAllByText("$36,000")).toHaveLength(3);
    expect(screen.getByText("Pooled repair part allocation")).toBeTruthy();
    expect(screen.getByText("-$12,000")).toBeTruthy();
    expect(screen.getByText("$24,000")).toBeTruthy();
  });

  it("draws no discount rows when nothing came off", async () => {
    const InvoiceLineList = (await import("@/components/InvoiceLineList")).default;
    render(<InvoiceLineList lines={[line()]} totalCents={100_000} editable={false} />);
    expect(screen.queryByText("Subtotal")).toBeNull();
    expect(screen.getByText("Total")).toBeTruthy();
  });

  it("renders a multi-line description as the charge and its detail", async () => {
    const InvoiceLineList = (await import("@/components/InvoiceLineList")).default;
    render(
      <InvoiceLineList editable={false} totalCents={800_000}
        lines={[line({ description: "LC-10 HPLC | Full-Service Unlimited 12mo\n- Shimadzu LC-10 AS\n- Waters 717 Plus" })]} />,
    );
    expect(screen.getByText("LC-10 HPLC | Full-Service Unlimited 12mo")).toBeTruthy();
    expect(screen.getByText("- Shimadzu LC-10 AS")).toBeTruthy();
    expect(screen.getByText("- Waters 717 Plus")).toBeTruthy();
  });

  it("lets a draft's description be reworded in place, newlines and all", async () => {
    const InvoiceLineList = (await import("@/components/InvoiceLineList")).default;
    render(
      <InvoiceLineList editable target={{ kind: "quote", id: 5 }} totalCents={100_000}
        lines={[line()]} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Edit line description" }));
    const box = screen.getByRole("textbox", { name: "line description" });
    fireEvent.change(box, { target: { value: "Rotor seal\n- and the ferrule that goes with it" } });
    fireEvent.blur(box);
    await waitFor(() => expect(setQuoteLineDescription).toHaveBeenCalled());
    expect(setQuoteLineDescription.mock.calls[0][1]).toBe("Rotor seal\n- and the ferrule that goes with it");
  });
});

describe("the client's own copy", () => {
  const clientQuote = async (over: Record<string, unknown> = {}) => {
    const ClientQuote = (await import("@/components/ClientQuote")).default;
    return render(
      <ClientQuote token="t" quoteId={5} number="030190_B" title="Full-Service Unlimited"
        brandName="Sierra Spectra" orgName="UCSF Hair Analytical Lab"
        expiresOn="2026-10-30" depositPct={0} totalCents={2_400_000} onHold={false}
        standing="awaiting" answeredBy="" answeredOn="" feeClause=""
        lines={[{
          id: 1, description: "LC-10 HPLC | Full-Service Unlimited 12mo\n- Shimadzu LC-10 AS",
          detail: "", partNumber: "FSC-LC10-UNL", qty: 1, unitCents: 3_600_000,
          covered: false, coveredBy: "",
        }]}
        {...over} />,
    );
  };

  it("greets them, says where it was sent, and shows what came off", async () => {
    await clientQuote({
      greeting: "Hideaki, thank you for considering us! Here are the specifics of your quote:",
      attn: "Hideaki Nakamura",
      address: ["513 Parnassus Ave.", "San Francisco, CA 94143"],
      discount: { label: "Pooled repair part allocation", cents: 1_200_000 },
      comments: "HPLC Included w/Quattro Ultima cost\nDedicated CA-Based Engineer",
    });
    expect(screen.getByText(/Hideaki, thank you for considering us/)).toBeTruthy();
    expect(screen.getByText("Attn: Hideaki Nakamura")).toBeTruthy();
    expect(screen.getByText("513 Parnassus Ave.")).toBeTruthy();
    expect(screen.getByText("Pooled repair part allocation")).toBeTruthy();
    expect(screen.getByText("-$12,000")).toBeTruthy();
    // The subtotal is the total plus what came off, so the three numbers on the
    // client's page are the three on the shop's.
    expect(screen.getAllByText("$36,000").length).toBeGreaterThan(0);
    expect(screen.getByText("$24,000")).toBeTruthy();
    // And the shop's notes, read BEFORE the approve button.
    expect(screen.getByText(/HPLC Included w\/Quattro Ultima cost/)).toBeTruthy();
    // The modules the charge covers, under the charge.
    expect(screen.getByText("- Shimadzu LC-10 AS")).toBeTruthy();
  });

  it("says none of it when the quote says none of it", async () => {
    await clientQuote();
    expect(screen.queryByText(/thank you for considering us/)).toBeNull();
    expect(screen.queryByText("Subtotal")).toBeNull();
    expect(screen.queryByText(/Comments or special instructions/)).toBeNull();
  });
});
