// @vitest-environment jsdom
//
// Getting a tool onto a shelf through the grid.
//
// The grid asked for a part number and would not save without one, so a torque
// wrench could not be entered at all. What changed is one column - "What" -
// and which cell it makes required. These check the two shapes the shop
// described: the tool nobody has a number for, and the OEM tool that has one.
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const addStockItems = vi.fn(async () => ({ created: 1, updated: 0, failures: [] }));
vi.mock("@/app/actions", () => ({
  addStockItems: (...a: unknown[]) => addStockItems(...(a as [])),
}));

afterEach(cleanup);
beforeEach(() => addStockItems.mockClear());

const draw = async () => {
  const StockGrid = (await import("@/components/StockGrid")).default;
  render(<StockGrid stockroomId={4} knownParts={[]} />);
};

const saveBtn = () => screen.getByText(/^Save /) as HTMLButtonElement;
const type = (label: string, value: string) =>
  fireEvent.change(screen.getByLabelText(label), { target: { value } });

describe("a tool with no part number", () => {
  it("saves on its name alone", async () => {
    await draw();
    type("What, row 1", "tool");
    type("Description, row 1", "4 mm hex key");
    type("On hand, row 1", "3");
    expect(saveBtn().disabled).toBe(false);
    fireEvent.click(saveBtn());
    const [, rows] = addStockItems.mock.calls[0] as unknown as [number, Record<string, string>[]];
    expect(rows).toHaveLength(1);
    expect(rows[0].kind).toBe("tool");
    expect(rows[0].name).toBe("4 mm hex key");
    expect(rows[0].partNumber).toBe("");
  });

  it("will not save a tool nobody named, and says so under the row", async () => {
    await draw();
    type("What, row 1", "tool");
    // Started - there is a number in it - but never named.
    type("Part number, row 1", "G1946-80006");
    expect(screen.getByText(/A tool needs a name/)).toBeTruthy();
    expect(saveBtn().disabled).toBe(true);
    type("Description, row 1", "CDS alignment tool");
    expect(screen.queryByText(/A tool needs a name/)).toBeNull();
    expect(saveBtn().disabled).toBe(false);
  });

  it("keeps an OEM number on a tool that has one", async () => {
    // The hybrid: countable like any tool, orderable like any part.
    await draw();
    type("What, row 1", "tool");
    type("Part number, row 1", "G1946-80006");
    type("Description, row 1", "CDS alignment tool");
    fireEvent.click(saveBtn());
    const [, rows] = addStockItems.mock.calls[0] as unknown as [number, Record<string, string>[]];
    expect(rows[0].partNumber).toBe("G1946-80006");
    expect(rows[0].kind).toBe("tool");
  });
});

describe("a part is still a part", () => {
  it("will not save one without a number", async () => {
    await draw();
    type("Description, row 1", "Some seal");
    expect(screen.getByText(/A part needs a part number/)).toBeTruthy();
    expect(saveBtn().disabled).toBe(true);
    expect(addStockItems).not.toHaveBeenCalled();
  });

  it("saves one with a number, and calls it a part without being told", async () => {
    await draw();
    type("Part number, row 1", "228-35145-91");
    type("Description, row 1", "Plunger seal kit");
    expect(saveBtn().disabled).toBe(false);
    fireEvent.click(saveBtn());
    const [, rows] = addStockItems.mock.calls[0] as unknown as [number, Record<string, string>[]];
    expect(rows[0].kind).toBe("part");
  });
});

describe("the rows nobody filled in", () => {
  it("says nothing about the blank spares the grid ships with", async () => {
    // Three blank rows are the grid's normal state; complaining about each on
    // every keystroke would be noise, not help.
    await draw();
    type("Part number, row 1", "228-35145-91");
    type("Description, row 1", "Plunger seal kit");
    expect(screen.queryByText(/needs a/)).toBeNull();
    fireEvent.click(saveBtn());
    const [, rows] = addStockItems.mock.calls[0] as unknown as [number, Record<string, string>[]];
    expect(rows).toHaveLength(1);
  });
});
