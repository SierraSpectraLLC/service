// @vitest-environment jsdom
//
// Moving between days on the EOD page.
//
// The engineer's report, which is the whole spec: "if I update the EOD for the
// system for yesterday, it takes what I wrote, and also puts it for today's
// work, and vice versa. Looks like the email preview is saying what I want it
// to say though."
//
// That last sentence is the diagnosis. The report is composed on the server,
// per day, from the rows - so it was right. What was wrong was the BOX. Moving
// between days is a router.push to the same route, so this panel is never
// unmounted and its state survives the move; the drafts it keeps were keyed by
// system and author and not by day, so yesterday's text came up in today's box
// and one keystroke saved it onto today.
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }) }));

const saveEodUpdate = vi.fn(async () => undefined);
vi.mock("@/app/actions", () => ({
  deleteOffSystemWork: vi.fn(), logOffSystemWork: vi.fn(),
  saveEodUpdate: (...a: unknown[]) => saveEodUpdate(...(a as [])),
  setEodInternal: vi.fn(), setEodSkip: vi.fn(), sendEodEmail: vi.fn(),
}));

import EodPanel from "@/components/EodPanel";

afterEach(cleanup);
beforeEach(() => { saveEodUpdate.mockClear(); vi.useRealTimers(); });

const YESTERDAY = "2026-09-18";

/** MSP-003, as the engineer's page has it: one system, his own line on it. */
const line = (systemUpdate: string) => ({
  kind: "system" as const, id: 3, externalId: "MSP-003", label: "MSP-003 - SQD",
  systemUpdate, actionItem: "", skipped: false, internal: false,
  written: !!systemUpdate, suggestedUpdate: "", suggestedAction: "",
  eodId: systemUpdate ? 11 : null, author: "bill@sierraspectra.com", by: "bill", mine: true,
});

const draw = (over: Partial<React.ComponentProps<typeof EodPanel>> = {}) =>
  render(
    <EodPanel clientName="Lab Zen" orgId={1} dateMDY="09/19/26"
      me="Bill Harner" entries={[line("")]} {...over} />,
  );

/**
 * A line with nothing on it yet sits behind "show blanks", which is where a
 * new system starts. Clicked once; the toggle is state on the panel and so
 * survives a move between days exactly as the drafts do.
 */
const box = (): HTMLTextAreaElement => {
  const find = () => screen.queryByPlaceholderText(/What happened today/i) as HTMLTextAreaElement | null;
  if (!find()) {
    const toggle = screen.queryByText(/with nothing written yet/i);
    if (toggle) fireEvent.click(toggle);
  }
  const el = find();
  if (!el) throw new Error("no update box on the panel");
  return el;
};

describe("a day's words stay on that day", () => {
  it("does not carry yesterday's text into today's box", () => {
    // He writes up yesterday...
    const view = draw({ writeOn: YESTERDAY, entries: [line("")] });
    fireEvent.change(box(), { target: { value: "Installed the SQD and ran a blank." } });
    expect(box().value).toBe("Installed the SQD and ran a blank.");

    // ...then clicks to today. Same route, so the panel is NOT remounted: the
    // rerender below is what navigation actually does to it.
    view.rerender(
      <EodPanel clientName="Lab Zen" orgId={1} dateMDY="09/19/26"
        me="Bill Harner" entries={[line("")]} writeOn="" />,
    );
    expect(box().value).toBe("");
  });

  it("does not carry today's text back into yesterday's box", () => {
    const view = draw({ entries: [line("")] });
    fireEvent.change(box(), { target: { value: "Tuned the quad." } });

    view.rerender(
      <EodPanel clientName="Lab Zen" orgId={1} dateMDY="09/18/26"
        me="Bill Harner" entries={[line("")]} writeOn={YESTERDAY} />,
    );
    expect(box().value).toBe("");
  });

  it("shows what the server has for the day being read", () => {
    // Yesterday's line is already written. Today's is blank, and stays blank.
    const view = draw({ writeOn: YESTERDAY, entries: [line("Installed the SQD.")] });
    expect(box().value).toBe("Installed the SQD.");

    view.rerender(
      <EodPanel clientName="Lab Zen" orgId={1} dateMDY="09/19/26"
        me="Bill Harner" entries={[line("")]} writeOn="" />,
    );
    expect(box().value).toBe("");
  });

  it("brings back what was typed when he goes back to that day", () => {
    // The state surviving the move is the point of keeping it - an unsent
    // sentence must not be lost by looking at another day. Only the mixing up
    // was wrong.
    const view = draw({ writeOn: YESTERDAY, entries: [line("")] });
    fireEvent.change(box(), { target: { value: "Installed the SQD." } });

    const today = (
      <EodPanel clientName="Lab Zen" orgId={1} dateMDY="09/19/26"
        me="Bill Harner" entries={[line("")]} writeOn="" />
    );
    view.rerender(today);
    expect(box().value).toBe("");

    view.rerender(
      <EodPanel clientName="Lab Zen" orgId={1} dateMDY="09/18/26"
        me="Bill Harner" entries={[line("")]} writeOn={YESTERDAY} />,
    );
    expect(box().value).toBe("Installed the SQD.");
  });
});

describe("a save lands on the day it was typed about", () => {
  it("sends the day the edit was made on, not the day showing when it fires", async () => {
    // The autosave waits ~900ms, which is long enough to click to another day.
    vi.useFakeTimers();
    const view = render(
      <EodPanel clientName="Lab Zen" orgId={1} dateMDY="09/18/26"
        me="Bill Harner" entries={[line("")]} writeOn={YESTERDAY} />,
    );
    fireEvent.change(box(), { target: { value: "Installed the SQD." } });

    view.rerender(
      <EodPanel clientName="Lab Zen" orgId={1} dateMDY="09/19/26"
        me="Bill Harner" entries={[line("")]} writeOn="" />,
    );
    await vi.advanceTimersByTimeAsync(2000);
    vi.useRealTimers();

    expect(saveEodUpdate).toHaveBeenCalledTimes(1);
    const [, data, on] = saveEodUpdate.mock.calls[0] as unknown as [unknown, { systemUpdate: string }, string];
    expect(data.systemUpdate).toBe("Installed the SQD.");
    expect(on).toBe(YESTERDAY);
  });
});
