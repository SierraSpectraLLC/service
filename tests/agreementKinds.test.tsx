// @vitest-environment jsdom
//
// Four kinds of paper, four different forms.
//
// The complaint: "the agreement add/edit interface has identical sections for
// service contract, PO, Quote and Invoice. That doesn't make sense." It didn't.
// The panel rendered the same five sections for all four, so a Quote was asked
// for a parts allowance, service visits, PM kits included, labor hours, three
// unlimited toggles, an hourly rate, and how many days before it ends we want
// telling.
//
// Worse than clutter, and this is the part that makes it a bug: NOTHING READ
// ANY OF IT. Both places that resolve coverage gate on kind === "contract"
// (lib/invoiceData), and costingBoard only looks for contracts. The form
// collected entitlements on three kinds and every reader ignored them.
//
// So what is pinned here is that entitlements are a contract's, that the
// AMOUNT survives on every kind under that kind's own word for it, and that
// validation stops refusing to save over a box the kind no longer shows.
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { shapeOf } from "@/lib/agreements";

vi.mock("@/app/actions", () => ({
  saveAgreement: vi.fn(async () => ({})),
  deleteAgreement: vi.fn(async () => ({})),
  setAgreementStatus: vi.fn(async () => ({})),
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }) }));
Element.prototype.scrollIntoView = vi.fn();

afterEach(cleanup);

describe("what each kind of paper has", () => {
  it("gives entitlements to the contract and to nothing else", () => {
    expect(shapeOf("contract").entitlements).toBe(true);
    for (const k of ["po", "quote", "invoice"]) {
      expect(`${k}: ${shapeOf(k).entitlements}`).toBe(`${k}: false`);
    }
  });

  it("gives every kind a figure, under its own word for it", () => {
    // A quote has an amount. It is just not a contract value, and calling it
    // one is how the same form came to look right for all four.
    expect(shapeOf("contract").amountLabel).toBe("Contract value ($)");
    expect(shapeOf("quote").amountLabel).toBe("Quoted amount ($)");
    expect(shapeOf("po").amountLabel).toBe("PO amount ($)");
    expect(shapeOf("invoice").amountLabel).toBe("Invoice amount ($)");
  });

  it("names the two dates for what they are on that paper", () => {
    expect([shapeOf("quote").startLabel, shapeOf("quote").endLabel]).toEqual(["Quoted", "Valid until"]);
    expect([shapeOf("invoice").startLabel, shapeOf("invoice").endLabel]).toEqual(["Invoiced", "Due"]);
    expect([shapeOf("contract").startLabel, shapeOf("contract").endLabel]).toEqual(["Starts", "Ends"]);
  });

  it("keeps a renewal notice only where something lapses", () => {
    // A contract, a PO and a quote all run out and all want chasing first. An
    // invoice does not lapse, it falls due - a renewal notice on one is a
    // reminder about the wrong event.
    expect([shapeOf("contract").renewal, shapeOf("po").renewal, shapeOf("quote").renewal])
      .toEqual([true, true, true]);
    expect(shapeOf("invoice").renewal).toBe(false);
  });

  it("reads an unknown kind as the widest shape, so nothing hides", () => {
    // A row carrying a kind this build has never heard of shows everything
    // rather than silently dropping fields somebody filled in.
    expect(shapeOf("").entitlements).toBe(true);
    expect(shapeOf("subscription").entitlements).toBe(true);
  });
});

const openForm = async (kind?: string) => {
  const AgreementsPanel = (await import("@/components/AgreementsPanel")).default;
  render(<AgreementsPanel rows={[]} orgs={[{ id: 3, name: "Federon" }]}
    canEdit today="2026-08-31" operatorName="Sierra Spectra" />);
  fireEvent.click(screen.getByRole("button", { name: /Agreement$/ }));
  if (kind) fireEvent.click(screen.getByRole("button", { name: kind }));
};

/** Number and title, which every kind needs before a rule further down is
    what the footer is complaining about. */
