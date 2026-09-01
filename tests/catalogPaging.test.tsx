// @vitest-environment jsdom
//
// The catalog stops drawing 1,118 cards at once.
//
// Reported, with 1,118 models on file: "the page is astronomically long. We
// need to wrap these tiles into a limited container or something." The list is
// already in memory - what had to shrink is the DOM.
//
// The arithmetic is pinned in tests/paging. What is pinned HERE is the two
// things a paged list gets wrong in the page rather than in the maths: a page
// number that survives a filter change, and a bulk action whose words stop
// matching what it does the moment "listed" means "this page".
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const setVocabManufacturer = vi.fn(async () => ({}));
const inputDialog = vi.fn(async (_opts?: { hint?: string }): Promise<string | null> => null);
vi.mock("@/app/actions", () => ({
  addVocabTerm: vi.fn(async () => ({})),
  addVocabTerms: vi.fn(async () => ({ created: 0 })),
  deleteVocabTerm: vi.fn(async () => ({})),
  setVocabCategories: vi.fn(async () => ({})),
  setVocabManufacturer: (...a: unknown[]) => setVocabManufacturer(...(a as [])),
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }) }));
vi.mock("@vercel/blob/client", () => ({ upload: vi.fn(async () => ({ url: "" })) }));
vi.mock("@/components/ui/ConfirmDialog", async () => {
  const real = await vi.importActual<Record<string, unknown>>("@/components/ui/ConfirmDialog");
  return { ...real, inputDialog: (...a: unknown[]) => inputDialog(...(a as [])), confirmDialog: vi.fn(async () => false) };
});

afterEach(() => { cleanup(); inputDialog.mockClear(); });

const categories = [{ id: 1, name: "LC-MS", systems: 2 }];
const types = [{ id: 1, name: "LC System", models: 200, inUse: 4 }];

/**
 * A catalog the size of the one that was reported.
 *
 * Every model carries a maker, so the order is simply by name. That is not
 * incidental: the grid sorts on `manufacturer || "~"`, and localeCompare puts
 * "~" BEFORE letters, so a fixture with blank makers sorted them to the front
 * and made every "first card" assertion here about the wrong thing.
 */
const many = (n: number) =>
  Array.from({ length: n }, (_, i) => ({
    id: i + 1, assetType: "LC System",
    name: `Model ${String(i + 1).padStart(4, "0")}`,
    categories: ["LC-MS"], manufacturer: "Agilent", inUse: 0, hasPhoto: false,
  }));

/** The same, with a known slice carrying no maker, for the facet's own count. */
const withBlanks = (n: number, blanks: number) =>
  many(n).map((m, i) => (i < blanks ? { ...m, manufacturer: "" } : m));

const draw = async (models: ReturnType<typeof many>) => {
  const CatalogForm = (await import("@/components/CatalogForm")).default;
  return render(<CatalogForm categories={categories} models={models} types={types} makers={["Agilent"]} />);
};

/** The model codes currently drawn as cards. queryAll, because a filter that
    matches nothing is a case these tests are about and getAll throws on it. */
const cards = () => screen.queryAllByRole("link")
  .map((a) => a.textContent ?? "").filter((t) => t.startsWith("Model "));

describe("a catalog of 1,118 does not draw 1,118 cards", () => {
  it("draws one page of them", async () => {
    await draw(many(1118));
    expect(cards()).toHaveLength(48);
    expect(cards()[0]).toBe("Model 0001");
  });

  it("says where you are, and how much there is", async () => {
    await draw(many(1118));
    // The number that was missing: a reader could not tell 48 cards from all
    // of them without scrolling to a bottom that never came.
    expect(screen.getAllByText(/1-48 of 1,118 models/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/page 1 of 24/).length).toBeGreaterThan(0);
  });

  it("steps to the next page", async () => {
    await draw(many(1118));
    fireEvent.click(screen.getAllByRole("button", { name: /Next/ })[0]!);
    expect(cards()[0]).toBe("Model 0049");
    expect(screen.getAllByText(/49-96 of 1,118 models/).length).toBeGreaterThan(0);
  });

  it("offers the control at both ends of a full page", async () => {
    // On a full page the top control has scrolled out of sight by the time
    // somebody wants the next one.
    await draw(many(1118));
    expect(screen.getAllByRole("button", { name: /Next/ })).toHaveLength(2);
  });

  it("draws no control at all when it all fits", async () => {
    // A disabled "1 of 1" beside two dead arrows is chrome asking to be read
    // and then ignored.
    await draw(many(12));
    expect(screen.queryByRole("button", { name: /Next/ })).toBeNull();
    expect(cards()).toHaveLength(12);
  });
});

