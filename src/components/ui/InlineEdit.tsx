"use client";

import { useEffect, useRef, useState } from "react";

/**
 * One field, edited where it stands: click the value (a pencil shows on
 * hover), type, Enter saves, Esc cancels, blur saves too - walking away from
 * a half-typed correction losing it is worse than committing it. Anything
 * bigger than one field opens a Dialog instead.
 */
export default function InlineEdit({ value, onSave, label, mono, placeholder }: {
  value: string;
  onSave: (next: string) => void;
  /** What the field is, for the button's accessible name ("Edit task title"). */
  label: string;
  mono?: boolean;
  placeholder?: string;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  const ref = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editing) ref.current?.select();
  }, [editing]);

  const commit = () => {
    setEditing(false);
    const next = draft.trim();
    if (next !== value) onSave(next);
  };

  if (!editing) {
    return (
      <button type="button" className={`inline-edit-view${mono ? " mono" : ""}`}
        aria-label={`Edit ${label}`}
        onClick={() => { setDraft(value); setEditing(true); }}>
        <span>{value || <span className="mut">{placeholder ?? "-"}</span>}</span>
        <span className="pencil" aria-hidden="true">✎</span>
      </button>
    );
  }
  return (
    <span className="inline-edit">
      <input ref={ref} value={draft} aria-label={label} placeholder={placeholder}
        className={mono ? "mono" : undefined}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") commit();
          else if (e.key === "Escape") { setDraft(value); setEditing(false); }
        }} />
      <kbd aria-hidden="true">↵</kbd>
    </span>
  );
}
