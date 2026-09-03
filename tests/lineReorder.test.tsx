// @vitest-environment jsdom
//
// A grip on the left edge of each draft line. Drag it, or focus it and use
// the arrow keys. The order on screen is the order on the paper, and the
// paper argues top to bottom.
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const reorderQuoteLines = vi.fn(async (_id?: number, _ids?: number[]) => ({}));
vi.mock("@/app/actions", () => ({
  reorderQuoteLines: (...a: unknown[]) => reorderQuoteLines(...(a as [])),
  reorderInvoiceLines: vi.fn(async () => ({})),
  addQuoteLine: vi.fn(async () => ({})),
  addInvoiceLine: vi.fn(async () => ({})),
  removeQuoteLine: vi.fn(async () => ({})),
  removeInvoiceLine: vi.fn(async () => ({})),
  setQuoteLineDescription: vi.fn(async () => ({})),
  setInvoiceLineDescription: vi.fn(async () => ({})),
  catalogForLookup: vi.fn(async () => ({ parts: [] })),
  catalogBook: vi.fn(async () => ({ assetTypes: [], modelsByType: {}, makers: [], today: "2026-09-03" })),
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }) }));

afterEach(() => { cleanup(); reorderQuoteLines.mockClear(); vi.useRealTimers(); });

const line = (id: number, description: string) => ({
  id, kind: "part", description, detail: "", partNumber: "",
  qty: 1, unitCents: 100_000, covered: false, coveredBy: "",
});
const LINES = [line(10, "Quattro Ultima"), line(11, "LC-10 HPLC"), line(12, "LC-20 HPLC")];

const draft = async (editable = true) => {
  const InvoiceLineList = (await import("@/components/InvoiceLineList")).default;
  return render(
    <InvoiceLineList lines={LINES} totalCents={300_000} editable={editable}
      target={{ kind: "quote", id: 5 }} />,
  );
};

/** The descriptions, top to bottom, as the screen shows them. */
const shown = () =>
  screen.getAllByRole("button", { name: /^Move line \d+:/ }).map((b) => b.getAttribute("aria-label")!.replace(/^Move line \d+: /, ""));

describe("the grip", () => {
  it("is on every line of a draft, and on none of a sent document", async () => {
    await draft();
    // Three grips (the nudge pair beside each is a separate control).
    expect(screen.getAllByRole("button", { name: /^Move line \d+:/ })).toHaveLength(3);
    cleanup();
    await draft(false);
    expect(screen.queryByRole("button", { name: /^Move line/ })).toBeNull();
  });

  it("moves a line with the arrow keys, and writes once when the hand comes off", async () => {
    vi.useFakeTimers();
    await draft();
    const grip = screen.getByRole("button", { name: "Move line 3: LC-20 HPLC" });
    // Two steps up. The screen moves at once; the write waits for the pause,
    // so walking a line up the page is one audit line and not one per step.
    fireEvent.keyDown(grip, { key: "ArrowUp" });
    fireEvent.keyDown(grip, { key: "ArrowUp" });
    expect(shown()).toEqual(["LC-20 HPLC", "Quattro Ultima", "LC-10 HPLC"]);
    expect(reorderQuoteLines).not.toHaveBeenCalled();
    await act(async () => { vi.advanceTimersByTime(700); });
    expect(reorderQuoteLines).toHaveBeenCalledTimes(1);
    expect(reorderQuoteLines.mock.calls[0]).toEqual([5, [12, 10, 11]]);
  });

  it("does not walk off either end", async () => {
    vi.useFakeTimers();
    await draft();
    fireEvent.keyDown(screen.getByRole("button", { name: "Move line 1: Quattro Ultima" }), { key: "ArrowUp" });
    expect(shown()).toEqual(["Quattro Ultima", "LC-10 HPLC", "LC-20 HPLC"]);
    await act(async () => { vi.advanceTimersByTime(700); });
    expect(reorderQuoteLines).not.toHaveBeenCalled();
  });

  it("drops a dragged line where the bar was, and writes at once", async () => {
    await draft();
    const grip = screen.getByRole("button", { name: "Move line 1: Quattro Ultima" });
    // jsdom has no DataTransfer; the handler only sets effectAllowed on it.
    fireEvent.dragStart(grip, { dataTransfer: { effectAllowed: "" } });
    // Onto the row of line 3, which puts it BEFORE line 3.
    const row3 = screen.getByRole("button", { name: "Move line 3: LC-20 HPLC" }).closest(".line-row")!;
    fireEvent.dragOver(row3);
    fireEvent.drop(row3);
    expect(shown()).toEqual(["LC-10 HPLC", "Quattro Ultima", "LC-20 HPLC"]);
    await waitFor(() => expect(reorderQuoteLines).toHaveBeenCalled());
    expect(reorderQuoteLines.mock.calls[0]).toEqual([5, [11, 10, 12]]);
  });

  it("offers a nudge pair as well, for a finger that cannot drag", async () => {
    // Hidden where there is a hover, shown where there is not - that is CSS;
    // what this pins is that the buttons exist and do the same thing.
    vi.useFakeTimers();
    await draft();
    fireEvent.click(screen.getByRole("button", { name: "Move line 2 down" }));
    expect(shown()).toEqual(["Quattro Ultima", "LC-20 HPLC", "LC-10 HPLC"]);
    expect((screen.getByRole("button", { name: "Move line 1 up" }) as HTMLButtonElement).disabled).toBe(true);
    await act(async () => { vi.advanceTimersByTime(700); });
    expect(reorderQuoteLines.mock.calls[0]).toEqual([5, [10, 12, 11]]);
  });
});
