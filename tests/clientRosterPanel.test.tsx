// @vitest-environment jsdom
//
// The client roster, as each reader gets it.
//
// The shop's ask was "I want my engineers to see clients as well". The two
// things that made that more than a nav line are asserted here: an engineer
// can add a company (addOrg has always been requireStaff - only the page the
// form sat on was owner-only), and an engineer's rows do not link to the
// organization record, because that page IS the owner's and a row leading to a
// redirect is worse than a row that does not lead anywhere.
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const addOrg = vi.fn(async () => ({}));
vi.mock("@/app/actions", () => ({ addOrg: (...a: unknown[]) => addOrg(...(a as [])) }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }));

afterEach(cleanup);
beforeEach(() => addOrg.mockClear());

const ROWS = [
  { id: 1, name: "Lab Zen", kind: "client", themeColor: "", prospect: false, systems: 2, sites: 1, openWork: 0 },
  { id: 2, name: "Testen", kind: "client", themeColor: "", prospect: false, systems: 0, sites: 0, openWork: 0 },
];

const draw = async (over: { canOpen?: boolean; canAdd?: boolean } = {}) => {
  const Panel = (await import("@/components/ClientRosterPanel")).default;
  return render(
    <Panel rows={ROWS} filter={{ q: "", kind: "" }}
      canOpen={over.canOpen ?? false} canAdd={over.canAdd ?? true} />,
  );
};

/** The row a company's name sits in - a link, or a plain div. */
const rowFor = (name: string) => screen.getByText(name).closest(".dt-row")!;

describe("what an engineer gets", () => {
  it("lists the companies with what we look after for each", async () => {
    // The counts are on the ROW because most readers never get the click.
    await draw();
    expect(within(rowFor("Lab Zen") as HTMLElement).getByText("2 systems · 1 site")).toBeTruthy();
    expect(within(rowFor("Testen") as HTMLElement).getByText("nothing of ours yet")).toBeTruthy();
  });

  it("leads nowhere rather than to a page they would be bounced from", async () => {
    await draw({ canOpen: false });
    expect(rowFor("Lab Zen").tagName).not.toBe("A");
    expect(rowFor("Lab Zen").getAttribute("href")).toBeNull();
  });

  it("lets them add a company - the verb was always theirs", async () => {
    /*
     * addOrg is requireStaff and says why in its own comment: a service
     * company's clients are theirs to create rather than something they file a
     * request for. The only thing stopping an engineer was which page held the
     * form.
     */
    await draw({ canAdd: true });
    fireEvent.change(screen.getByLabelText("New company name"), { target: { value: "Acme Labs" } });
    fireEvent.click(screen.getByText("Add"));
    await waitFor(() => expect(addOrg).toHaveBeenCalledWith("Acme Labs", "client"));
  });

  it("adds a provider when that is what they picked", async () => {
    await draw({ canAdd: true });
    fireEvent.change(screen.getByLabelText("New company name"), { target: { value: "Cascade" } });
    fireEvent.change(screen.getByLabelText("What kind"), { target: { value: "provider" } });
    fireEvent.click(screen.getByText("Add"));
    await waitFor(() => expect(addOrg).toHaveBeenCalledWith("Cascade", "provider"));
  });

  it("will not send a nameless company", async () => {
    await draw({ canAdd: true });
    expect((screen.getByText("Add") as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("New company name"), { target: { value: "   " } });
    expect((screen.getByText("Add") as HTMLButtonElement).disabled).toBe(true);
    expect(addOrg).not.toHaveBeenCalled();
  });

  it("is not pointed at a Settings room it cannot open", async () => {
    await draw({ canOpen: false });
    expect(screen.queryByText(/Settings/)).toBeNull();
  });
});

describe("what the owner gets on top", () => {
  it("opens the company's record from the row", async () => {
    await draw({ canOpen: true });
    expect(rowFor("Lab Zen").getAttribute("href")).toBe("/settings/organizations/1");
  });

  it("is told where the sign-ins and sharing live", async () => {
    // The other half of the same subject: this room is the roster, that one is
    // the configuration.
    await draw({ canOpen: true });
    expect(screen.getByText(/Settings › Clients & orgs/)).toBeTruthy();
  });
});

describe("a reader who may not create one", () => {
  it("gets the list without the form", async () => {
    await draw({ canAdd: false });
    expect(screen.getByText("Lab Zen")).toBeTruthy();
    expect(screen.queryByLabelText("New company name")).toBeNull();
  });
});
