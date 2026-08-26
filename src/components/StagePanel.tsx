"use client";

import { useOptimistic, useState, useTransition } from "react";
import { setBlockedReason, toggleStage } from "@/app/actions";
import { BLOCKED_STAGE } from "@/lib/stages";
import { choiceDialog } from "@/components/ui/ConfirmDialog";
import { blockLabel, type BlockOrgChoice } from "@/lib/blocks";
import { toast } from "@/components/ui/Toast";

/**
 * Why a system is being blocked, asked at the moment of blocking.
 *
 * Not a destructive confirm needing an audit alibi: it is the fact that makes
 * a blocked system actionable, and it is asked for that way. Pre-filled when
 * re-wording an existing reason. The server demands it too - see
 * actions.toggleStage.
 */
const askBlock = (
  action: string, orgs: BlockOrgChoice[], heldBy: number, existing = "", context?: string,
) => choiceDialog({
  title: "Why is this system blocked?",
  context,
  body: 'What is it waiting on, and what would clear it? Shown on the system and in the daily digest until it is unblocked - e.g. "waiting on LabZen to approve the quote for the HED supply".',
  action, label: "Reason", initial: existing,
  choiceLabel: "Blocked with",
  choices: orgs.map((o) => ({ value: String(o.id), label: o.name, note: o.note })),
  choiceInitial: String(heldBy),
  /* The sentence that stops the picker being answered from the reason. The
     two questions look like one and are not: naming who we are waiting on
     does not move the wait onto them, and a block parked on a customer is a
     block nobody here has to look at again. See lib/blocks. */
  choiceHint: "Whose problem it is, not who you are waiting on. A system on our bench stays with us even while we wait for the customer.",
});

export type StageDefLite = { name: string; bg: string; fg: string };

export default function StagePanel({
  instrumentId, stages, stageDefs, canEdit, blockedReason = "", systemLabel,
  blockOrgs = [], blockedOrgId = null, blockHolder = "",
}: {
  instrumentId: number; stages: string[]; stageDefs: StageDefLite[]; canEdit: boolean;
  /** Why this system is blocked. Only meaningful while the blocked stage is on. */
  blockedReason?: string;
  /** What the block-reason dialog acts on, e.g. the system's external id. */
  systemLabel?: string;
  /** Who a block on this system may be put under, the default first. */
  blockOrgs?: BlockOrgChoice[];
  /** Who the current block is under, when there is one. */
  blockedOrgId?: number | null;
  /** That organization's name, blank when it is the obvious party. */
  blockHolder?: string;
}) {
  const [, startTransition] = useTransition();
  const [error, setError] = useState("");
  // Flip the pill immediately; the server action + revalidation reconcile behind it.
  const [optimisticStages, applyToggle] = useOptimistic(stages, (cur: string[], stage: string) =>
    cur.includes(stage) ? cur.filter((s) => s !== stage) : [...cur, stage]
  );
  // blockOrgs arrives with the default first (see lib/blocks.blockOrgChoices),
  // so the head of the list is "us" for whoever is looking.
  const fallbackOrg = blockOrgs[0]?.id ?? 0;

  // The refusal is shown, not thrown. A server action that throws reaches the
  // browser as a crash page with a digest number and nothing a person can act on.
  // Blocking is the one stage change that asks a question first: a blocked
  // system with no recorded reason is one nobody else can pick up. Asked before
  // the optimistic flip, so cancelling leaves the pill exactly as it was.
  const toggle = async (s: string) => {
    let reason = "";
    let heldBy: number | null = null;
    const blocking = s === BLOCKED_STAGE && !optimisticStages.includes(s);
    if (blocking) {
      const answer = await askBlock("Block system", blockOrgs, fallbackOrg, "", systemLabel);
      if (answer === null) return;
      reason = answer.value;
      heldBy = Number(answer.choice) || null;
    }
    startTransition(async () => {
      setError("");
      applyToggle(s);
      const res = await toggleStage(instrumentId, s, reason, heldBy);
      if (res?.error) setError(res.error);
      else if (blocking) toast({ message: "Blocked the system" });
    });
  };

  const editReason = async () => {
    const answer = await askBlock(
      "Save reason", blockOrgs, blockedOrgId ?? fallbackOrg, blockedReason, systemLabel);
    if (answer === null) return;
    startTransition(async () => {
      setError("");
      const res = await setBlockedReason(instrumentId, answer.value, Number(answer.choice) || null);
      if (res?.error) setError(res.error);
      else toast({ message: "Saved the reason" });
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
            className="t-small"
            style={{ width: "auto", padding: "3px 6px", borderRadius: 999, color: "var(--mut)" }}
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
        <div className="t-small" style={{ marginTop: 6, color: blockedReason ? "var(--mut)" : "#A32D2D" }}>
          {/* Named only where it is somebody else's - "Blocked with Sierra
              Spectra" on a Sierra Spectra screen is the operator's name used
              as a frame rather than as an answer. See lib/blocks. */}
          <b>{blockLabel(blockHolder)}:</b>{" "}
          {blockedReason || "no reason recorded"}
          {canEdit && (
            <button className="btn link" onClick={editReason} style={{ marginLeft: 6, fontSize: 12 }}>
              {blockedReason ? "edit" : "say why"}
            </button>
          )}
        </div>
      )}
      {error && <div className="t-small" style={{ color: "var(--t-bad-fg)", marginTop: 6 }}>{error}</div>}
    </>
  );
}
