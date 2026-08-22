"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { saveEodUpdate, type WorkTarget } from "@/app/actions";

// Long enough to sit through a mid-sentence pause. It used to be 900ms, which
// is shorter than thinking about the next word. A blur and a page-hide both
// flush, so a slow debounce costs nothing.
const AUTOSAVE_MS = 2500;

/**
 * Today's client-facing update, written where the work happens. Whatever lands
 * here shows up pre-filled on the EOD page, ready to include or skip - so the
 * daily report assembles itself instead of being retyped at 5pm.
 *
 * Staff write it; the owning client reads it (they'd get the same words by
 * email tonight, so there is nothing to hide, but only one side authors).
 *
 * Autosave rules, learned the hard way:
 *
 *  - the fields are NEVER disabled. Disabling a focused textarea takes focus
 *    with it, so a save landing mid-sentence used to eat the next keystrokes
 *    and lose the caret. A save is background work; it must be invisible to
 *    the hands.
 *  - one save at a time. Each save sends the whole text, so two in flight can
 *    land out of order and persist the older draft over the newer one. A
 *    second save waits for the first and then re-sends whatever is current.
 */
export default function DailyUpdatePanel({ target, systemUpdate, actionItem, updatedBy, canEdit }: {
  target: WorkTarget; systemUpdate: string; actionItem: string; updatedBy: string; canEdit: boolean;
}) {
  const [draft, setDraft] = useState({ systemUpdate, actionItem });
  const [state, setState] = useState<"" | "dirty" | "saving" | "saved">("");
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const draftRef = useRef(draft);
  draftRef.current = draft;
  // `target` is a fresh object literal on every parent render, so nothing here
  // may depend on its identity: a hook keyed on it would re-run constantly and
  // the unmount save below would fire on every render with an edit pending.
  const targetRef = useRef(target);
  targetRef.current = target;
  const inFlight = useRef(false);
  const queued = useRef(false);

  const flush = useCallback(() => {
    if (timer.current) { clearTimeout(timer.current); timer.current = null; }
    // Serialize: a save already going means this one becomes "go again after".
    if (inFlight.current) { queued.current = true; return; }
    inFlight.current = true;
    setState("saving");
    void saveEodUpdate(targetRef.current, draftRef.current)
      .then(() => { setState((s) => (s === "dirty" ? s : "saved")); })
      .catch(() => { setState("dirty"); })   // stays "Unsaved"; blur will retry
      .finally(() => {
        inFlight.current = false;
        if (queued.current) { queued.current = false; flush(); }
      });
  }, []);

  const edit = (patch: Partial<typeof draft>) => {
    setDraft((d) => ({ ...d, ...patch }));
    setState("dirty");
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(flush, AUTOSAVE_MS);
  };

  /** Anything typed but not yet sent. */
  const unsaved = () => timer.current !== null || queued.current;

  // Closing the tab or switching away shouldn't cost the last sentence, which
  // matters more now the debounce is slower. Mounted once - see targetRef.
  useEffect(() => {
    const onHide = () => { if (document.visibilityState === "hidden" && unsaved()) flush(); };
    document.addEventListener("visibilitychange", onHide);
    window.addEventListener("pagehide", onHide);
    return () => {
      document.removeEventListener("visibilitychange", onHide);
      window.removeEventListener("pagehide", onHide);
      // Unmounting with an unsent edit (a navigation) still saves it.
      if (timer.current) {
        clearTimeout(timer.current);
        void saveEodUpdate(targetRef.current, draftRef.current).catch(() => {});
      }
    };
  }, [flush]);

  // A card like every other panel. It used to be a bare fragment with a top
  // margin, from when it sat inside the identity block; standing on its own it
  // read as loose text dropped on the page.
  if (!canEdit) {
    if (!systemUpdate && !actionItem) return null;
    return (
      <div className="card">
        <div className="card-title" style={{ marginBottom: 6 }}>Today&apos;s update</div>
        {systemUpdate && <div className="t-body" style={{ whiteSpace: "pre-wrap" }}>{systemUpdate}</div>}
        {actionItem && (
          <div className="t-body" style={{ marginTop: 4 }}>
            <span className="eyebrow" style={{ marginRight: 6 }}>Action</span>{actionItem}
          </div>
        )}
        {updatedBy && <div className="mut t-meta" style={{ marginTop: 2 }}>{updatedBy}</div>}
      </div>
    );
  }

  return (
    <div className="card">
      <div className="row-2" style={{ alignItems: "baseline", marginBottom: 4 }}>
        <div className="card-title">Today&apos;s update</div>
        <span className="mut t-meta">
          {state === "saving" ? "Saving..." : state === "saved" ? "Saved ✓" : state === "dirty" ? "Unsaved" : "goes on today's client report"}
        </span>
      </div>
      {/* Never disabled - see the autosave rules above. */}
      <textarea rows={3} value={draft.systemUpdate}
        onChange={(e) => edit({ systemUpdate: e.target.value })}
        onBlur={() => { if (unsaved()) flush(); }}
        placeholder="What happened today" style={{ marginBottom: 6, resize: "vertical" }} />
      <input value={draft.actionItem}
        onChange={(e) => edit({ actionItem: e.target.value })}
        onBlur={() => { if (unsaved()) flush(); }}
        placeholder="Action item - next step or what we need" />
    </div>
  );
}
