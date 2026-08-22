// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import DataTable from "@/components/ui/DataTable";

afterEach(cleanup);

const cols = [
  { key: "id", label: "WO", width: "90px" },
  { key: "title", label: "Title" },
  { key: "when", label: "Updated", hideMobile: true },
];

describe("DataTable", () => {
  it("declares the column tracks once, on the container", () => {
    const { container } = render(
      <DataTable cols={cols} rows={[{ key: 1, cells: { id: "WO-1", title: "t", when: "2h" } }]} />,
    );
    const dt = container.querySelector<HTMLElement>(".dt.reg")!;
    expect(dt.style.getPropertyValue("--reg-cols")).toBe("90px minmax(100px, 1fr) minmax(100px, 1fr)");
  });

  it("stripes within the group, never counting the heading", () => {
    const { container } = render(
      <DataTable cols={cols} rows={[
        { key: 1, group: "Lab Zen", cells: { id: "a", title: "", when: "" } },
        { key: 2, group: "Lab Zen", cells: { id: "b", title: "", when: "" } },
        { key: 3, group: "Coastal", cells: { id: "c", title: "", when: "" } },
        { key: 4, group: "Coastal", cells: { id: "d", title: "", when: "" } },
      ]} />,
    );
    const rows = Array.from(container.querySelectorAll(".dt-row"));
    // Second row of EACH group is the striped one - the stripe restarts.
    expect(rows.map((r) => r.classList.contains("alt"))).toEqual([false, true, false, true]);
    const groups = Array.from(container.querySelectorAll(".reg-group-name")).map((g) => g.textContent);
    expect(groups).toEqual(["Lab Zen", "Coastal"]);
    expect(container.querySelectorAll(".reg-group-count")[0].textContent).toBe("2");
  });

  it("marks hideMobile columns for the phone reflow", () => {
    const { container } = render(
      <DataTable cols={cols} rows={[{ key: 1, cells: { id: "WO-1", title: "t", when: "2h" } }]} />,
    );
    const row = container.querySelector(".dt-row")!;
    expect(row.querySelectorAll(".reg-cell.hide-m").length).toBe(1);
  });

  it("navigating rows are links; plain rows are not", () => {
    render(
      <DataTable cols={cols} rows={[
        { key: 1, href: "/work/1", cells: { id: "WO-1", title: "go", when: "" } },
        { key: 2, cells: { id: "WO-2", title: "stay", when: "" } },
      ]} />,
    );
    expect(screen.getByRole("link").textContent).toContain("go");
    expect(screen.getAllByText(/stay/)[0].closest("a")).toBeNull();
  });

  it("renders the empty state when told what to say", () => {
    render(<DataTable cols={cols} rows={[]} empty="No work orders yet" />);
    expect(screen.getByText("No work orders yet")).toBeTruthy();
  });
});
