"use client";

import { useOptimistic, useState, useTransition } from "react";
import { setBlockedReason, toggleStage } from "@/app/actions";
import { BLOCKED_STAGE } from "@/lib/stages";
import { inputDialog } from "@/components/ui/ConfirmDialog";

/**
 * Why a system is being blocked, asked at the moment of blocking.
 *
 * Not a destructive confirm needing an audit alibi: it is the fact that makes
 * a blocked system actionable, and it is asked for that way. Pre-filled when
 * re-wording an existing reason. The server demands it too - see
 * actions.toggleStage.
 */
const askBlockReason = (action: string, existing = "") => inputDialog({
  title: "Why is this system blocked?",
  body: 'What is it waiting on, and what would clear it? Shown on the system and in the daily digest until it is unblocked - e.g. "waiting on LabZen to approve the quote for the HED supply".',
  action, label: "Reason", initial: existing,
});

export type StageDefLite = { name: string; bg: string; fg: string };

export default function StagePanel({ instrumentId, stages, stageDefs, canEdit, blockedReason = "" }: {
  instrumentId: number; stages: string[]; stageDefs: StageDefLite[]; canEdit: boolean;
  /** Why this system is blocked. Only meaningful while the blocked stage is on. */
  blockedReason?: string;
}) {
  const [, startTransition] = useTransition();
  const [error, setError] = useState("");
  // Flip the pill immediately; the server action + revalidation reconcile behind it.
  const [optimisticStages, applyToggle] = useOptimistic(stages, (cur: string[], stage: string) =>
    cur.includes(stage) ? cur.filter((s) => s !== stage) : [...cur, stage]
  );
  // The refusal is shown, not thrown. A server action that throws reaches the
  // browser as a crash page with a digest number and nothing a person can act on.
  // Blocking is the one stage change that asks a question first: a blocked
  // system with no recorded reason is one nobody else can pick up. Asked before
  // the optimistic flip, so cancelling leaves the pill exactly as it was.
  const toggle = async (s: string) => {
    let reason = "";
    if (s === BLOCKED_STAGE && !optimisticStages.includes(s)) {
      const answer = await askBlockReason("Block system");
      if (answer === null) return;
      reason = answer;
    }
    startTransition(async () => {
      setError("");
      applyToggle(s);
      const res = await toggleStage(instrumentId, s, reason);
      if (res?.error) setError(res.error);
    });
  };

  const editReason = async () => {
    const answer = await askBlockReason("Save reason", blockedReason);
    if (answer === null) return;
    startTransition(async () => {
      setError("");
      const res = await setBlockedReason(instrumentId, answer);
      if (res?.error) setError(res.error);
    });
  };
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
          >{s}{canEdit && optimisticStages.length > 1 ? " ×" : ""}</span>
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
      {/* The reason sits under the pills, where the blocked pill can be seen
          next to it - and reads as a prompt when it is missing, which is every
          system blocked before a reason was required. */}
      {optimisticStages.includes(BLOCKED_STAGE) && (
        <div style={{ fontSize: 12, marginTop: 6, color: blockedReason ? "var(--mut)" : "#A32D2D" }}>
          <b>Blocked:</b>{" "}
          {blockedReason || "no reason recorded"}
          {canEdit && (
            <button className="btn link" onClick={editReason} style={{ marginLeft: 6, fontSize: 12 }}>
              {blockedReason ? "edit" : "say why"}
            </button>
          )}
        </div>
      )}
      {error && <div style={{ fontSize: 12, color: "var(--t-bad-fg)", marginTop: 6 }}>{error}</div>}
    </>
  );
}
