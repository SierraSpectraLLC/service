// @vitest-environment jsdom
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { EntityCard } from "@/components/ui/CardGrid";
import DataTable from "@/components/ui/DataTable";

afterEach(cleanup);

describe("EntityCard anatomy", () => {
  it("keeps the kebab cell even when the card has no kebab", () => {
    const { container } = render(<EntityCard eyebrow="Agilent" title="G6495C" mono meta="LC-MS" />);
    expect(container.querySelector(".ecard-kebab")).toBeTruthy();
    expect(container.querySelector(".ecard-eyebrow")).toBeTruthy();
  });
});

describe("DataTable actions column", () => {
  it("renders the actions cell on every row, action list empty or not", () => {
    const { container } = render(
      <DataTable
        cols={[{ key: "a", label: "A" }]}
        rows={[
          { key: 1, cells: { a: "with" }, actions: [{ label: "Open", onClick: () => {} }] },
          { key: 2, cells: { a: "without" } },
          { key: 3, cells: { a: "empty" }, actions: [] },
        ]} />,
    );
    const rows = Array.from(container.querySelectorAll(".dt-row"));
    expect(rows).toHaveLength(3);
    for (const r of rows) expect(r.querySelector(".dt-acts")).toBeTruthy();
    // And the column track is declared once for all of them.
    const dt = container.querySelector<HTMLElement>(".dt.reg")!;
    expect(dt.style.getPropertyValue("--reg-cols").split(" ").length).toBeGreaterThan(1);
  });
});
