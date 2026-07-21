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
  return (
    <>
      <div className="eyebrow" style={{ marginTop: 14, marginBottom: 6 }}>
        Stages{canEdit ? " - tap to toggle" : ""}
      </div>
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
        {STAGES.map((s) => {
          const on = optimisticStages.includes(s);
          if (!canEdit && !on) return null;
          return (
            <span
              key={s}
              className="pill"
              onClick={canEdit ? () => startTransition(async () => { applyToggle(s); await toggleStage(instrumentId, s); }) : undefined}
              style={{
                background: STAGE_COLOR[s].bg, color: STAGE_COLOR[s].fg,
                opacity: on ? 1 : 0.45, cursor: canEdit ? "pointer" : "default", userSelect: "none",
              }}
            >{s}</span>
          );
        })}
      </div>
    </>
  );
}
