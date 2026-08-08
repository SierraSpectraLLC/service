"use client";

import { useState } from "react";

const NEW = " new";

/**
 * Pick from what's already in use, or type something new - the vocabulary is
 * whatever the shop has entered (clients, system categories, gases). Keeps
 * these lists out of Settings and next to the work.
 */
export default function PickOrAdd({ value, options, onChange, newLabel = "+ New...", placeholder = "New value" }: {
  value: string; options: string[]; onChange: (next: string) => void;
  newLabel?: string; placeholder?: string;
}) {
  // Typing mode sticks until the field is cleared, so a half-typed name isn't
  // swallowed by a re-render.
  const [typing, setTyping] = useState(() => !!value && !options.includes(value));
  const list = [...new Set(options.filter(Boolean))].sort((a, b) => a.localeCompare(b));

  if (typing) {
    return (
      <div style={{ display: "flex", gap: 6 }}>
        <input autoFocus value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} />
        {list.length > 0 && (
          <button type="button" className="btn sm" style={{ flexShrink: 0 }}
            onClick={() => { setTyping(false); onChange(""); }}>List</button>
        )}
      </div>
    );
  }
  return (
    <select value={list.includes(value) ? value : ""}
      onChange={(e) => {
        if (e.target.value === NEW) { setTyping(true); onChange(""); return; }
        onChange(e.target.value);
      }}>
      <option value="">-</option>
      {list.map((c) => <option key={c} value={c}>{c}</option>)}
      <option value={NEW}>{newLabel}</option>
    </select>
  );
}
