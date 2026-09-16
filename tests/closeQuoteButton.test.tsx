// @vitest-environment jsdom
//
// The dialog the shop closes a lost quote in.
//
// What it must get right is the thing the record is FOR: which loss it was,
// and something said about it. "Rejected" and "Not awarded" are the whole
// reason this is a dialog rather than a one-click button - a shop that files
// "they went with the OEM on lead time" under the same word as "your price is
// too high" has thrown away the only question the row was going to answer -
// and a loss saved with an empty reason is a row nobody learns from either.
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const closeQuoteAsLost = vi.fn(async (_id?: number, _data?: Record<string, unknown>) => ({}));
vi.mock("@/app/actions", () => ({
  closeQuoteAsLost: (...a: unknown[]) => closeQuoteAsLost(...(a as [])),
}));
const refresh = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh, push: vi.fn() }) }));

afterEach(() => { cleanup(); closeQuoteAsLost.mockClear(); refresh.mockClear(); });

const openDialog = async () => {
  const CloseQuoteButton = (await import("@/components/CloseQuoteButton")).default;
  render(<CloseQuoteButton quoteId={7} number="Q-1001" />);
  fireEvent.click(screen.getByRole("button", { name: "Mark lost" }));
  return {
    outcome: screen.getByLabelText("Outcome") as HTMLSelectElement,
    heard: screen.getByLabelText("Who told us") as HTMLInputElement,
    reason: screen.getByLabelText("What they said") as HTMLTextAreaElement,
    close: screen.getByRole("button", { name: "Close the quote" }) as HTMLButtonElement,
  };
};

describe("closing a quote as lost", () => {
  it("offers both losses, and starts on the one somebody most often means", async () => {
    const f = await openDialog();
    expect([...f.outcome.options].map((o) => o.textContent)).toEqual(["Rejected", "Not awarded"]);
    expect(f.outcome.value).toBe("declined");
  });

  it("will not save without a reason - the reason IS the record here", async () => {
    const f = await openDialog();
    expect(f.close.disabled).toBe(true);
    expect(screen.getByText(/say what they told us/i)).toBeTruthy();

    fireEvent.change(f.reason, { target: { value: "Went to the OEM on lead time" } });
    await waitFor(() => expect(
      (screen.getByRole("button", { name: "Close the quote" }) as HTMLButtonElement).disabled,
    ).toBe(false));
  });

  it("sends the outcome somebody picked, not the one it opened on", async () => {
    const f = await openDialog();
    fireEvent.change(f.outcome, { target: { value: "unawarded" } });
    fireEvent.change(f.heard, { target: { value: "Dr. Chen" } });
    fireEvent.change(f.reason, { target: { value: "Capital request pulled" } });
    fireEvent.click(screen.getByRole("button", { name: "Close the quote" }));

    await waitFor(() => expect(closeQuoteAsLost).toHaveBeenCalledWith(7, {
      outcome: "unawarded", reason: "Capital request pulled", heardFrom: "Dr. Chen",
    }));
  });

  it("keeps the dialog open and shows what the server said when it refuses", async () => {
    // The action refuses an approved quote, a draft and one already closed. A
    // dialog that closed on the refusal would look like it had worked.
    closeQuoteAsLost.mockResolvedValueOnce({ error: "Q-1001 is already closed as declined." });
    const f = await openDialog();
    fireEvent.change(f.reason, { target: { value: "they went elsewhere" } });
    fireEvent.click(screen.getByRole("button", { name: "Close the quote" }));

    await waitFor(() => expect(screen.getByText("Q-1001 is already closed as declined.")).toBeTruthy());
    expect(screen.getByLabelText("What they said")).toBeTruthy();
    expect(refresh).not.toHaveBeenCalled();
  });
});
