"use client";

import Dropdown from "@/components/Dropdown";

/**
 * A row's actions: the first couple inline as quiet links, everything in the
 * kebab menu. The inline links reveal on row hover when the row carries
 * .row-reveal (always visible to keyboards and touch - globals.css owns
 * that); the kebab is always there, so nothing is reachable only by pointer.
 * `tone: "bad"` marks a destructive entry red in both places.
 */
export type RowAction = {
  label: string;
  onClick: () => void;
  tone?: "bad";
};

export default function RowActions({ items, inline = 2, menuLabel = "Row actions" }: {
  items: RowAction[];
  /** How many actions also show as inline links before the kebab. */
  inline?: number;
  menuLabel?: string;
}) {
  if (items.length === 0) return null;
  const linked = items.slice(0, inline);
  return (
    <span className="row-acts">
      {linked.map((a) => (
        <button
          key={a.label}
          type="button"
          className={`btn link${a.tone === "bad" ? " danger" : ""}`}
          onClick={a.onClick}
        >
          {a.label}
        </button>
      ))}
      <Dropdown label={<span aria-hidden="true">⋯</span>} ariaLabel={menuLabel} summaryClass="kebab">
        {items.map((a) => (
          <button
            key={a.label}
            type="button"
            className={a.tone === "bad" ? "danger" : undefined}
            onClick={a.onClick}
          >
            {a.label}
          </button>
        ))}
      </Dropdown>
    </span>
  );
}