const fillRequired = (numberHint: string, titleHint: string) => {
  fireEvent.change(screen.getByPlaceholderText(numberHint), { target: { value: "Q-118" } });
  fireEvent.change(screen.getByPlaceholderText(titleHint), { target: { value: "Source rebuild" } });
};

describe("the form the shop actually sees", () => {
  it("asks a contract for everything it always did", async () => {
    await openForm();
    expect(screen.getByLabelText("Labor hours included")).toBeTruthy();
    expect(screen.getByText("Parts allowance ($)")).toBeTruthy();
    expect(screen.getByText("Service visits")).toBeTruthy();
    expect(screen.getByText("Who provides the service")).toBeTruthy();
    expect(screen.getByText("Tell me this many days before it ends")).toBeTruthy();
    expect(screen.getByText("Contract value ($)")).toBeTruthy();
  });

  it("stops asking a quote about visits, parts, labor and kits", async () => {
    // The reported nonsense, gone: a quote is a number and two dates.
    await openForm("Quote");
    expect(screen.queryByLabelText("Labor hours included")).toBeNull();
    expect(screen.queryByText("Parts allowance ($)")).toBeNull();
    expect(screen.queryByText("Service visits")).toBeNull();
    expect(screen.queryByText("PM kits included")).toBeNull();
    expect(screen.queryByText("Hourly rate ($/hr)")).toBeNull();
    expect(screen.queryByLabelText(/Unlimited labor/)).toBeNull();
    // What it keeps: the figure, under its own name.
    expect(screen.getByText("Quoted amount ($)")).toBeTruthy();
    expect(screen.getByLabelText("Valid until")).toBeTruthy();
  });

  it("does not offer an invoice a renewal notice", async () => {
    await openForm("Invoice");
    expect(screen.queryByText("Tell me this many days before it ends")).toBeNull();
    expect(screen.getByLabelText("Due")).toBeTruthy();
  });

  it("does not ask a purchase order who provides the service", async () => {
    // Coverage resolves a provider off a contract and off nothing else, so
    // this was an answer nobody would ever read.
    await openForm("Purchase order");
    expect(screen.queryByText("Who provides the service")).toBeNull();
    expect(screen.getByText("PO amount ($)")).toBeTruthy();
  });

  it("stops offering a quote a contract's example number and title", async () => {
    // Small, and the same mistake in miniature: "PO-4417" was the number hint
    // on all four, including the contract it is not an example of.
    await openForm("Quote");
    expect(screen.getByPlaceholderText("Q-2026-118")).toBeTruthy();
    expect(screen.getByPlaceholderText("What was quoted")).toBeTruthy();
  });

  it("renames the section rather than leaving a kind with no home for its figure", async () => {
    await openForm("Quote");
    // "What's included" would be a lie over a single amount box.
    expect(screen.queryByText("What's included")).toBeNull();
    expect(screen.getAllByText("Amount").length).toBeGreaterThan(0);
  });
});

describe("validation follows the form", () => {
  it("will not refuse a save over a box the kind stopped showing", async () => {
    /*
     * The trap in any conditional form: type 40 hours as a contract, switch to
     * Quote, and the draft still carries "40" in a field that is no longer on
     * screen. Validating it would block the save on something nobody can see
     * to fix. Here the bad value is a non-numeric one, which as a contract is
     * a real refusal.
     */
    await openForm();
    fillRequired("AGR-2026-01", "Annual service contract - 4 systems");
    fireEvent.change(screen.getByLabelText("Labor hours included"), { target: { value: "about forty" } });
    expect(screen.getByText(/Labor hours included must be a number/)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Quote" }));
    expect(screen.queryByText(/must be a number/)).toBeNull();
  });

  it("still refuses a figure that is not a number, on every kind", async () => {
    await openForm("Quote");
    fillRequired("Q-2026-118", "What was quoted");
    fireEvent.change(screen.getByLabelText("Quoted amount ($)"), { target: { value: "lots" } });
    expect(screen.getByText(/Quoted amount must be a number/)).toBeTruthy();
  });
});
