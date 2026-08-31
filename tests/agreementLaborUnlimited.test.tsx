// @vitest-environment jsdom
//
// Unlimited labor: the third entitlement finally gets the flag the other two
// had.
//
// The gap, found on a live contract: an "Annual Service Contract - All
// Systems" with unlimited visits, unlimited parts and unlimited labor could
// say the first two and not the third. Labor had a number of hours and nothing
// else, and zero hours means "not part of this agreement" - right for a
// contract that excludes labor, exactly backwards for one that covers all of
// it. The client's own coverage card read "Labor - not part of this agreement"
// underneath two rows saying Unlimited.
//
// Two things are pinned here, because a flag that saves wrong is worse than no
// flag: that the form REFUSES to record a contract as unlimited and capped at
// once (the rule parts already had), and that the client card says what the
// agreement says.
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/app/actions", () => ({
  saveAgreement: vi.fn(async () => ({})),
  deleteAgreement: vi.fn(async () => ({})),
  setAgreementStatus: vi.fn(async () => ({})),
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }) }));
// The sheet scrolls the active step into view; jsdom has no such method.
Element.prototype.scrollIntoView = vi.fn();

afterEach(cleanup);

const AGREEMENT = {
  id: 1,
  title: "Annual Service Contract - All Systems",
  number: "SS-AC-1",
  status: "active",
  startsOn: "2026-03-01",
  endsOn: "2027-02-28",
  renewNoticeDays: 60,
  visitsIncluded: 0,
  visitsUnlimited: true,
  partsAllowanceCents: 0,
  partsUnlimited: true,
  laborIncludedMinutes: 0,
  laborUnlimited: false,
  pmPartsIncluded: true,
  providerName: null,
};

const coverage = async (over: Partial<typeof AGREEMENT> = {}) => {
  const ClientCoverage = (await import("@/components/ClientCoverage")).default;
  return render(
    <ClientCoverage agreements={[{ ...AGREEMENT, ...over }]}
      today="2026-08-31" operatorName="Sierra Spectra" />,
  );
};

describe("what the client is told about labor", () => {
  it("says Unlimited when the contract says unlimited", async () => {
    await coverage({ laborUnlimited: true });
    // Three rows, three answers, and none of them contradicting the paper.
    expect(screen.getAllByText("Unlimited")).toHaveLength(3);
    expect(screen.queryByText("Not part of this agreement")).toBeNull();
  });

  it("is the bug as reported when the flag is off and no hours are set", async () => {
    // The exact contract from the report: unlimited visits and parts, and
    // labor reading as excluded because there was no way to say otherwise.
    await coverage({ laborUnlimited: false, laborIncludedMinutes: 0 });
    expect(screen.getAllByText("Unlimited")).toHaveLength(2);
    expect(screen.getByText("Not part of this agreement")).toBeTruthy();
  });

  it("still counts hours when the contract counts hours", async () => {
    // The flag does not swallow the capped case: a 40-hour contract still
    // reads as 40 hours.
    await coverage({ laborUnlimited: false, laborIncludedMinutes: 2400 });
    expect(screen.getByText("40 hours included")).toBeTruthy();
  });
});

describe("the form will not record a contradiction", () => {
  const openForm = async () => {
    const AgreementsPanel = (await import("@/components/AgreementsPanel")).default;
    render(<AgreementsPanel rows={[]} orgs={[{ id: 3, name: "Puget Diagnostics" }]}
      canEdit today="2026-08-31" operatorName="Sierra Spectra" />);
    fireEvent.click(screen.getByRole("button", { name: /Agreement$/ }));
    /* The footer names ONE problem at a time, in the order the form reads, so
       the required fields have to be satisfied before a rule further down the
       page is the thing it is complaining about. Filling them is also the
       honest path: this is the sequence somebody actually types. */
    // The hints are per-kind now (lib/agreements.AGREEMENT_SHAPE); these are
    // the contract's, which is the kind this form opens on.
    fireEvent.change(screen.getByPlaceholderText("AGR-2026-01"), { target: { value: "SS-AC-1" } });
    fireEvent.change(screen.getByPlaceholderText(/Annual service contract/),
      { target: { value: "Annual Service Contract - All Systems" } });
    // "What's included" is both a rail button and a section heading; the rail
    // button is the one that moves the sheet.
    const step = screen.getAllByRole("button", { name: /What.s included/ })[0];
    if (step) fireEvent.click(step);
  };

  it("refuses labor marked unlimited AND capped, the way parts already did", async () => {
    /*
     * The two together are not a preference, they are a contract that says two
     * different things - and whichever the reader believes, somebody is wrong
     * about a bill. Parts have refused this since they got their flag; labor
     * refuses it on the same sentence pattern.
     */
    await openForm();
    const hours = screen.getByLabelText("Labor hours included") as HTMLInputElement;
    const unlimited = screen.getByLabelText(/Unlimited labor/);

    fireEvent.change(hours, { target: { value: "40" } });
    fireEvent.click(unlimited);
    expect(screen.getByText(/unlimited and capped at once/)).toBeTruthy();
  });

  it("disables the hours box while unlimited is ticked", async () => {
    // The cheaper half of the same guard: the contradiction is hard to type in
    // the first place, so the sentence above is a backstop and not the only
    // thing standing between a shop and a wrong contract.
    await openForm();
    fireEvent.click(screen.getByLabelText(/Unlimited labor/));
    expect((screen.getByLabelText("Labor hours included") as HTMLInputElement).disabled).toBe(true);
  });
});
