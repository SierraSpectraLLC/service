"use client";

import { useState } from "react";

export type ActivityRow = { id: number; actor: string; action: string; field: string; newValue: string; when: string };

const PREVIEW = 8;

export default function ActivityFeed({ items }: { items: ActivityRow[] }) {
  const [expanded, setExpanded] = useState(false);
  const visible = expanded ? items : items.slice(0, PREVIEW);
  const hidden = items.length - PREVIEW;

  return (
    <>
      <div className="stack-3" style={{ borderLeft: "2px solid var(--line)", paddingLeft: 14 }}>
        {visible.map((a) => (
          <div key={a.id}>
            <div className="t-body">
              <b>{a.actor === "sheet-sync" ? "Sheet sync" : a.actor.split("@")[0]}</b>{" "}
              <span className="mut">{a.action}</span>
            </div>
            {a.field === "note" && a.newValue && <div className="t-body" style={{ marginTop: 2 }}>{a.newValue}</div>}
            <div className="mut t-meta">{a.when}</div>
          </div>
        ))}
        {items.length === 0 && <div className="mut t-body">No activity yet.</div>}
      </div>
      {hidden > 0 && (
        <button className="row-2" onClick={() => setExpanded((v) => !v)}
          style={{ cursor: "pointer", width: "100%", textAlign: "left", background: "var(--t-faint-bg)", border: "1px solid var(--line)", borderRadius: 8, padding: "8px 12px", marginTop: 10 }}>
          <span className="mut t-small">{expanded ? "▾" : "▸"}</span>
          <span className="t-small" style={{ fontWeight: 700, color: "var(--slate)" }}>
            {expanded ? "Show less" : `Show ${hidden} older entr${hidden === 1 ? "y" : "ies"}`}
          </span>
        </button>
      )}
    </>
  );
}
