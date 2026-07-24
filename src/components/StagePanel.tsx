"use client";

import { useOptimistic, useTransition } from "react";
import { toggleStage } from "@/app/actions";

export type StageDefLite = { name: string; bg: string; fg: string };

export default function StagePanel({ instrumentId, stages, stageDefs, ages, canEdit }: {
  instrumentId: number; stages: string[]; stageDefs: StageDefLite[]; ages: Record<string, string>; canEdit: boolean;
}) {
  const [, startTransition] = useTransition();
  // Flip the pill immediately; the server action + revalidation reconcile behind it.
  const [optimisticStages, applyToggle] = useOptimistic(stages, (cur: string[], stage: string) =>
    cur.includes(stage) ? cur.filter((s) => s !== stage) : [...cur, stage]
  );
  const toggle = (s: string) => startTransition(async () => { applyToggle(s); await toggleStage(instrumentId, s); });
  const color = (name: string) => stageDefs.find((d) => d.name === name) ?? { bg: "#EEF1F5", fg: "#475569" };
  // Active stages render as pills; the rest live in a compact dropdown so the
  // full stage vocabulary doesn't clutter the page (especially mobile).
  const inactive = stageDefs.filter((d) => !optimisticStages.includes(d.name));
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
              background: color(s).bg, color: color(s).fg,
              cursor: canEdit ? "pointer" : "default", userSelect: "none",
            }}
          >{s}{ages[s] ? <span style={{ opacity: 0.75, fontWeight: 400 }}> · {ages[s]}</span> : null}{canEdit && optimisticStages.length > 1 ? " ×" : ""}</span>
        ))}
        {canEdit && inactive.length > 0 && (
          <select
            value=""
            onChange={(e) => { if (e.target.value) toggle(e.target.value); }}
            style={{ width: "auto", fontSize: 12, padding: "3px 6px", borderRadius: 999, color: "var(--mut)" }}
          >
            <option value="">+ Add stage</option>
            {inactive.map((d) => <option key={d.name} value={d.name}>{d.name}</option>)}
          </select>
        )}
      </div>
    </>
  );
}
