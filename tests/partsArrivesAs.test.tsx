// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * The new-part dialog asks what it is once, in the pill row that was already
 * asking - Part, Consumable, Kit and now Asset - instead of hiding a fourth
 * answer in a select halfway down the form.
 *
 * "Asset" is a VIEW over two columns, not a fourth parts.kind: kind 'part'
 * plus a module type. These pin that down from both directions, because the
 * cost of getting it wrong is a row that saves as a plain part and never
 * offers its intake.
 */

const createPart = vi.fn(async () => ({}));
vi.mock("@/app/actions", () => ({
  createPart: (...a: unknown[]) => createPart(...(a as [])),
  updatePart: vi.fn(async () => ({})),
  setPartStatus: vi.fn(async () => ({})),
  setPartAsset: vi.fn(async () => ({})),
  deletePart: vi.fn(async () => ({})),
  nameServiceVisit: vi.fn(async () => ({})),
  intakeModule: vi.fn(async () => ({})),
  catalogForLookup: vi.fn(async () => ({ parts: [] })),
}));

afterEach(cleanup);

const CATALOG = ["Mass Spec", "Autosampler", "Column Compartment"];
const MODELS = [
  { assetType: "Mass Spec", name: "TSQ 8000", manufacturer: "Thermo" },
  { assetType: "mass spec", name: "Quattro Ultima", manufacturer: "Waters" },
  { assetType: "Autosampler", name: "TriPlus RSH", manufacturer: "Thermo" },
];

const openNewPart = async (opts: { types?: string[]; models?: typeof MODELS; instrumentId?: number | null } = {}) => {
  const PartsPanel = (await import("@/components/PartsPanel")).default;
  render(
    <PartsPanel target={{ instrumentId: opts.instrumentId === undefined ? 7 : opts.instrumentId, assetId: 3 }}
      parts={[]} systemAssets={[]} canEdit isStaff showCosts={false}
      moduleTypes={opts.types ?? CATALOG} moduleModels={opts.models ?? MODELS} />,
  );
  fireEvent.click(screen.getByRole("button", { name: "+ Add" }));
};

const pill = (name: string) => screen.getByRole("button", { name });
const lit = (name: string) => pill(name).style.color === "rgb(255, 255, 255)";

describe("the Asset pill", () => {
  it("sits with the other three, and nothing it needs shows until it is picked", async () => {
    await openNewPart();
    for (const p of ["Part", "Consumable", "Kit", "Asset"]) expect(pill(p)).toBeTruthy();
    expect(lit("Part")).toBe(true);
    expect(screen.queryByLabelText("Module type")).toBeNull();
    expect(screen.queryByLabelText("Catalog model")).toBeNull();
  });

  it("opens the shop's own types, alphabetically, landing on one", async () => {
    await openNewPart();
    fireEvent.click(pill("Asset"));
    expect(lit("Asset")).toBe(true);
    const which = screen.getByLabelText("Module type") as HTMLSelectElement;
    expect([...which.options].map((o) => o.value)).toEqual(["Autosampler", "Column Compartment", "Mass Spec"]);
    expect(which.value).toBe("Autosampler");
  });

  it("offers the catalog's models for the chosen type, and fills name and maker", async () => {
    await openNewPart();
    fireEvent.click(pill("Asset"));
    fireEvent.change(screen.getByLabelText("Module type"), { target: { value: "Mass Spec" } });
    const models = screen.getByLabelText("Catalog model") as HTMLSelectElement;
    // "mass spec" in the catalog is the same type as "Mass Spec" on the unit.
    expect([...models.options].map((o) => o.textContent))
      .toEqual(["Pick a model...", "Thermo TSQ 8000", "Waters Quattro Ultima"]);
    fireEvent.change(models, { target: { value: "TSQ 8000" } });
    expect((screen.getByLabelText("Part name") as HTMLInputElement).value).toBe("TSQ 8000");
    expect((screen.getByPlaceholderText("Restek") as HTMLInputElement).value).toBe("Thermo");
  });

  it("says nothing about models when the catalog has none of that type", async () => {
    await openNewPart();
    fireEvent.click(pill("Asset"));
    fireEvent.change(screen.getByLabelText("Module type"), { target: { value: "Column Compartment" } });
    expect(screen.queryByLabelText("Catalog model")).toBeNull();
  });

  it("saves as a part that says what it becomes - not a fourth kind", async () => {
    await openNewPart();
    fireEvent.click(pill("Asset"));
    fireEvent.change(screen.getByLabelText("Module type"), { target: { value: "Mass Spec" } });
    fireEvent.change(screen.getByLabelText("Part name"), { target: { value: "TSQ 8000" } });
    fireEvent.click(screen.getByRole("button", { name: "Add unit" }));
    await vi.waitFor(() => expect(createPart).toHaveBeenCalled());
    const [, data] = createPart.mock.calls[0] as unknown as [unknown, { kind: string; moduleKind: string; status: string }];
    expect(data.kind).toBe("part");
    expect(data.moduleKind).toBe("Mass Spec");
    expect(data.status).toBe("Needed");
  });

  it("going back to Part forgets the type, so it saves as a plain part", async () => {
    await openNewPart();
    fireEvent.click(pill("Asset"));
    fireEvent.change(screen.getByLabelText("Module type"), { target: { value: "Mass Spec" } });
    fireEvent.click(pill("Part"));
    expect(lit("Part")).toBe(true);
    expect(screen.queryByLabelText("Module type")).toBeNull();
  });

  it("is not offered where a unit could never land - no system to join", async () => {
    await openNewPart({ instrumentId: null });
    expect(screen.queryByRole("button", { name: "Asset" })).toBeNull();
    for (const p of ["Part", "Consumable", "Kit"]) expect(pill(p)).toBeTruthy();
  });

  it("still offers a usable type list when the catalog names none", async () => {
    await openNewPart({ types: [] });
    fireEvent.click(pill("Asset"));
    expect((screen.getByLabelText("Module type") as HTMLSelectElement).value).toBe("Pump");
  });
});

describe("the button that commits it", () => {
  it("is named after the pill, not after 'part'", async () => {
    await openNewPart();
    expect(screen.getByRole("button", { name: "Add part" })).toBeTruthy();
    fireEvent.click(pill("Consumable"));
    expect(screen.getByRole("button", { name: "Add consumable" })).toBeTruthy();
    fireEvent.click(pill("Kit"));
    expect(screen.getByRole("button", { name: "Add kit" })).toBeTruthy();
    fireEvent.click(pill("Asset"));
    expect(screen.getByRole("button", { name: "Add unit" })).toBeTruthy();
  });
});