describe("a filter change goes back to the top", () => {
  it("does not leave a search stranded on page 12", async () => {
    /*
     * The bug this exists for. Walk to a late page, then type - the naive
     * version keeps the page number, slices past the end of four results and
     * draws an empty grid over a filter that matched.
     */
    await draw(many(1118));
    for (let i = 0; i < 11; i++) fireEvent.click(screen.getAllByRole("button", { name: /Next/ })[0]!);
    expect(screen.getAllByText(/page 12 of 24/).length).toBeGreaterThan(0);

    fireEvent.change(screen.getByPlaceholderText(/Model, maker or type/), { target: { value: "Model 0007" } });
    // Model 0007, 0070-0079, 0700-0799 - a real, small set, drawn from its top.
    const after = cards();
    expect(after.length).toBeGreaterThan(0);
    expect(after[0]).toBe("Model 0007");
    // 1118 cards re-rendered eleven times is slow enough to trip the 5s default
    // on a loaded machine. The assertion is unchanged; only the patience is.
  }, 20000);

  it("does the same when a facet is picked", async () => {
    await draw(withBlanks(1118, 280));
    for (let i = 0; i < 5; i++) fireEvent.click(screen.getAllByRole("button", { name: /Next/ })[0]!);
    fireEvent.click(screen.getByRole("button", { name: /Maker not set/ }));
    expect(cards()[0]).toBe("Model 0001");   // the first without a maker
    expect(screen.getAllByText(/1-48 of 280 models/).length).toBeGreaterThan(0);
  });
});

describe("the bulk maker action still means every match", () => {
  it("acts on the whole filtered set, not the page in front of you", async () => {
    /*
     * "Applied to all N models listed" was unambiguous while the list WAS all
     * of them. With a page on screen the same sentence would quietly describe
     * a different action - so it names the number and says the page is not the
     * limit, and the count is the filtered set's.
     */
    await draw(withBlanks(1118, 280));
    fireEvent.click(screen.getByRole("button", { name: /Maker not set/ }));
    fireEvent.click(screen.getByRole("button", { name: /Set maker for all shown/i }));

    expect(inputDialog).toHaveBeenCalledTimes(1);
    const hint = inputDialog.mock.calls[0]![0]?.hint ?? "";
    expect(hint).toContain("280");                       // every match, not 48
    expect(hint).toMatch(/not just the page/);
  });
});

describe("the empty state still reads", () => {
  it("says no match rather than drawing an empty page", async () => {
    await draw(many(1118));
    fireEvent.change(screen.getByPlaceholderText(/Model, maker or type/), { target: { value: "Waters Xevo" } });
    expect(cards()).toHaveLength(0);
    expect(within(document.body).getByText("No models match")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Next/ })).toBeNull();
  });
});

describe("the photos card, which was the taller of the two", () => {
  /*
   * Found by measuring the real page after the grid was paged: it was still
   * 28,873px. The grid was 2,208 of that - the rest was this card, drawing a
   * dashed 4:3 tile for every one of 1,105 catalog entries under the grid that
   * had just been fixed. Paging one of two long lists is not paging the page.
   */
  /* Two makers, so a filter can narrow the list and still leave several
     pages. A filter that collapses to one page proves nothing about the
     reset - pageOf's clamp would produce page 1 either way. */
  const entries = (n: number) =>
    Array.from({ length: n }, (_, i) => ({
      id: i + 1, kind: "model", assetType: "LC System",
      name: `Model ${String(i + 1).padStart(4, "0")}`,
      manufacturer: i % 2 === 0 ? "Agilent" : "Waters",
      hasPhoto: false, photoFraming: "",
    }));

  const photos = async (n: number) => {
    const Card = (await import("@/components/CatalogPhotosCard")).default;
    return render(<Card entries={entries(n)} />);
  };

  const tiles = () => screen.queryAllByRole("button", { name: "+ photo" });

  it("draws a page of tiles rather than one per entry", async () => {
    await photos(1105);
    expect(tiles()).toHaveLength(60);
    expect(screen.getAllByText(/1-60 of 1,105 models/).length).toBeGreaterThan(0);
  });

  it("pages within the section, so the sections below stay reachable", async () => {
    // One page number across all three would cut Models in half and hide
    // Module types and System types behind nineteen presses of Next.
    await photos(1105);
    expect(screen.getByRole("navigation", { name: "Models photos" })).toBeTruthy();
  });

  it("goes back to the top when the filter changes", async () => {
    /*
     * Filtered to a set that STILL spans pages, which is the only version of
     * this that tests anything: narrow it to one page and pageOf's clamp
     * returns page 1 whether or not the reset exists.
     */
    await photos(1105);
    const next = () => screen.getAllByRole("button", { name: /Next/ })[0]!;
    for (let i = 0; i < 4; i++) fireEvent.click(next());
    expect(screen.getAllByText(/page 5 of 19/).length).toBeGreaterThan(0);

    fireEvent.change(screen.getByPlaceholderText(/Filter by model, type or maker/),
      { target: { value: "Waters" } });
    expect(screen.getAllByText(/page 1 of 10/).length).toBeGreaterThan(0);
    expect(tiles()).toHaveLength(60);
  });

  it("still collapses the control when a filter leaves one page", async () => {
    // One name carries 1105 and no other does. The search is
    // punctuation-insensitive, so a looser needle catches 1000-1009 too.
    await photos(1105);
    fireEvent.change(screen.getByPlaceholderText(/Filter by model, type or maker/),
      { target: { value: "Model 1105" } });
    expect(tiles()).toHaveLength(1);
    expect(screen.queryByRole("button", { name: /Next/ })).toBeNull();
  });

  it("draws no control for a catalog that fits", async () => {
    await photos(20);
    expect(tiles()).toHaveLength(20);
    expect(screen.queryByRole("button", { name: /Next/ })).toBeNull();
  });
});
