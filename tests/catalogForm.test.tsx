// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * "Add model" saves the draft the dialog is showing.
 *
 * That sounds like nothing to test, and it was: the dialog's inputs wrote a
 * draft keyed on the open FACET while the save read one keyed on the
 * CATEGORY. From "All" or "Maker not set" - neither of which is a category -
 * those are two different slots, so the save found a blank draft, returned on
 * its own empty-name guard, and the button did nothing at all. No error, no
 * toast, no row. These check the button from every facet, because only two of
 * the four were ever broken.
 */

const addVocabTerm = vi.fn(async () => ({}));
vi.mock("@/app/actions", () => ({
  addVocabTerm: (...a: unknown[]) => addVocabTerm(...(a as [])),
  addVocabTerms: vi.fn(async () => ({ created: 0 })),
  deleteVocabTerm: vi.fn(async () => ({})),
  setVocabCategories: vi.fn(async () => ({})),
  setVocabManufacturer: vi.fn(async () => ({})),
}));

afterEach(cleanup);
beforeEach(() => addVocabTerm.mockClear());

const categories = [{ id: 1, name: "GC-MS", systems: 2 }];
const types = [{ id: 1, name: "Mass Spec", models: 3, inUse: 1 }, { id: 2, name: "Pump", models: 1, inUse: 4 }];
const models = [
  { id: 9, assetType: "Mass Spec", name: "TSQ 8000", categories: ["GC-MS"], manufacturer: "Thermo", inUse: 1, hasPhoto: false },
  { id: 10, assetType: "Pump", name: "RV5", categories: [], manufacturer: "", inUse: 0, hasPhoto: false },
];

const open = async () => {
  const CatalogForm = (await import("@/components/CatalogForm")).default;
  render(<CatalogForm categories={categories} models={models} types={types} makers={["Thermo"]} />);
  fireEvent.click(screen.getByText("+ New model"));
  fireEvent.change(screen.getByLabelText("Model name"), { target: { value: "Quattro Ultima" } });
  fireEvent.change(screen.getByLabelText("Manufacturer"), { target: { value: "Waters" } });
};

describe("Add model from every facet", () => {
  it("saves from All - no category selected", async () => {
    await open();
    fireEvent.click(screen.getByRole("button", { name: "Add Quattro Ultima" }));
    await waitFor(() => expect(addVocabTerm).toHaveBeenCalledTimes(1));
    // No category picked means the model is offered everywhere, not dropped.
    expect(addVocabTerm).toHaveBeenCalledWith("model", "Mass Spec", "Quattro Ultima", [], "Waters");
  });

  it("saves from Maker not set", async () => {
    await open();
    cleanup();
    const CatalogForm = (await import("@/components/CatalogForm")).default;
    render(<CatalogForm categories={categories} models={models} types={types} makers={[]} />);
    fireEvent.click(screen.getAllByRole("button", { name: /Maker not set/ })[0]);
    fireEvent.click(screen.getByText("+ New model"));
    fireEvent.change(screen.getByLabelText("Model name"), { target: { value: "Quattro Ultima" } });
    fireEvent.click(screen.getByRole("button", { name: "Add Quattro Ultima" }));
    await waitFor(() => expect(addVocabTerm).toHaveBeenCalledTimes(1));
    expect(addVocabTerm).toHaveBeenCalledWith("model", "Mass Spec", "Quattro Ultima", [], "");
  });

  it("files under the category when one is the open facet", async () => {
    const CatalogForm = (await import("@/components/CatalogForm")).default;
    render(<CatalogForm categories={categories} models={models} types={types} makers={[]} />);
    fireEvent.click(screen.getAllByRole("button", { name: /GC-MS/ })[0]);
    fireEvent.click(screen.getByText("+ New model"));
    fireEvent.change(screen.getByLabelText("Model name"), { target: { value: "Quattro Ultima" } });
    fireEvent.click(screen.getByRole("button", { name: "Add Quattro Ultima" }));
    await waitFor(() => expect(addVocabTerm).toHaveBeenCalledTimes(1));
    expect(addVocabTerm).toHaveBeenCalledWith("model", "Mass Spec", "Quattro Ultima", ["GC-MS"], "");
  });

  it("carries the module type the dialog is showing", async () => {
    await open();
    fireEvent.change(screen.getByLabelText("Module type"), { target: { value: "Pump" } });
    fireEvent.click(screen.getByRole("button", { name: "Add Quattro Ultima" }));
    await waitFor(() => expect(addVocabTerm).toHaveBeenCalledTimes(1));
    expect(addVocabTerm).toHaveBeenCalledWith("model", "Pump", "Quattro Ultima", [], "Waters");
  });
});

/*
 * Where the add buttons live.
 *
 * They used to sit in a card BELOW the model cards, so on a catalog of
 * seventy-two models the one thing this page is for was off the bottom of the
 * screen. They are in the toolbar now, beside the search box.
 *
 * The DOM order is the assertion that matters and it is not fussiness: the
 * toolbar is a wrapping flex row, and the facet strip is wide enough to take a
 * line of its own, so anything placed after the facets lands a line BELOW the
 * search box rather than beside it. Moving these after the strip would look
 * fine in a component test and wrong on the page.
 */
describe("the add buttons sit beside the search box", () => {
  const draw = async () => {
    const CatalogForm = (await import("@/components/CatalogForm")).default;
    return render(<CatalogForm categories={categories} models={models} types={types} makers={[]} />);
  };

  it("puts both of them inside the toolbar", async () => {
    const { container } = await draw();
    const toolbar = container.querySelector(".toolbar")!;
    expect(toolbar).toBeTruthy();
    expect(toolbar.contains(screen.getByText("+ New model"))).toBe(true);
    expect(toolbar.contains(screen.getByText("+ Several"))).toBe(true);
  });

  it("puts them after the search box and before the facets", async () => {
    const { container } = await draw();
    const search = container.querySelector(".toolbar-search")!;
    const facets = container.querySelector(".facets")!;
    const add = screen.getByText("+ New model");
    // Node.DOCUMENT_POSITION_FOLLOWING === 4: the argument comes after.
    expect(search.compareDocumentPosition(add) & 4).toBeTruthy();
    expect(add.compareDocumentPosition(facets) & 4).toBeTruthy();
  });

  it("opens the several-at-once grid above the model cards, not below them", async () => {
    // A button at the top that unfolds a spreadsheet past seventy cards is a
    // button that appears to do nothing.
    const { container } = await draw();
    expect(screen.queryByText("Add several models")).toBeNull();
    fireEvent.click(screen.getByText("+ Several"));
    const panel = screen.getByText("Add several models");
    const cards = container.querySelector(".cardgrid")!;
    expect(panel.compareDocumentPosition(cards) & 4).toBeTruthy();
    // ...and it closes again from the same button.
    fireEvent.click(screen.getByText("Close grid"));
    expect(screen.queryByText("Add several models")).toBeNull();
  });

  it("leaves no add card stranded at the bottom", async () => {
    await draw();
    expect(screen.queryByText("Add a model")).toBeNull();
  });
});
