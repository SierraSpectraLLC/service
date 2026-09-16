// @vitest-environment jsdom
//
// The catalog's own pickers read alphabetically.
//
// vocab_terms hands its rows back in the order somebody entered them, which
// is the one order nobody scans a list in: "Roughing Pump" was between
// "Reservoir Tray" and "UV-Vis" on the asset grid, twenty rows down from the
// pumps. CatalogSelect and PickOrAdd have always sorted their own options;
// the two raw selects over the same vocabulary now do too.
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import AssetGrid from "@/components/AssetGrid";
import AssetRegistryFilter from "@/components/AssetRegistryFilter";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: () => {}, refresh: () => {} }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => "/assets",
}));
vi.mock("@/app/actions", () => ({
  createAssets: async () => ({ created: 0 }),
  createAsset: async () => ({ id: 1 }),
}));

/** As the catalog stores them: entry order, not reading order. */
const KINDS = ["TOC", "Console", "Magnet", "Autosampler", "GC", "Roughing Pump", "UV-Vis"];

const optionsOf = (select: HTMLElement) =>
  [...select.querySelectorAll("option")].map((o) => o.textContent).filter((t) => t && t !== "-" && !t.startsWith("All"));

describe("the asset grid", () => {
  it("offers the types in reading order", () => {
    render(<AssetGrid instrumentId={null} kinds={KINDS} models={{}} owners={[]} />);
    expect(optionsOf(screen.getByLabelText("Type, row 1"))).toEqual([
      "Autosampler", "Console", "GC", "Magnet", "Roughing Pump", "TOC", "UV-Vis",
    ]);
  });

  it("offers a type's models in reading order too", () => {
    const models = { TOC: [{ name: "Sievers M9", manufacturer: "" }, { name: "Fusion", manufacturer: "" }] };
    const { container } = render(<AssetGrid instrumentId={null} kinds={["TOC"]} models={models} owners={[]} />);
    const list = container.querySelector("datalist");
    expect([...(list?.querySelectorAll("option") ?? [])].map((o) => o.getAttribute("value")))
      .toEqual(["Fusion", "Sievers M9"]);
  });
});

describe("the registry filter", () => {
  it("offers the kinds in reading order", () => {
    render(<AssetRegistryFilter kind="" status="" owner="" q="" held="" kinds={KINDS} owners={[]} />);
    expect(optionsOf(screen.getByLabelText("Filter by kind"))).toEqual([
      "Autosampler", "Console", "GC", "Magnet", "Roughing Pump", "TOC", "UV-Vis",
    ]);
  });
});
