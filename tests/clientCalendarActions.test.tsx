// @vitest-environment jsdom
//
// The two things a client can do on their calendar.
//
// The one that needs pinning is the ASK. A date box on a calendar looks like a
// booking, and the shop's rule is that it is not one - a client picking a day
// asks for it, and an engineer is on it only once somebody at the shop says
// so. If this dialog ever stops saying that, somebody stands around on the
// 23rd waiting for a van nobody dispatched. The copy is the feature here, so
// the copy is what is asserted.
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const requestPm = vi.fn(async () => ({ number: "WO-1044" }));
const addCalendarNote = vi.fn(async () => ({ id: 1 }));
vi.mock("@/app/actions", () => ({
  requestPm: (...a: unknown[]) => requestPm(...(a as [])),
  addCalendarNote: (...a: unknown[]) => addCalendarNote(...(a as [])),
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }));

afterEach(cleanup);
beforeEach(() => { requestPm.mockClear(); addCalendarNote.mockClear(); });

const SYSTEMS = [{ id: 7, label: "LZ-1 · LC-MS" }, { id: 8, label: "LZ-2 · GC-MS" }];

const draw = async (over: { systems?: typeof SYSTEMS; month?: string } = {}) => {
  const Actions = (await import("@/components/ClientCalendarActions")).default;
  return render(
    <Actions systems={over.systems ?? SYSTEMS} today="2026-09-04" month={over.month ?? "2026-09"} />,
  );
};

describe("asking for a visit", () => {
  const openAsk = async () => {
    await draw();
    fireEvent.click(screen.getByText("Ask for a visit"));
  };

  it("sends the day they picked, with the system and what they need", async () => {
    await openAsk();
    fireEvent.change(screen.getByLabelText("Which system"), { target: { value: "8" } });
    fireEvent.change(screen.getByLabelText("Preferred day"), { target: { value: "2026-09-23" } });
    fireEvent.change(screen.getByLabelText("What needs doing"), { target: { value: "Bay free that week" } });
    fireEvent.click(screen.getByText("Send the request"));
    await waitFor(() => expect(requestPm).toHaveBeenCalled());
    const [id, data] = requestPm.mock.calls[0] as unknown as [number, Record<string, string>];
    expect(id).toBe(8);
    expect(data.preferredOn).toBe("2026-09-23");
    expect(data.note).toBe("Bay free that week");
  });

  it("says plainly that picking a day is not booking it", async () => {
    /*
     * The whole safety of this feature is one sentence. Without it a date box
     * on a calendar reads as a booking, and the client's next move is to stand
     * around on the 23rd.
     */
    await openAsk();
    expect(screen.getByText(/does not book it/)).toBeTruthy();
    expect(screen.getByText(/once we have confirmed/)).toBeTruthy();
  });

  it("will not send an ask with nothing said in it", async () => {
    await openAsk();
    expect((screen.getByText("Send the request") as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("What needs doing"), { target: { value: "  " } });
    expect((screen.getByText("Send the request") as HTMLButtonElement).disabled).toBe(true);
    expect(requestPm).not.toHaveBeenCalled();
  });

  it("offers maintenance and service work, and sends which", async () => {
    await openAsk();
    fireEvent.change(screen.getByLabelText("What kind"), { target: { value: "service" } });
    fireEvent.change(screen.getByLabelText("What needs doing"), { target: { value: "Move the bracket" } });
    fireEvent.click(screen.getByText("Send the request"));
    await waitFor(() => expect(requestPm).toHaveBeenCalled());
    const [, data] = requestPm.mock.calls[0] as unknown as [number, Record<string, string>];
    expect(data.kind).toBe("service");
  });

  it("points a live fault at the page that takes evidence", async () => {
    // A calendar ask is planned work. Something broken now wants a severity
    // and a photo, which is the button on the system's own page.
    await openAsk();
    expect(screen.getByText(/broken right now/)).toBeTruthy();
  });

  it("is not offered at all to somebody with no systems", async () => {
    // An empty picker is a form that cannot be completed.
    await draw({ systems: [] });
    expect(screen.queryByText("Ask for a visit")).toBeNull();
    expect(screen.getByText("Add a note")).toBeTruthy();
  });
});

describe("writing a note", () => {
  const openNote = async (month?: string) => {
    await draw(month ? { month } : {});
    fireEvent.click(screen.getByText("Add a note"));
  };

  it("sends the span, and says the shop can see it", async () => {
    await openNote();
    fireEvent.change(screen.getByLabelText("What is happening"), { target: { value: "Site closed - audit" } });
    fireEvent.change(screen.getByLabelText("From"), { target: { value: "2026-09-14" } });
    fireEvent.change(screen.getByLabelText("To"), { target: { value: "2026-09-18" } });
    expect(screen.getByText(/service team sees this too/)).toBeTruthy();
    fireEvent.click(screen.getByText("Add it"));
    await waitFor(() => expect(addCalendarNote).toHaveBeenCalled());
    const [data] = addCalendarNote.mock.calls[0] as unknown as [Record<string, string>];
    expect(data).toMatchObject({ onDate: "2026-09-14", endsOn: "2026-09-18", title: "Site closed - audit" });
  });

  it("will not send one with no words on it", async () => {
    await openNote();
    expect((screen.getByText("Add it") as HTMLButtonElement).disabled).toBe(true);
  });

  it("refuses a span that ends before it starts, and says why", async () => {
    await openNote();
    fireEvent.change(screen.getByLabelText("What is happening"), { target: { value: "Audit" } });
    fireEvent.change(screen.getByLabelText("From"), { target: { value: "2026-09-18" } });
    fireEvent.change(screen.getByLabelText("To"), { target: { value: "2026-09-14" } });
    expect(screen.getByText(/cannot end before it starts/)).toBeTruthy();
    expect((screen.getByText("Add it") as HTMLButtonElement).disabled).toBe(true);
  });

  it("defaults into the month being looked at, not into today", async () => {
    /*
     * Somebody three months ahead planning a shutdown is looking at December.
     * Seeding the form with today would file the note in September and leave
     * them wondering where it went.
     */
    await openNote("2026-12");
    expect((screen.getByLabelText("From") as HTMLInputElement).value).toBe("2026-12-01");
  });

  it("seeds today when today is the month on screen", async () => {
    await openNote("2026-09");
    expect((screen.getByLabelText("From") as HTMLInputElement).value).toBe("2026-09-04");
  });
});
