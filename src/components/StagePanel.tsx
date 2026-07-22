"use client";

import { useOptimistic, useTransition } from "react";
import { STAGES, STAGE_COLOR } from "@/lib/stages";
import { toggleStage } from "@/app/actions";

export default function StagePanel({ instrumentId, stages, canEdit }: { instrumentId: number; stages: string[]; canEdit: boolean }) {
  const [, startTransition] = useTransition();
  // Flip the pill immediately; the server action + revalidation reconcile behind it.
  const [optimisticStages, applyToggle] = useOptimistic(stages, (cur: string[], stage: string) =>
    cur.includes(stage) ? cur.filter((s) => s !== stage) : [...cur, stage]
  );
  const toggle = (s: string) => startTransition(async () => { applyToggle(s); await toggleStage(instrumentId, s); });
  // Active stages render as pills; the rest live in a compact dropdown so the
  // full nine-stage vocabulary doesn't clutter the page (especially mobile).
  const inactive = STAGES.filter((s) => !optimisticStages.includes(s));
  return (
    <>
      <div className="eyebrow" style={{ marginTop: 14, marginBottom: 6 }}>
        Stages{canEdit && optimisticStages.length > 1 ? " - tap to remove" : ""}
      </div>
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
        {optimisticStages.map((s) => (
          <span
            key={s}
            className="pill"
            onClick={canEdit ? () => toggle(s) : undefined}
            style={{
              background: STAGE_COLOR[s]?.bg, color: STAGE_COLOR[s]?.fg,
              cursor: canEdit ? "pointer" : "default", userSelect: "none",
            }}
          >{s}{canEdit && optimisticStages.length > 1 ? " ×" : ""}</span>
        ))}
        {canEdit && inactive.length > 0 && (
          <select
            value=""
            onChange={(e) => { if (e.target.value) toggle(e.target.value); }}
            style={{ width: "auto", fontSize: 12, padding: "3px 6px", borderRadius: 999, color: "var(--mut)" }}
          >
            <option value="">+ Add stage</option>
            {inactive.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
        )}
      </div>
    </>
  );
}
