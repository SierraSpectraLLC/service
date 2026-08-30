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
      <div className="row-2" style={{ marginBottom: 4 }}>
        <div className="card-title">Add to inventory</div>
        <button className="btn sm primary" style={{ marginLeft: "auto" }} onClick={() => setOpen(!open)}>
          {open ? "Cancel" : "+ Add lines"}
        </button>
      </div>
      {/* Said on the closed card, because "can I put a wrench in here" is a
          question somebody asks by looking rather than by opening the form. */}
      <div className="mut t-small" style={{ marginBottom: open ? 10 : 0 }}>
        Parts and tools alike. A part is its number; a tool is its name, and its
        number is optional.
      </div>
      {open && children}
    </div>
  );
}
