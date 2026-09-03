"use client";

import { useEffect, useRef, useState } from "react";

/**
 * One field, edited where it stands: click the value (a pencil shows on
 * hover), type, Enter saves, Esc cancels, blur saves too - walking away from
 * a half-typed correction losing it is worse than committing it. Anything
 * bigger than one field opens a Dialog instead.
 *
 * `multiline` is the same field for text that has SHAPE - a line item that is
 * a system and then the seven modules it covers. There, Enter has to mean a
 * new line, so the save keys become blur and Ctrl/Cmd+Enter, and the view
 * state keeps the writer's own line breaks instead of running them together.
 */
export default function InlineEdit({
  value, onSave, label, mono, placeholder, multiline = false, rows = 3,
}: {
  value: string;
  onSave: (next: string) => void;
  /** What the field is, for the button's accessible name ("Edit task title"). */
  label: string;
  mono?: boolean;
  placeholder?: string;
  /** Text with line breaks in it. Enter types one; Ctrl/Cmd+Enter saves. */
  multiline?: boolean;
  rows?: number;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  const ref = useRef<HTMLInputElement>(null);
  const area = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (!editing) return;
    if (multiline) area.current?.focus();
    else ref.current?.select();
  }, [editing, multiline]);

  const commit = () => {
    setEditing(false);
    const next = draft.trim();
    if (next !== value) onSave(next);
  };
  const cancel = () => { setDraft(value); setEditing(false); };

  if (!editing) {
    return (
      <button type="button" className={`inline-edit-view${mono ? " mono" : ""}`}
        aria-label={`Edit ${label}`}
        onClick={() => { setDraft(value); setEditing(true); }}>
        {/* pre-wrap, so what somebody typed on four lines reads as four lines
            rather than as one run-on sentence with the shape lost. */}
        <span style={multiline ? { whiteSpace: "pre-wrap" } : undefined}>
          {value || <span className="mut">{placeholder ?? "-"}</span>}
        </span>
        <span className="pencil" aria-hidden="true">✎</span>
      </button>
    );
  }
  if (multiline) {
    return (
      <span className="inline-edit">
        <textarea ref={area} value={draft} aria-label={label} placeholder={placeholder} rows={rows}
          className={mono ? "mono" : undefined} style={{ width: "100%" }}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            // Enter is a line break here, which is the whole point of the mode.
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); commit(); }
            else if (e.key === "Escape") cancel();
          }} />
      </span>
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
          else if (e.key === "Escape") cancel();
        }} />
      <kbd aria-hidden="true">↵</kbd>
    </span>
  );
}
