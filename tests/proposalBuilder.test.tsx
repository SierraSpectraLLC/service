// @vitest-environment jsdom
//
// The builder for the long document.
//
// Four sheets, each saved whole. What these pin is the two things the ask was
// actually about - adding a system, and the comparison table building itself
// from the tiers rather than being typed a second time beside them.
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

type SystemArg = { instrumentId: number | null; name: string; model: string; note: string };
type TierArg = { key: string; name: string; annualCents: number };
type SectionArg = { kind: string; heading: string; body: string };

const saveProposalSystems = vi.fn(async (_id?: number, _rows?: SystemArg[]) => ({}));
const saveProposalTiers = vi.fn(async (_id?: number, _rows?: TierArg[]) => ({}));
const saveProposalSections = vi.fn(async (_id?: number, _rows?: SectionArg[]) => ({}));
const updateProposal = vi.fn(async (_id?: number, _patch?: Record<string, unknown>) => ({}));
vi.mock("@/app/actions", () => ({
  saveProposalSystems: (...a: unknown[]) => saveProposalSystems(...(a as [])),
  saveProposalTiers: (...a: unknown[]) => saveProposalTiers(...(a as [])),
  saveProposalSections: (...a: unknown[]) => saveProposalSections(...(a as [])),
  updateProposal: (...a: unknown[]) => updateProposal(...(a as [])),
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }) }));

afterEach(() => {
  cleanup();
  for (const m of [saveProposalSystems, saveProposalTiers, saveProposalSections, updateProposal]) m.mockClear();
});

const TIERS = [
  {
    key: "essential", name: "Essential", annualCents: 3_200_000, bestFor: "GMP work",
    includes: "Two PM visits", notIncluded: "",
    features: "Preventive Maintenance | 2 / year\nOn-Site Escalation | 5 visits included",
  },
  {
    key: "premium", name: "Premium", annualCents: 4_600_000, bestFor: "zero downtime tolerance",
    includes: "Everything in Essential", notIncluded: "",
    features: "Preventive Maintenance | 2 / year\nOn-Site Escalation | Unlimited",
  },
];

const build = async (over: Record<string, unknown> = {}) => {
  const ProposalBuilder = (await import("@/components/ProposalBuilder")).default;
  return render(
    <ProposalBuilder
      proposalId={7} quoteId={5}
      header={{ title: "Service Contract Proposal", subtitle: "", pricingValid: "30 days from issue", recommendedTier: "essential" }}
      systems={[{ instrumentId: null, name: "Sciex TripleTOF", model: "6600", note: "ESI source" }]}
      tiers={TIERS}
      sections={[
        { kind: "prose", heading: "Executive Summary", body: "" },
        { kind: "systems", heading: "Scope of Coverage", body: "" },
        { kind: "tiers", heading: "Coverage Tier Comparison", body: "" },
      ]}
      fleet={[{ id: 41, label: "LC-MS 2 · AV-002", model: "LCMS-8060NX" }]}
      {...over} />,
  );
};

describe("adding a system", () => {
  it("takes one off the client's own fleet, named and modelled already", async () => {
    // The point of picking rather than retyping: a retyped model number is how
    // a proposal covers a machine nobody can find in the record afterwards.
    await build();
    fireEvent.change(screen.getByLabelText("Add one of their systems"), { target: { value: "41" } });
    fireEvent.click(screen.getByRole("button", { name: "Save systems" }));
    await waitFor(() => expect(saveProposalSystems).toHaveBeenCalled());
    const rows = saveProposalSystems.mock.calls[0][1]!;
    expect(rows).toHaveLength(2);
    expect(rows[1]).toEqual({ instrumentId: 41, name: "LC-MS 2 · AV-002", model: "LCMS-8060NX", note: "" });
  });

  it("takes a blank row for a machine the shop has never touched", async () => {
    await build();
    fireEvent.click(screen.getByRole("button", { name: "＋ System" }));
    fireEvent.change(screen.getByLabelText("System 2 instrument"), { target: { value: "Nitrogen Gas Generator" } });
    fireEvent.change(screen.getByLabelText("System 2 notes"), { target: { value: "Inspection and consumable check" } });
    fireEvent.click(screen.getByRole("button", { name: "Save systems" }));
    await waitFor(() => expect(saveProposalSystems).toHaveBeenCalled());
    expect(saveProposalSystems.mock.calls[0][1]![1]).toMatchObject({
      instrumentId: null, name: "Nitrogen Gas Generator", note: "Inspection and consumable check",
    });
  });

  it("drops one off the sheet", async () => {
    await build();
    fireEvent.click(screen.getByRole("button", { name: "Remove system 1" }));
    fireEvent.click(screen.getByRole("button", { name: "Save systems" }));
    await waitFor(() => expect(saveProposalSystems).toHaveBeenCalled());
    expect(saveProposalSystems.mock.calls[0][1]).toEqual([]);
  });
});

