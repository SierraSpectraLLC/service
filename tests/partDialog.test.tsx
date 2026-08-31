// @vitest-environment jsdom
//
// One form for what a part number IS, opened from two places.
//
// Asked for on the equipment catalog's model page: "It makes my life easier if
// I can just add them here - autoselect the system we've got selected too."
// That tab could only list what was already filed and link out to the parts
// catalog, where the first job was finding this model again among 1,100 and
// ticking it.
//
// The form was 300 lines inside PartCatalogPanel with NO component test, which
// is exactly the wrong shape to lift out of a file - so this is the net that
// extraction needed, written with it. What it pins is the part somebody would
// notice: the seed arrives filled, the fields that were walls of buttons are
// typed now, and a save writes what is on screen.
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const addCatalogPart = vi.fn(async (_d?: { partNumber: string; assetTypes: string[]; models: string[] }) => ({ id: 7 }));
vi.mock("@/app/actions", () => ({
  addCatalogPart: (...a: unknown[]) => addCatalogPart(...(a as [])),
  updateCatalogPart: vi.fn(async () => ({})),
  setKitLines: vi.fn(async () => ({})),
  addPartPhotos: vi.fn(async () => ({})),
  addPartPrices: vi.fn(async () => ({})),
  deletePartPrice: vi.fn(async () => ({})),
  makePartPhotoCover: vi.fn(async () => ({})),
  removePartPhoto: vi.fn(async () => ({})),
  setPartPhotoCaption: vi.fn(async () => ({})),
  importParts: vi.fn(async () => ({ created: 0, updated: 0, problems: [] })),
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }) }));
vi.mock("@vercel/blob/client", () => ({ upload: vi.fn(async () => ({ url: "" })) }));

afterEach(() => { cleanup(); addCatalogPart.mockClear(); });

/** A catalog the size of the one that made these fields unusable. */
const MANY = Array.from({ length: 1100 }, (_, i) => `Model ${String(i + 1).padStart(4, "0")}`);
const modelsByType = { "LC System": ["Prep 150 LC", "Alliance HPLC", ...MANY], Pump: ["RV5"] };
const assetTypes = ["LC System", "Pump", "Mass spec"];

const open = async (seed?: Record<string, unknown>) => {
  const PartDialog = (await import("@/components/PartDialog")).default;
  return render(
    <PartDialog seed={seed} assetTypes={assetTypes} modelsByType={modelsByType}
      makers={["Waters"]} onClose={vi.fn()} />,
  );
};

