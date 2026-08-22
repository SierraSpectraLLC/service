// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import InlineEdit from "@/components/ui/InlineEdit";

afterEach(cleanup);

describe("InlineEdit", () => {
  it("click to edit, Enter saves the changed value", () => {
    const onSave = vi.fn();
    render(<InlineEdit value="Photograph source" label="task title" onSave={onSave} />);
    fireEvent.click(screen.getByRole("button", { name: "Edit task title" }));
    const input = screen.getByRole("textbox", { name: "task title" });
    fireEvent.change(input, { target: { value: "Photograph source before reassembly" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onSave).toHaveBeenCalledWith("Photograph source before reassembly");
    // Back to the view state.
    expect(screen.getByRole("button", { name: "Edit task title" })).toBeTruthy();
  });

  it("Esc cancels without saving", () => {
    const onSave = vi.fn();
    render(<InlineEdit value="two" label="quantity" onSave={onSave} />);
    fireEvent.click(screen.getByRole("button", { name: "Edit quantity" }));
    const input = screen.getByRole("textbox", { name: "quantity" });
    fireEvent.change(input, { target: { value: "three" } });
    fireEvent.keyDown(input, { key: "Escape" });
    expect(onSave).not.toHaveBeenCalled();
    expect(screen.getByText("two")).toBeTruthy();
  });

  it("an unchanged value never fires a save", () => {
    const onSave = vi.fn();
    render(<InlineEdit value="same" label="note" onSave={onSave} />);
    fireEvent.click(screen.getByRole("button", { name: "Edit note" }));
    fireEvent.keyDown(screen.getByRole("textbox", { name: "note" }), { key: "Enter" });
    expect(onSave).not.toHaveBeenCalled();
  });
});