describe("the tiers, and the table they make", () => {
  it("shows the comparison the client will read, built from the tiers", async () => {
    await build();
    // Typed once, on the tier. A matrix typed a second time beside them is a
    // document that eventually quotes two different answers for one feature.
    expect(screen.getByText("Annual Investment")).toBeTruthy();
    expect(screen.getByText("$32,000")).toBeTruthy();
    expect(screen.getByText("5 visits included")).toBeTruthy();
    expect(screen.getByText("Unlimited")).toBeTruthy();
  });

  it("re-prices a tier in dollars and sends cents", async () => {
    await build();
    fireEvent.change(screen.getByLabelText("Essential annual investment"), { target: { value: "39500" } });
    fireEvent.click(screen.getByRole("button", { name: "Save tiers" }));
    await waitFor(() => expect(saveProposalTiers).toHaveBeenCalled());
    expect(saveProposalTiers.mock.calls[0][1]![0]).toMatchObject({ key: "essential", annualCents: 3_950_000 });
  });

  it("adds a tier with no key, for the action to derive one from its name", async () => {
    await build();
    fireEvent.click(screen.getByRole("button", { name: "＋ Tier" }));
    fireEvent.click(screen.getByRole("button", { name: "Save tiers" }));
    await waitFor(() => expect(saveProposalTiers).toHaveBeenCalled());
    const rows = saveProposalTiers.mock.calls[0][1]!;
    expect(rows).toHaveLength(3);
    expect(rows[2]).toMatchObject({ key: "", name: "New tier", annualCents: 0 });
  });

  it("opens a tier's words only when asked - four textareas per tier is a wall", async () => {
    await build();
    expect(screen.queryByLabelText(/Comparison column/)).toBeNull();
    fireEvent.click(screen.getAllByRole("button", { name: "edit words" })[0]);
    expect(screen.getByText(/Comparison column/)).toBeTruthy();
  });
});

describe("the sections", () => {
  it("reorders without a code change, which is the point of them being rows", async () => {
    await build();
    fireEvent.click(screen.getByRole("button", { name: "Move section 3 up" }));
    fireEvent.click(screen.getByRole("button", { name: "Save sections" }));
    await waitFor(() => expect(saveProposalSections).toHaveBeenCalled());
    expect(saveProposalSections.mock.calls[0][1]!.map((s) => s.heading))
      .toEqual(["Executive Summary", "Coverage Tier Comparison", "Scope of Coverage"]);
  });

  it("adds a section of words", async () => {
    await build();
    fireEvent.click(screen.getByRole("button", { name: "＋ Section" }));
    fireEvent.click(screen.getByRole("button", { name: "Save sections" }));
    await waitFor(() => expect(saveProposalSections).toHaveBeenCalled());
    expect(saveProposalSections.mock.calls[0][1]![3]).toMatchObject({ kind: "prose", heading: "New section" });
  });

  it("says what the three marks in a body mean, where somebody is typing one", async () => {
    await build();
    fireEvent.click(screen.getAllByRole("button", { name: "edit words" }).at(-1)!);
    expect(screen.getByText(/is a subheading/)).toBeTruthy();
  });
});

describe("the header", () => {
  it("offers only tiers that are on the document to recommend", async () => {
    await build();
    const rec = screen.getByLabelText("What we recommend") as HTMLSelectElement;
    expect([...rec.options].map((o) => o.value)).toEqual(["", "essential", "premium"]);
  });

  it("says out loud that the customer and the quote number are the quote's", async () => {
    // The document's header table cannot drift from the price it argues for,
    // and somebody looking for the field to type the client's name into needs
    // to be told why there isn't one.
    await build();
    expect(screen.getByText(/come from the quote itself/)).toBeTruthy();
  });

  it("warns about a tier nobody has priced", async () => {
    await build({ tiers: [...TIERS, { ...TIERS[0], key: "gmp", name: "GMP Select", annualCents: 0 }] });
    expect(screen.getByText(/GMP Select has no price yet/)).toBeTruthy();
  });
});
