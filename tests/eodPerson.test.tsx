// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

// The panel refreshes the route after logging or removing a line, so the
// router has to exist even though nothing here navigates.
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));

// The panel imports server actions; none are called by these tests, which only
// render the closed-then-opened dialog and read the field.
vi.mock("@/app/actions", () => ({
  deleteOffSystemWork: vi.fn(), logOffSystemWork: vi.fn(), saveEodUpdate: vi.fn(),
  setEodInternal: vi.fn(), setEodSkip: vi.fn(), sendEodEmail: vi.fn(),
}));

import EodPanel from "@/components/EodPanel";

/**
 * "Who did it" was a text box, and a text box is a way of recording three
 * different people: "Bill", "bill" and "Bill R." all read as a name and none
 * of them is a link to an account. The directory already knows who exists and
 * who this viewer may name; the field asks it.
 *
 * The picker is the convenience. The rule is in the action, which checks the
 * same set - see logOffSystemWork. A dropdown alone would still accept
 * anything a crafted request sent.
 */
afterEach(cleanup);

const people = [
  { name: "Bill Reyes", org: "Sierra Spectra" },
  { name: "Ada Cole", org: "Sierra Spectra" },
  { name: "Maria Chen", org: "Lab Zen" },
];

const open = (over: Partial<React.ComponentProps<typeof EodPanel>> = {}) => {
  render(
    <EodPanel clientName="Lab Zen" orgId={1} entries={[]} dateMDY="08/24/26"
      people={people} me="Ada Cole" {...over} />,
  );
  fireEvent.click(screen.getByRole("button", { name: /Log work/i }));
};

describe("who did it is a lookup, not a text box", () => {
  it("is a select, and offers nobody the directory does not know", () => {
    open();
    const el = document.getElementById("log-person") as HTMLSelectElement;
    expect(el.tagName).toBe("SELECT");
    const offered = Array.from(el.options).map((o) => o.value).filter(Boolean);
    expect(offered.sort()).toEqual(["Ada Cole", "Bill Reyes", "Maria Chen"]);
  });

  it("groups by organization, so ours read apart from a client's", () => {
    open();
    const labels = Array.from(document.querySelectorAll("#log-person optgroup"))
      .map((g) => g.getAttribute("label"));
    expect(labels).toContain("Sierra Spectra");
    expect(labels).toContain("Lab Zen");
  });

  it("starts on whoever is signed in, because that is usually who it was", () => {
    open();
    expect((document.getElementById("log-person") as HTMLSelectElement).value).toBe("Ada Cole");
  });

  it("starts blank when the signed-in name is not one the directory knows", () => {
    // Otherwise the form opens pre-filled with a value the save would refuse.
    open({ me: "Somebody Else" });
    expect((document.getElementById("log-person") as HTMLSelectElement).value).toBe("");
  });

  it("still allows not saying, which is different from saying wrong", () => {
    open();
    const el = document.getElementById("log-person") as HTMLSelectElement;
    expect(Array.from(el.options).some((o) => o.value === "")).toBe(true);
  });

  it("disables itself rather than pretending, when there is nobody to pick", () => {
    open({ people: [] });
    expect((document.getElementById("log-person") as HTMLSelectElement).disabled).toBe(true);
  });
});
