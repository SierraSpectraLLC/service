"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { declineOption, exerciseOption } from "@/app/actions";
import {
  awardLine, decisionsDue, exerciseProblems, optionDeadline, periodStanding,
  PERIOD_TONE, standingWord,
} from "@/lib/award";
import type { AwardWithPeriods } from "@/lib/awardData";
import { formatCents } from "@/lib/money";
import Dialog, { DialogStatus } from "@/components/ui/Dialog";
import { Panel, Pill } from "@/components/ui";
import { toast } from "@/components/ui/Toast";

/**
 * A multi-year award, as a ladder of periods.
 *
 * The design question was what to lead with, and the answer is not the total.
 * "A $362,000 award" is four fifths a hope - one year is committed and the rest
 * is a series of decisions somebody else makes, one a year - so the header
 * splits it into committed, still optional, and not taken, and the ladder shows
 * which is which.
 *
 * The deadline is the reason the whole thing exists. An option year has a day
 * by which the client must say, and a shop that misses it finds out by noticing
 * the money stopped in October. So a period inside its notice window wears its
 * deadline in the row, and one that has gone by says LAPSED in the strongest
 * word the palette has.
 */
export default function AwardLadder({ awards, today, canEdit }: {
  awards: AwardWithPeriods[];
  today: string;
  canEdit: boolean;
}) {
  const due = awards.flatMap((a) => decisionsDue(a.periods, a, today));
  if (awards.length === 0) return null;

  return (
    <Panel
      title="Multi-year awards"
      count={awards.length}
      hint={due.length
        ? `${due.length} option${due.length === 1 ? "" : "s"} needs deciding`
        : "One engagement, several separately-priced terms. Only the base year is committed."}
    >
      {awards.map((a) => (
        <AwardRow key={a.id} award={a} today={today} canEdit={canEdit} />
      ))}
    </Panel>
  );
}

function AwardRow({ award, today, canEdit }: {
  award: AwardWithPeriods; today: string; canEdit: boolean;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [declining, setDeclining] = useState<number | null>(null);
  const [reason, setReason] = useState("");
  const [error, setError] = useState("");

  const take = (id: number) =>
    startTransition(async () => {
      const res = await exerciseOption(id);
      if (res?.error) { toast({ message: res.error }); return; }
      toast({ message: "Exercised - its billing starts on the period's own start date" });
      router.refresh();
    });

  const drop = () => {
    if (declining === null) return;
    setError("");
    startTransition(async () => {
      const res = await declineOption(declining, reason);
      if (res?.error) { setError(res.error); return; }
      toast({ message: "Recorded as not taken" });
      setDeclining(null); setReason("");
      router.refresh();
    });
  };

  return (
    <div style={{ padding: "10px 0", borderTop: "1px solid var(--line)" }}>
      <div className="row-2" style={{ alignItems: "baseline" }}>
        <span className="t-body" style={{ fontWeight: 600, flex: 1, minWidth: 0 }}>
          {award.orgName}
          {award.number && <span className="mut mono t-small"> · {award.number}</span>}
        </span>
        <span className="mut t-meta">
          {award.awardedOn ? `awarded ${award.awardedOn}` : "not yet awarded"}
          {` · ${award.optionNoticeDays}d notice`}
        </span>
      </div>
      <div className="mut t-small" style={{ marginTop: 2 }}>
        {awardLine(award.periods, award, today, formatCents)}
      </div>

      {award.periods.map((p) => {
        const s = periodStanding(p, today);
        const deadline = optionDeadline(p, award);
        const warn = exerciseProblems(p, today);
        return (
          <div key={p.id} style={{
            display: "flex", gap: 8, alignItems: "baseline", flexWrap: "wrap",
            padding: "5px 0 5px 12px", marginTop: 4,
            borderLeft: `2px solid var(--${s === "running" ? "t-good-fg" : s === "lapsed" ? "t-bad-fg" : "line"})`,
          }}>
            <span className="mono t-small" style={{ width: 74 }}>
              CLIN {String(p.periodIndex + 1).padStart(4, "0")}
            </span>
            <span className="t-body" style={{ flex: "1 1 160px", minWidth: 0 }}>
              {p.periodIndex === 0 ? "Base year" : `Option year ${p.periodIndex}`}
              <span className="mut t-meta">
                {p.startsOn ? ` · ${p.startsOn} – ${p.endsOn}` : ""}
              </span>
            </span>
            {/* The deadline rides in the row rather than in a summary, because
                it belongs to this period and it is what somebody acts on. */}
            {(s === "option" || s === "lapsed") && deadline && (
              <span className="t-meta" style={{ color: s === "lapsed" ? "var(--t-bad-fg)" : "var(--t-warn-fg)" }}>
                {s === "lapsed" ? "was due " : "decide by "}{deadline}
              </span>
            )}
            <Pill tone={PERIOD_TONE[s]}>{standingWord(s, p.periodIndex)}</Pill>
            <b className="t-body" style={{ width: 92, textAlign: "right" }}>
              {formatCents(p.billAmountCents || p.valueCents || 0)}
            </b>
            {canEdit && (s === "option" || s === "lapsed") && (
              <>
                <button className="btn sm" disabled={pending} onClick={() => take(p.id)}
                  title={warn[0] ?? "Put this period in force"}>
                  Exercise
                </button>
                <button className="btn link" style={{ fontSize: 12 }} disabled={pending}
                  onClick={() => { setError(""); setReason(""); setDeclining(p.id); }}>
                  not taking it
                </button>
              </>
            )}
          </div>
        );
      })}

      {declining !== null && (
        <Dialog open onClose={() => setDeclining(null)} size="sm"
          title="Not taking this option year"
          context="Recorded on purpose, so it never reads later as something nobody got round to."
          footer={
            <>
              <DialogStatus error={error} problem={reason.trim() ? null : "say why"} />
              <button className="btn" onClick={() => setDeclining(null)} disabled={pending}>Cancel</button>
              <button className="btn accent" onClick={drop} disabled={pending || !reason.trim()}>
                {pending ? "Recording..." : "Record it"}
              </button>
            </>
          }>
          <label>Why</label>
          <input value={reason} aria-label="Why" autoFocus
            placeholder="funding not renewed / they moved the work in house"
            onChange={(e) => setReason(e.target.value)} />
        </Dialog>
      )}
    </div>
  );
}
