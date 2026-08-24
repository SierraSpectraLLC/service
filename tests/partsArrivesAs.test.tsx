// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * "Arrives as" asks two questions instead of listing every answer to both.
 *
 * The old picker was one select holding "A part" plus one line per module
 * type - fourteen sentences deep on a phone, and every one of them our
 * vocabulary rather than the shop's. Now the first select answers whether it
 * is even a module, the type list stays folded away until that is yes, and
 * when it opens it is the tenant's own catalog.
 */

vi.mock("@/app/actions", () => ({
  createPart: vi.fn(async () => ({})),
  updatePart: vi.fn(async () => ({})),
  setPartStatus: vi.fn(async () => ({})),
  setPartAsset: vi.fn(async () => ({})),
  deletePart: vi.fn(async () => ({})),
  nameServiceVisit: vi.fn(async () => ({})),
  intakeModule: vi.fn(async () => ({})),
}));

afterEach(cleanup);

const CATALOG = ["Mass Spec", "Autosampler", "Column Compartment"];

const openNewPart = async (moduleTypes: string[]) => {
  const PartsPanel = (await import("@/components/PartsPanel")).default;
  render(
    <PartsPanel target={{ instrumentId: 7, assetId: null }} parts={[]} systemAssets={[]}
      canEdit isStaff showCosts={false} moduleTypes={moduleTypes} />,
  );
  fireEvent.click(screen.getByRole("button", { name: "+ Add" }));
};

describe("Arrives as", () => {
  it("asks one short question, and hides the type list until it is a module", async () => {
    await openNewPart(CATALOG);
    const first = screen.getByLabelText("Arrives as") as HTMLSelectElement;
    expect([...first.options].map((o) => o.textContent)).toEqual([
      "A part - fitted, not listed",
      "A module - joins the asset list on arrival",
    ]);
    expect(first.value).toBe("part");
    expect(screen.queryByLabelText("Module type")).toBeNull();
  });

  it("opens the shop's own catalog once it is a module", async () => {
    await openNewPart(CATALOG);
    fireEvent.change(screen.getByLabelText("Arrives as"), { target: { value: "module" } });
    const which = screen.getByLabelText("Module type") as HTMLSelectElement;
    expect([...which.options].map((o) => o.value)).toEqual(["Autosampler", "Column Compartment", "Mass Spec"]);
    // Choosing "a module" has to LAND on one, or the row saves as a part.
    expect(which.value).toBe("Autosampler");
  });

  it("folds back to a part, forgetting the type", async () => {
    await openNewPart(CATALOG);
    fireEvent.change(screen.getByLabelText("Arrives as"), { target: { value: "module" } });
    fireEvent.change(screen.getByLabelText("Module type"), { target: { value: "Mass Spec" } });
    fireEvent.change(screen.getByLabelText("Arrives as"), { target: { value: "part" } });
    expect(screen.queryByLabelText("Module type")).toBeNull();
    expect((screen.getByLabelText("Arrives as") as HTMLSelectElement).value).toBe("part");
  });

  it("still offers a usable list when the catalog names no types", async () => {
    await openNewPart([]);
    fireEvent.change(screen.getByLabelText("Arrives as"), { target: { value: "module" } });
    const which = screen.getByLabelText("Module type") as HTMLSelectElement;
    expect(which.options.length).toBeGreaterThan(0);
    expect(which.value).toBe("Pump");
  });
});
