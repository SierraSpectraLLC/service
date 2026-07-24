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
      <div style={{ borderLeft: "2px solid var(--line)", paddingLeft: 14, display: "flex", flexDirection: "column", gap: 10 }}>
        {visible.map((a) => (
          <div key={a.id}>
            <div style={{ fontSize: 13 }}>
              <b>{a.actor === "sheet-sync" ? "Sheet sync" : a.actor.split("@")[0]}</b>{" "}
              <span className="mut">{a.action}</span>
            </div>
            {a.field === "note" && a.newValue && <div style={{ fontSize: 13, marginTop: 2 }}>{a.newValue}</div>}
            <div className="mut" style={{ fontSize: 11 }}>{a.when}</div>
          </div>
        ))}
        {items.length === 0 && <div className="mut" style={{ fontSize: 13 }}>No activity yet.</div>}
      </div>
      {hidden > 0 && (
        <button onClick={() => setExpanded((v) => !v)}
          style={{ cursor: "pointer", width: "100%", textAlign: "left", background: "#F5F7FA", border: "1px solid var(--line)", borderRadius: 8, padding: "8px 12px", display: "flex", alignItems: "center", gap: 8, marginTop: 10 }}>
          <span className="mut" style={{ fontSize: 12 }}>{expanded ? "▾" : "▸"}</span>
          <span style={{ fontSize: 12, fontWeight: 700, color: "var(--slate)" }}>
            {expanded ? "Show less" : `Show ${hidden} older entr${hidden === 1 ? "y" : "ies"}`}
          </span>
        </button>
      )}
    </>
  );
}
