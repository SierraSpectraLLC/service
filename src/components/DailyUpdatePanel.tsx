"use client";

import { useRef, useState, useTransition } from "react";
import { saveEodUpdate, type WorkTarget } from "@/app/actions";

const AUTOSAVE_MS = 900;

/**
 * Today's client-facing update, written where the work happens. Whatever lands
 * here shows up pre-filled on the EOD page, ready to include or skip - so the
 * daily report assembles itself instead of being retyped at 5pm.
 *
 * Staff write it; the owning client reads it (they'd get the same words by
 * email tonight, so there is nothing to hide, but only one side authors).
 */
export default function DailyUpdatePanel({ target, systemUpdate, actionItem, updatedBy, canEdit }: {
  target: WorkTarget; systemUpdate: string; actionItem: string; updatedBy: string; canEdit: boolean;
}) {
  const [draft, setDraft] = useState({ systemUpdate, actionItem });
  const [state, setState] = useState<"" | "dirty" | "saving" | "saved">("");
  const [pending, startTransition] = useTransition();
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const draftRef = useRef(draft);
  draftRef.current = draft;

  const flush = () => {
    if (timer.current) { clearTimeout(timer.current); timer.current = null; }
    setState("saving");
    startTransition(async () => {
      await saveEodUpdate(target, draftRef.current);
      setState((s) => (s === "dirty" ? s : "saved"));
    });
  };

  const edit = (patch: Partial<typeof draft>) => {
    setDraft((d) => ({ ...d, ...patch }));
    setState("dirty");
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(flush, AUTOSAVE_MS);
  };

  // A card like every other panel. It used to be a bare fragment with a top
  // margin, from when it sat inside the identity block; standing on its own it
  // read as loose text dropped on the page.
  if (!canEdit) {
    if (!systemUpdate && !actionItem) return null;
    return (
      <div className="card">
        <div className="card-title" style={{ marginBottom: 6 }}>Today&apos;s update</div>
        {systemUpdate && <div style={{ fontSize: 13, whiteSpace: "pre-wrap" }}>{systemUpdate}</div>}
        {actionItem && (
          <div style={{ fontSize: 13, marginTop: 4 }}>
            <span className="eyebrow" style={{ marginRight: 6 }}>Action</span>{actionItem}
          </div>
        )}
        {updatedBy && <div className="mut" style={{ fontSize: 11, marginTop: 2 }}>{updatedBy}</div>}
      </div>
    );
  }

  return (
    <div className="card">
      <div style={{ display: "flex", alignItems: "baseline", gap: 8, marginBottom: 4, flexWrap: "wrap" }}>
        <div className="card-title">Today&apos;s update</div>
        <span className="mut" style={{ fontSize: 11 }}>
          {state === "saving" ? "Saving..." : state === "saved" ? "Saved ✓" : state === "dirty" ? "Unsaved" : "goes on today's client report"}
        </span>
      </div>
      <div className="mut" style={{ fontSize: 12, marginBottom: 10 }}>
        What the client reads tonight. Saves itself as you type.
      </div>
      <textarea rows={2} value={draft.systemUpdate} disabled={pending && state === "saving"}
        onChange={(e) => edit({ systemUpdate: e.target.value })}
        onBlur={() => { if (state === "dirty") flush(); }}
        placeholder="What happened today" style={{ marginBottom: 6, resize: "vertical" }} />
      <input value={draft.actionItem}
        onChange={(e) => edit({ actionItem: e.target.value })}
        onBlur={() => { if (state === "dirty") flush(); }}
        placeholder="Action item - next step or what we need" />
    </div>
  );
}
