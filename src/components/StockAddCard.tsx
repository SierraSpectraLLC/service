"use client";

import { useState } from "react";

/**
 * Collapsed wrapper for the stocking grid. The grid is a server-action client
 * component either way; this just keeps a five-row table from dominating a page
 * whose real job is showing what's on the shelf.
 */
export default function StockAddCard({ children }: { children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="card">
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: open ? 10 : 0 }}>
        <div className="card-title">Stock the shelf</div>
        <button className="btn sm primary" style={{ marginLeft: "auto" }} onClick={() => setOpen(!open)}>
          {open ? "Cancel" : "+ Add lines"}
        </button>
      </div>
      {open && children}
    </div>
  );
}
