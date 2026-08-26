import { describe, expect, it } from "vitest";
import { CLIENT_PANELS, clientMaySee, clientOwnTasks } from "@/lib/clientView";

/**
 * Whether the people a task was given to can see it.
 *
 * The bug: five tasks were assigned to a client's own engineer for an install,
 * and nobody at that company could see any of them - the tasks panel was not
 * in the client allow-list at all. The engineer got the email and then had
 * nowhere to go.
 *
 * The fix has two halves and BOTH matter. Showing the panel is not the same as
 * showing every task on the machine: most of them really are the shop's
 * working memory, and a client reading "check whether the old board is still
 * under warranty" learns nothing they can act on. So the panel opens, and what
 * it holds is what their company owes or asked for.
 */

const task = (over: Partial<{ assignee: string; origin: string; title: string }> = {}) => ({
  assignee: "", origin: "", title: "a task", ...over,
});

/* Lab Zen's people, as the directory names them. */
const THEIRS = new Set(["Thomas Reed", "Rita Alvarez"]);

describe("the panel exists at all", () => {
  it("IS IN THE CLIENT ALLOW-LIST - the whole bug was that it was not", () => {
    expect(clientMaySee("tasks")).toBe(true);
    expect(CLIENT_PANELS as readonly string[]).toContain("tasks");
  });

  it("still keeps the shop's working memory out", () => {
    // Hours are what the shop pays itself, the daily update is a note to
    // tomorrow's engineer, the activity log is every field anybody edited.
    for (const k of ["hours", "update", "activity"]) expect(clientMaySee(k), k).toBe(false);
  });
});

describe("which tasks are theirs", () => {
  it("SHOWS A TASK ASSIGNED TO ONE OF THEIR PEOPLE", () => {
    // The reported case. Five install tasks on their engineer.
    const list = [
      task({ assignee: "Thomas Reed", title: "Install new collision cell" }),
      task({ assignee: "Thomas Reed", title: "Set up chiller" }),
    ];
    expect(clientOwnTasks(list, THEIRS)).toHaveLength(2);
  });

  it("hides a task the shop assigned to its own engineer", () => {
    expect(clientOwnTasks([task({ assignee: "Bill Reyes" })], THEIRS)).toEqual([]);
  });

  it("hides a task nobody was given", () => {
    // An unassigned step is the shop thinking out loud. Nobody at that company
    // owes it, so it is not theirs to read.
    expect(clientOwnTasks([task({ assignee: "" })], THEIRS)).toEqual([]);
  });

  it("shows what they raised themselves, assigned or not", () => {
    // Their own question coming back to them. Hiding it would mean reporting a
    // fault and then watching it vanish.
    expect(clientOwnTasks([
      task({ origin: "issue", assignee: "Bill Reyes" }),
      task({ origin: "pm_request", assignee: "" }),
    ], THEIRS)).toHaveLength(2);
  });

  it("does not treat the shop's own origins as theirs", () => {
    for (const origin of ["", "checkout", "pm"]) {
      expect(clientOwnTasks([task({ origin, assignee: "Bill Reyes" })], THEIRS), origin).toEqual([]);
    }
  });

  it("matches the name however it was cased or spaced", () => {
    expect(clientOwnTasks([task({ assignee: "  thomas reed " })], THEIRS)).toHaveLength(1);
  });

  it("matches the qualified form the directory writes when two people share a name", () => {
    // buildDirectory disambiguates "Chris" into "Chris (Lab Zen)" and stores
    // THAT as the assignee, so the roster carries the same string.
    const shared = new Set(["Chris Ma (Lab Zen)"]);
    expect(clientOwnTasks([task({ assignee: "Chris Ma (Lab Zen)" })], shared)).toHaveLength(1);
    expect(clientOwnTasks([task({ assignee: "Chris Ma (Sierra Spectra)" })], shared)).toEqual([]);
  });

  it("shows nothing to a company with nobody on it", () => {
    // An empty roster must not read as "everything matches".
    const list = [task({ assignee: "Bill Reyes" }), task({ assignee: "" })];
    expect(clientOwnTasks(list, new Set())).toEqual([]);
  });

  it("ignores a blank name in the roster rather than matching blank assignees", () => {
    // A directory row with no name would otherwise match every unassigned
    // task on the machine - the whole shop's list, at once.
    expect(clientOwnTasks([task({ assignee: "" })], new Set(["", "  "]))).toEqual([]);
  });

  it("keeps the order the shop put them in", () => {
    // The five install tasks are a sequence; re-sorting them loses the order
    // somebody meant them to be done in.
    const list = ["Collision cell", "Autosampler", "Exhaust", "Chiller", "Roughing pump"]
      .map((title) => task({ assignee: "Thomas Reed", title }));
    expect(clientOwnTasks(list, THEIRS).map((t) => t.title))
      .toEqual(["Collision cell", "Autosampler", "Exhaust", "Chiller", "Roughing pump"]);
  });
});
