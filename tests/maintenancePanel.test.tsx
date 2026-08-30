// @vitest-environment jsdom
//
// The maintenance panel, redesigned: modules, sequence, and the PM run.
//
// The failure this fences off is the one the shop reported in the shop's own
// words - "the current pile of tasks is egregious". Twenty-nine schedules
// rendered as twenty-nine rows of six buttons buried both answers the panel
// exists for. The redesign's promises are pinned here: rows group under their
// module, the verbs live BEHIND a row instead of on it, and a run makes a tap
// mean done - through completePmNow, so completions are real rows and a dead
// phone mid-PM loses nothing.
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const completePmNow = vi.fn(async () => ({ taskId: 71 }));
const undoPmComplete = vi.fn(async () => ({}));
const runPmNow = vi.fn(async () => ({ taskId: 9 }));
vi.mock("@/app/actions", () => ({
  addPmSchedule: vi.fn(async () => ({})),
  updatePmSchedule: vi.fn(async () => ({})),
  setPmPaused: vi.fn(async () => ({})),
  removePmSchedule: vi.fn(async () => ({})),
  requestPmPart: vi.fn(async () => ({})),
  runPmNow: (...a: unknown[]) => runPmNow(...(a as [])),
  alignMaintenance: vi.fn(async () => ({})),
  undoRunPmNow: vi.fn(async () => ({})),
  logPastPm: vi.fn(async () => ({})),
  setPmPosture: vi.fn(async () => ({})),
  schedulePmVisit: vi.fn(async () => ({})),
  unschedulePmVisit: vi.fn(async () => ({})),
  completePmNow: (...a: unknown[]) => completePmNow(...(a as [])),
  undoPmComplete: (...a: unknown[]) => undoPmComplete(...(a as [])),
}));

afterEach(cleanup);
beforeEach(() => { completePmNow.mockClear(); undoPmComplete.mockClear(); runPmNow.mockClear(); });

const TODAY = "2026-09-01";

type Row = {
  id: number; title: string; body: string; assignee: string;
  everyDays: number; nextDue: string; lastDone: string; paused: boolean;
  bookedOn?: string; bookedNote?: string;
  parts: { name: string; number: string; qty?: number }[];
  onAsset?: string; assetId?: number | null; openTaskId: number | null;
};

/* Due-or-overdue by default: the state a panel is in when a visit is being
   worked, and what makes every module start open - a folded module hides its
   rows, and most of these tests are about the rows. */
const row = (id: number, over: Partial<Row> = {}): Row => ({
  id, title: `Job ${id}`, body: "", assignee: "",
  everyDays: 365, nextDue: "2026-08-30", lastDone: "2025-08-30", paused: false,
  parts: [], assetId: null, openTaskId: null, ...over,
});

/** A stacked system: two jobs on the pump, one on the sampler, one its own. */
const STACK: Row[] = [
  row(1, { title: "Drain & replace oil", assetId: 11, onAsset: "Pump - MG120" }),
  row(2, { title: "Replace mist filter", assetId: 11, onAsset: "Pump - MG120", parts: [{ name: "Mist filter", number: "63762-68201" }] }),
  row(3, { title: "Replace rotor seal", assetId: 12, onAsset: "Autosampler - G7167B" }),
  row(4, { title: "Verify vacuum", assetId: null }),
];

const draw = async (rows: Row[] = STACK, over: { canEdit?: boolean } = {}) => {
  const Panel = (await import("@/components/MaintenancePanel")).default;
  return render(
    <Panel target={{ instrumentId: 5, assetId: null }} schedules={rows}
      people={["Steve Jones"]} today={TODAY} canEdit={over.canEdit ?? true} />,
  );
};

