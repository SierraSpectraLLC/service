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
