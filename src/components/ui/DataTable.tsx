import Link from "next/link";
import RowActions, { type RowAction } from "@/components/ui/RowActions";
import EmptyState from "@/components/ui/EmptyState";

/**
 * The one table, replacing the ten. Built on the .reg column grid: columns
 * are declared once as grid tracks so the head and every row align, group
 * headings carry the .reg-group weight with a count, and striping is
 * assigned here - within its group, not by nth-child - so a stripe never
 * lands on a heading. Rows with an href navigate whole; rows with actions
 * get a RowActions cluster that reveals on hover (the row carries
 * .row-reveal). On a phone each row reads as a card: the cells wrap into a
 * meta line, hide-m columns drop out, actions pin right - globals.css owns
 * all of that under the .dt scope.
 */
export type DataCol = {
  key: string;
  label: string;
  /** A grid track ("90px", "minmax(150px,1.6fr)"). Default minmax(100px,1fr). */
  width?: string;
  align?: "right";
  hideMobile?: boolean;
};

export type DataRow = {
  key: string | number;
  cells: Record<string, React.ReactNode>;
  /** Rows sharing a group render under one .reg-group heading, in order. */
  group?: string;
  href?: string;
  actions?: RowAction[];
};

export default function DataTable({ cols, rows, empty, actionsWidth = "90px" }: {
  cols: DataCol[];
  rows: DataRow[];
  /** EmptyState title when there are no rows at all. */
  empty?: string;
  actionsWidth?: string;
}) {
  const hasActions = rows.some((r) => (r.actions?.length ?? 0) > 0);
  const tracks = [
    ...cols.map((c) => c.width ?? "minmax(100px, 1fr)"),
    ...(hasActions ? [actionsWidth] : []),
  ].join(" ");
  const grouped = rows.some((r) => r.group != null);

  const cells = (r: DataRow) => (
    <>
      <span className="dt-main">
        {cols.map((c) => (
          <span key={c.key}
            className={`reg-cell${c.hideMobile ? " hide-m" : ""}`}
            style={c.align === "right" ? { textAlign: "right" } : undefined}>
            {r.cells[c.key]}
          </span>
        ))}
      </span>
      {hasActions && (
        <span className="dt-acts">
          {r.actions?.length ? <RowActions items={r.actions} /> : null}
        </span>
      )}
    </>
  );

  const renderRows = (list: DataRow[]) =>
    list.map((r, i) => {
      const cls = `reg-row dt-row${i % 2 === 1 ? " alt" : ""}${r.href ? " row-hover" : ""}${r.actions?.length ? " row-reveal" : ""}`;
      return r.href ? (
        <Link key={r.key} href={r.href} className={cls}>{cells(r)}</Link>
      ) : (
        <div key={r.key} className={cls}>{cells(r)}</div>
      );
    });

  const head = (
    <div className="reg-head" aria-hidden="true">
      {cols.map((c) => (
        <span key={c.key} className={`reg-cell${c.hideMobile ? " hide-m" : ""}`}
          style={c.align === "right" ? { textAlign: "right" } : undefined}>
          {c.label}
        </span>
      ))}
      {hasActions && <span />}
    </div>
  );

  if (rows.length === 0 && empty) {
    return <div className="dt"><div className="dt-empty"><EmptyState title={empty} /></div></div>;
  }

  if (!grouped) {
    return (
      <div className="dt reg" style={{ ["--reg-cols" as string]: tracks }}>
        {head}
        {renderRows(rows)}
      </div>
    );
  }

  // Group in first-appearance order; ungrouped rows gather at the end.
  const order: string[] = [];
  for (const r of rows) {
    const g = r.group ?? "";
    if (!order.includes(g)) order.push(g);
  }
  return (
    <div className="dt reg" style={{ ["--reg-cols" as string]: tracks }}>
      {order.map((g) => {
        const mine = rows.filter((r) => (r.group ?? "") === g);
        return (
          <div key={g || "(ungrouped)"}>
            {g && (
              <div className="reg-group">
                <span className="reg-group-name">{g}</span>
                <span className="reg-group-count">{mine.length}</span>
              </div>
            )}
            {head}
            {renderRows(mine)}
          </div>
        );
      })}
    </div>
  );
}
