"use client";

import { useTransition } from "react";
import { STAGES, STAGE_COLOR } from "@/lib/stages";
import { toggleStage } from "@/app/actions";

export default function StagePanel({ instrumentId, stages, canEdit }: { instrumentId: number; stages: string[]; canEdit: boolean }) {
  const [, startTransition] = useTransition();
  const inactive = STAGES.filter((s) => !stages.includes(s));
  return (
    <>
      <div className="eyebrow" style={{ marginTop: 14, marginBottom: 6 }}>
        Stages{canEdit && stages.length > 1 ? " - tap to remove" : ""}
      </div>
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
        {stages.map((s) => (
          <span
            key={s}
            className="pill"
            onClick={canEdit ? () => startTransition(() => toggleStage(instrumentId, s)) : undefined}
            style={{
              background: STAGE_COLOR[s]?.bg, color: STAGE_COLOR[s]?.fg,
              cursor: canEdit ? "pointer" : "default", userSelect: "none",
            }}
          >{s}{canEdit && stages.length > 1 ? " ×" : ""}</span>
        ))}
        {canEdit && inactive.length > 0 && (
          <select
            value=""
            onChange={(e) => { if (e.target.value) startTransition(() => toggleStage(instrumentId, e.target.value)); }}
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
