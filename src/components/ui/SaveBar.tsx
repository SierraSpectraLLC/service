"use client";

/**
 * The one save control for a settings page. Panels above it edit a draft;
 * this bar says whether the draft differs from what is stored and offers the
 * only Save and Discard on the page, so a page of six panels cannot grow six
 * half-synchronized Save buttons again.
 */
export default function SaveBar({ dirty, saving, message, error, label = "Save changes", onSave, onDiscard }: {
  dirty: boolean;
  saving?: boolean;
  /** A result line ("Saved", "Sent to jane@...") shown while the page is clean. */
  message?: string;
  error?: string;
  label?: string;
  onSave: () => void;
  onDiscard?: () => void;
}) {
  return (
    <div className="savebar no-print">
      <span className="savebar-status" role="status">
        {error ? <span className="err">{error}</span>
          : dirty ? "Unsaved changes"
          : message ? <span className="ok">{message}</span>
          : "All changes saved"}
      </span>
      {onDiscard && (
        <button className="btn sm" onClick={onDiscard} disabled={!dirty || saving}>Discard</button>
      )}
      <button className="btn sm accent" onClick={onSave} disabled={!dirty || saving}>
        {saving ? "Saving..." : label}
      </button>
    </div>
  );
}
