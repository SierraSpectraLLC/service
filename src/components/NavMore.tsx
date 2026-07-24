"use client";

import { useState } from "react";
import Link from "next/link";

/** Collapses the long tail of staff nav links into one dropdown so the top bar fits on a phone. */
export default function NavMore({ items }: { items: { href: string; label: string }[] }) {
  const [open, setOpen] = useState(false);
  return (
    <div style={{ position: "relative" }}>
      <button className="btn sm" onClick={() => setOpen((v) => !v)}>More {open ? "▴" : "▾"}</button>
      {open && (
        <>
          <div onClick={() => setOpen(false)} style={{ position: "fixed", inset: 0, zIndex: 30 }} />
          <div style={{
            position: "absolute", top: "calc(100% + 6px)", right: 0, zIndex: 31, background: "#fff",
            border: "1px solid var(--line)", borderRadius: 10, boxShadow: "0 8px 24px rgba(23,42,74,0.14)",
            padding: 6, minWidth: 160, display: "flex", flexDirection: "column",
          }}>
            {items.map((i) => (
              <Link key={i.href} href={i.href} onClick={() => setOpen(false)}
                style={{ padding: "8px 10px", fontSize: 13, color: "var(--ink)", textDecoration: "none", borderRadius: 6 }}
                className="row-hover">
                {i.label}
              </Link>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
