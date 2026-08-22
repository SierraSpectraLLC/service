// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import Dialog from "@/components/ui/Dialog";
import { ConfirmHost, confirmDialog } from "@/components/ui/ConfirmDialog";
import { ToastHost, toast } from "@/components/ui/Toast";

/**
 * The Phase 2 keyboard gate, as executable checks rather than a checklist in
 * prose: focus is trapped, Escape closes, scroll is locked, focus returns.
 */

afterEach(cleanup);

const dialog = (open: boolean, onClose = () => {}) => (
  <Dialog open={open} onClose={onClose} title="Test dialog"
    footer={<button type="button">Save</button>}>
    <button type="button">One</button>
    <button type="button">Two</button>
  </Dialog>
);

describe("Dialog keyboard contract", () => {
  it("moves focus into the dialog on open", () => {
    render(dialog(true));
    expect(screen.getByRole("dialog").contains(document.activeElement)).toBe(true);
  });

  it("traps Tab: wraps from last to first and back", () => {
    render(dialog(true));
    const buttons = [
      screen.getByRole("button", { name: "Close" }),
      screen.getByRole("button", { name: "One" }),
      screen.getByRole("button", { name: "Two" }),
      screen.getByRole("button", { name: "Save" }),
    ];
    buttons[3].focus();
    fireEvent.keyDown(document, { key: "Tab" });
    expect(document.activeElement).toBe(buttons[0]);
    fireEvent.keyDown(document, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(buttons[3]);
  });

  it("closes on Escape", () => {
    const onClose = vi.fn();
    render(dialog(true, onClose));
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("locks body scroll while open and restores it after", () => {
    const view = render(dialog(true));
    expect(document.body.style.overflow).toBe("hidden");
    view.rerender(dialog(false));
    expect(document.body.style.overflow).toBe("");
  });

  it("returns focus to the opener on close", () => {
    const opener = document.createElement("button");
    document.body.appendChild(opener);
    opener.focus();
    const view = render(dialog(true));
    expect(document.activeElement).not.toBe(opener);
    view.rerender(dialog(false));
    expect(document.activeElement).toBe(opener);
    opener.remove();
  });
});

describe("confirmDialog", () => {
  it("resolves true when the action is clicked", async () => {
    render(<ConfirmHost />);
    let p: Promise<boolean>;
    act(() => { p = confirmDialog({ title: "Delete 3 files?", action: "Delete 3 files", tone: "bad" }); });
    fireEvent.click(screen.getByRole("button", { name: "Delete 3 files" }));
    await expect(p!).resolves.toBe(true);
  });

  it("resolves false on Cancel and on Escape", async () => {
    render(<ConfirmHost />);
    let p1: Promise<boolean>;
    act(() => { p1 = confirmDialog({ title: "Remove?", action: "Remove" }); });
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await expect(p1!).resolves.toBe(false);

    let p2: Promise<boolean>;
    act(() => { p2 = confirmDialog({ title: "Remove again?", action: "Remove" }); });
    fireEvent.keyDown(document, { key: "Escape" });
    await expect(p2!).resolves.toBe(false);
  });

  it("keeps the existing message text as the body", () => {
    render(<ConfirmHost />);
    act(() => { void confirmDialog({ title: "Decommission #33?", body: "Its history stays.", action: "Decommission" }); });
    expect(screen.getByText("Its history stays.")).toBeTruthy();
    fireEvent.keyDown(document, { key: "Escape" });
  });
});

describe("toast", () => {
  it("shows, stacks, and expires after five seconds", () => {
    vi.useFakeTimers();
    try {
      render(<ToastHost />);
      act(() => { toast({ message: "Saved procedure" }); });
      act(() => { toast({ message: "Part added to PO-118" }); });
      expect(screen.getByText("Saved procedure")).toBeTruthy();
      expect(screen.getByText("Part added to PO-118")).toBeTruthy();
      act(() => { vi.advanceTimersByTime(5100); });
      expect(screen.queryByText("Saved procedure")).toBeNull();
      expect(screen.getByText("Part added to PO-118")).toBeTruthy();
      act(() => { vi.advanceTimersByTime(5100); });
      expect(screen.queryByText("Part added to PO-118")).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("runs the undo and dismisses", () => {
    const undo = vi.fn();
    render(<ToastHost />);
    act(() => { toast({ message: "Decommissioned #33", undo }); });
    fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    expect(undo).toHaveBeenCalledTimes(1);
    expect(screen.queryByText("Decommissioned #33")).toBeNull();
  });
});