describe("the fields that used to be walls of buttons", () => {
  it("does not draw an option per model", async () => {
    /*
     * The reported problem: "Right now it's massive since we have 1100+ models
     * input." A button per model put 1,102 of them in a dialog.
     */
    await open();
    const modelButtons = screen.queryAllByRole("button")
      .filter((b) => /^Model \d{4}$/.test(b.textContent ?? ""));
    expect(modelButtons.length).toBeLessThanOrEqual(12);
  });

  it("finds one by typing, and says how many more are behind it", async () => {
    await open();
    fireEvent.change(screen.getByLabelText(/Search specific models/i), { target: { value: "Prep 150" } });
    expect(screen.getByRole("button", { name: "Prep 150 LC" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Alliance HPLC" })).toBeNull();
  });

  it("tells somebody to keep typing rather than paging a search", async () => {
    await open();
    fireEvent.change(screen.getByLabelText(/Search specific models/i), { target: { value: "Model" } });
    expect(screen.getByText(/and \d+ more - keep typing/)).toBeTruthy();
  });

  it("takes the only remaining match on Enter", async () => {
    // With one hit on screen the keyboard already knows what you meant.
    await open();
    const box = screen.getByLabelText(/Search specific models/i);
    fireEvent.change(box, { target: { value: "Alliance" } });
    fireEvent.keyDown(box, { key: "Enter" });
    expect(screen.getByRole("button", { name: "Remove Alliance HPLC" })).toBeTruthy();
  });

  it("keeps what is chosen on screen however long the list is", async () => {
    // The chips are the answer to "what did I pick" - filtering them with the
    // same box that filters the options would make a filled field read empty.
    await open({ models: ["Prep 150 LC"] });
    fireEvent.change(screen.getByLabelText(/Search specific models/i), { target: { value: "zzzz" } });
    expect(screen.getByRole("button", { name: "Remove Prep 150 LC" })).toBeTruthy();
    expect(screen.getByText("Nothing matches that.")).toBeTruthy();
  });

  it("does not offer something already picked", async () => {
    await open({ models: ["Prep 150 LC"] });
    fireEvent.change(screen.getByLabelText(/Search specific models/i), { target: { value: "Prep 150" } });
    // Only the chip, which reads "Prep 150 LC ×".
    expect(screen.queryByRole("button", { name: "Prep 150 LC" })).toBeNull();
  });
});

describe("opening it from a model's own page", () => {
  it("arrives with Suits and Specific models already answered", async () => {
    // The whole ask. The page knows which model it is; the form was asking
    // for the one fact already on screen.
    await open({ assetTypes: ["LC System"], models: ["Prep 150 LC"] });
    expect(screen.getByRole("button", { name: "Remove LC System" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Remove Prep 150 LC" })).toBeTruthy();
  });

  it("saves the seed along with what was typed", async () => {
    await open({ assetTypes: ["LC System"], models: ["Prep 150 LC"] });
    fireEvent.change(screen.getByLabelText(/Your number/i), { target: { value: "WAT-097" } });
    fireEvent.click(screen.getByRole("button", { name: /Save part/ }));
    await screen.findByRole("button", { name: /Save part|Saving/ });
    expect(addCatalogPart).toHaveBeenCalledTimes(1);
    const sent = addCatalogPart.mock.calls[0]![0]!;
    expect(sent.partNumber).toBe("WAT-097");
    expect(sent.assetTypes).toEqual(["LC System"]);
    expect(sent.models).toEqual(["Prep 150 LC"]);
  });

  it("refuses to save without the one thing it needs", async () => {
    await open({ models: ["Prep 150 LC"] });
    expect((screen.getByRole("button", { name: /Save part/ }) as HTMLButtonElement).disabled).toBe(true);
    expect(addCatalogPart).not.toHaveBeenCalled();
  });
});

describe("the several-at-once grid", () => {
  const drawAdd = async () => {
    const ModelPartsAdd = (await import("@/components/ModelPartsAdd")).default;
    return render(
      <ModelPartsAdd assetType="LC System" model="Prep 150 LC"
        assetTypes={assetTypes} modelsByType={modelsByType} makers={["Waters"]} />,
    );
  };

  it("offers both doors on the model's parts tab", async () => {
    await drawAdd();
    expect(screen.getByRole("button", { name: "+ Part number" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "+ Several" })).toBeTruthy();
  });

  it("files every row against the model without asking again", async () => {
    const { importParts } = await import("@/app/actions");
    await drawAdd();
    fireEvent.click(screen.getByRole("button", { name: "+ Several" }));
    fireEvent.change(screen.getByLabelText("Part number, row 1"), { target: { value: "WAT-1" } });
    fireEvent.change(screen.getByLabelText("What it is, row 1"), { target: { value: "Plunger seal" } });
    fireEvent.change(screen.getByLabelText("Part number, row 2"), { target: { value: "WAT-2" } });
    fireEvent.click(screen.getByRole("button", { name: /^File/ }));

    expect(importParts).toHaveBeenCalledTimes(1);
    const rows = (importParts as unknown as { mock: { calls: unknown[][] } }).mock.calls[0]![0] as
      { partNumber: string; fits: string; models: string }[];
    // Two typed rows, not the three blanks the grid opens with.
    expect(rows.map((r) => r.partNumber)).toEqual(["WAT-1", "WAT-2"]);
    for (const r of rows) {
      expect(`${r.fits}|${r.models}`).toBe("LC System|Prep 150 LC");
    }
  });

  it("will not file a grid of blanks", async () => {
    await drawAdd();
    fireEvent.click(screen.getByRole("button", { name: "+ Several" }));
    expect((screen.getByRole("button", { name: /^File/ }) as HTMLButtonElement).disabled).toBe(true);
  });
});