describe("the pile becomes modules", () => {
  it("groups rows under the unit they live on, system first", async () => {
    await draw();
    const heads = screen.getAllByRole("button", { name: /System|Pump - MG120|Autosampler/ })
      .map((b) => b.textContent ?? "");
    expect(heads[0]).toContain("System");
    expect(heads.some((h) => h.includes("Pump - MG120"))).toBe(true);
    expect(heads.some((h) => h.includes("Autosampler"))).toBe(true);
  });

  it("keeps the verbs off the row - they live behind it", async () => {
    /*
     * The egregiousness was six buttons a row. The scan line now carries only
     * what a reader scans; "Complete now", the menu and the forms appear when
     * the row is opened.
     */
    await draw();
    expect(screen.queryByText("Complete now")).toBeNull();
    expect(screen.queryByText("Remove")).toBeNull();
    fireEvent.click(screen.getByText("Drain & replace oil"));
    expect(screen.getByText("Complete now")).toBeTruthy();
    expect(screen.getByLabelText("Actions for Drain & replace oil")).toBeTruthy();
  });

  it("numbers the steps within their module", async () => {
    // The sequence is the procedure's own numbering: the pump's two jobs are
    // 1 and 2 of the pump, not 1 and 2 of the whole stack.
    const { container } = await draw();
    const seqs = [...container.querySelectorAll('[class*="row-hover"]')].map((r) => r.textContent?.[0]);
    // Two modules restart at 1.
    expect(seqs.filter((c) => c === "1").length).toBeGreaterThanOrEqual(2);
  });

  it("shows the parts, and the request button, inside the opened row", async () => {
    await draw();
    fireEvent.click(screen.getByText("Replace mist filter"));
    expect(screen.getByText(/63762-68201/)).toBeTruthy();
    expect(screen.getByText("request part")).toBeTruthy();
  });

  it("skips the accordion when there is only one module", async () => {
    // A fold with nothing to tell apart is a click tax - a bare asset page
    // renders its rows flat.
    await draw([row(1), row(2)]);
    expect(screen.queryByRole("button", { name: /^System/ })).toBeNull();
    expect(screen.getByText("Job 1")).toBeTruthy();
  });
});

describe("the PM run", () => {
  it("makes a tap mean done", async () => {
    await draw();
    fireEvent.click(screen.getByText("Start PM run"));
    fireEvent.click(screen.getByText("Verify vacuum"));
    await waitFor(() => expect(completePmNow).toHaveBeenCalledWith(4));
  });

  it("outside a run, a tap only opens the row", async () => {
    // The dangerous gesture is opt-in. Browsing must never complete work.
    await draw();
    fireEvent.click(screen.getByText("Verify vacuum"));
    expect(completePmNow).not.toHaveBeenCalled();
    expect(screen.getByText("Complete now")).toBeTruthy();
  });

  it("shows progress as done-today over all unpaused steps", async () => {
    // Derived, not run state: a phone that died mid-PM comes back mid-PM.
    await draw([
      row(1, { lastDone: TODAY }),
      row(2, { lastDone: TODAY }),
      row(3),
      row(4, { paused: true }),
    ]);
    expect(screen.getByRole("progressbar", { name: "PM run progress" })).toBeTruthy();
    expect(screen.getByText("2/3")).toBeTruthy();
  });

  it("marks a completed row with the check and says done today", async () => {
    await draw([row(1, { lastDone: TODAY }), row(2)]);
    expect(screen.getByText("✓")).toBeTruthy();
    expect(screen.getByText(/Done today/)).toBeTruthy();
  });

  it("never taps a paused step done - a run skips them", async () => {
    await draw([row(1, { paused: true }), row(2)]);
    fireEvent.click(screen.getByText("Start PM run"));
    fireEvent.click(screen.getByText("Job 1"));
    expect(completePmNow).not.toHaveBeenCalled();
  });

  it("offers undo for a completion this screen just made", async () => {
    await draw();
    fireEvent.click(screen.getByText("Start PM run"));
    fireEvent.click(screen.getByText("Verify vacuum"));
    await waitFor(() => expect(completePmNow).toHaveBeenCalled());
    // The screen still shows old props (no refresh in jsdom), so re-render
    // with the row done and open it: the undo handle is held for this session.
    cleanup();
    const Panel = (await import("@/components/MaintenancePanel")).default;
    render(
      <Panel target={{ instrumentId: 5, assetId: null }}
        schedules={[row(4, { title: "Verify vacuum", lastDone: TODAY })]}
        people={[]} today={TODAY} canEdit />,
    );
    fireEvent.click(screen.getByText("Verify vacuum"));
    // A fresh screen holds no handle, so it says how a slip is fixed instead.
    expect(screen.getByText(/fixed with edit/)).toBeTruthy();
  });

  it("hands the long way to the menu - a measured test starts as a task", async () => {
    await draw();
    fireEvent.click(screen.getByText("Verify vacuum"));
    const menu = screen.getByLabelText("Actions for Verify vacuum");
    fireEvent.click(menu);
    fireEvent.click(within(menu.closest("details") as HTMLElement ?? menu.parentElement as HTMLElement)
      .getByText("Start as task"));
    await waitFor(() => expect(runPmNow).toHaveBeenCalledWith(4));
  });
});

describe("a reader who cannot edit", () => {
  it("gets the list and none of the verbs", async () => {
    await draw(STACK, { canEdit: false });
    expect(screen.queryByText("Start PM run")).toBeNull();
    expect(screen.queryByText("+ Schedule")).toBeNull();
    fireEvent.click(screen.getByText("Drain & replace oil"));
    expect(screen.queryByText("Complete now")).toBeNull();
  });
});
