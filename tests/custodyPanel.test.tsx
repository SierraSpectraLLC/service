// @vitest-environment jsdom
//
// The merged card: one Custody panel where a Queue card and an Ownership
// history card used to sit one above the other.
//
// Two things have to survive the merge, and they pull in opposite directions.
// Staff get MORE in one place - both chronologies, both buttons. A client gets
// exactly what they had, which is the queue and nothing about who else has
// owned their machine: the panel key moved from "queue" to "custody" in
// lib/clientView's allow-list, and if the ownership half rode along on that
// rename the merge would have quietly widened what one company can see about
// another. That is the case worth a test.
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/app/actions", () => ({
  kickToQueue: vi.fn(async () => ({})),
  handOffSystem: vi.fn(async () => ({})),
}));

afterEach(cleanup);

const LEGS = [
  { id: 2, fromName: "Sierra Spectra", toName: "Modesto Irrigation District",
    reason: "Maintenance Complete - OK to Run", actor: "jrharris@sierra.test",
    when: "Aug 12, 12:49 PM", at: "2026-08-12T19:49:00.000Z" },
  { id: 1, fromName: "Modesto Irrigation District", toName: "Sierra Spectra",
    reason: "In for annual PM", actor: "jrharris@sierra.test",
    when: "Jul 30, 9:02 AM", at: "2026-07-30T16:02:00.000Z" },
];

const EVENTS = [
  { id: 1, kind: "transfer", fromName: "Puget Diagnostics", toName: "Modesto Irrigation District",
    note: "Sold on, PO 4471", actor: "joe@sierra.test",
    when: "Aug 5, 4:00 PM", at: "2026-08-05T23:00:00.000Z" },
];

const draw = async (over: Record<string, unknown> = {}) => {
  const CustodyPanel = (await import("@/components/CustodyPanel")).default;
  render(<CustodyPanel
    instrumentId={1} externalId="UV-001"
    holderName="Modesto Irrigation District" isMine={false}
    since="Aug 12, 12:49 PM" days={19} reason="Maintenance Complete - OK to Run"
    seenBy="shelli.stclair@modesto.test" seenAt="Aug 31, 2:13 PM"
    legs={LEGS} queueOptions={[{ id: 3, name: "Modesto Irrigation District", kind: "client" }]}
    ourName="Sierra Spectra" canKick
    ownerName="Modesto Irrigation District"
    providers={[]} orgOptions={[{ id: 4, name: "Puget Diagnostics", kind: "client" }]}
    canHandOff events={EVENTS}
    {...over}
  />);
};

describe("both halves in one card", () => {
  it("is one heading where there were two", async () => {
    await draw();
    expect(screen.getByText("Custody")).toBeTruthy();
    expect(screen.queryByText("Queue")).toBeNull();
    expect(screen.queryByText("Ownership history")).toBeNull();
  });

  it("keeps both verbs", async () => {
    await draw();
    expect(screen.getByRole("button", { name: "Move it" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Hand off" })).toBeTruthy();
  });

  it("still says who holds it and who owns it", async () => {
    await draw();
    expect(screen.getByText(/With Modesto Irrigation District/)).toBeTruthy();
    expect(screen.getByText(/Owned by/)).toBeTruthy();
  });

  it("draws one chronology in date order across both axes", async () => {
    await draw();
    // Aug 12 queue leg, Aug 5 handoff, Jul 30 queue leg - which is the story,
    // and is what neither card could show on its own.
    const shown = screen.getAllByText(/Moved queues|Handed on/).map((n) => n.textContent);
    expect(shown).toEqual(["Moved queues", "Handed on", "Moved queues"]);
  });

  it("keeps the read receipt on somebody else's queue", async () => {
    // The one thing the shop could never tell: whether the handback note ever
    // landed with a human.
    await draw();
    expect(screen.getByText(/Seen by shelli.stclair/)).toBeTruthy();
  });
});

describe("what a client gets", () => {
  it("has the queue, exactly as before", async () => {
    await draw({ showOwnership: false, canHandOff: false });
    expect(screen.getByText(/With Modesto Irrigation District/)).toBeTruthy();
    // Twice: as the standing reason, and as the Aug 12 leg that set it.
    expect(screen.getAllByText(/Maintenance Complete - OK to Run/)).toHaveLength(2);
    expect(screen.getAllByText("Moved queues")).toHaveLength(2);
  });

  it("is not shown who else has owned the machine", async () => {
    /*
     * The regression this exists to catch. "custody" replacing "queue" in
     * CLIENT_PANELS is what puts this card on a client's screen at all, and
     * the ownership half is behind showOwnership rather than behind the
     * allow-list - so a change to either one alone must not hand one company
     * the previous owner of another's instrument.
     */
    await draw({ showOwnership: false, canHandOff: false });
    expect(screen.queryByText(/Puget Diagnostics/)).toBeNull();
    expect(screen.queryByText(/Owned by/)).toBeNull();
    expect(screen.queryByText("Handed on")).toBeNull();
  });

  it("gets no hand-off button even if the flag says otherwise", async () => {
    // canHandOff is about permission and showOwnership about visibility. Both
    // have to hold: a button that opens a dialog naming every organization on
    // file is the same leak as the list.
    await draw({ showOwnership: false, canHandOff: true });
    expect(screen.queryByRole("button", { name: "Hand off" })).toBeNull();
  });
});

describe("a system that has been nowhere", () => {
  it("says so rather than drawing an empty heading", async () => {
    await draw({ legs: [], events: [] });
    expect(screen.getByText(/has not changed hands or queues/)).toBeTruthy();
  });
});
