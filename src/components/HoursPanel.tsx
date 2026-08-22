"use client";

import { useState, useTransition } from "react";
import { confirmReason } from "@/components/ui/ConfirmDialog";
import { toast } from "@/components/ui/Toast";
import { logTime, deleteTimeEntry, type WorkTarget } from "@/app/actions";
import { formatHours } from "@/lib/hours";

export type TimeRow = {
  id: number; person: string; date: string; minutes: number; note: string;
};

const mdy = (iso: string) => {
  const [y, m, d] = iso.split("-");
  return `${parseInt(m)}/${parseInt(d)}/${y.slice(2)}`;
};

/**
 * Hours against this system or unit. The table existed for a year with no way
 * to write to it; this is the missing half. Entries name who did the work -
 * the person defaults to whoever's signed in but is editable, because the
 * person logging is often not the person who turned the wrench.
 */
export default function HoursPanel({ target, entries, people, defaultPerson, today, canEdit, isStaff }: {
  target: WorkTarget;
  entries: TimeRow[];
  people: string[];
  defaultPerson: string;
  today: string;
  canEdit: boolean;
  isStaff: boolean;
}) {
  const [draft, setDraft] = useState({ hours: "", person: defaultPerson, date: today, note: "" });
  const [error, setError] = useState("");
  const [pending, startTransition] = useTransition();

  if (!canEdit && entries.length === 0) return null;

  const total = entries.reduce((n, e) => n + e.minutes, 0);

  const submit = () => {
    if (!draft.hours.trim()) return;
    setError("");
    startTransition(async () => {
      const res = await logTime(target, draft);
      if (res?.error) setError(res.error);
      else {
        toast({ message: `Logged ${draft.hours.trim()} for ${draft.person || "the work"}` });
        setDraft({ ...draft, hours: "", note: "" });
      }
    });
  };

  return (
    <div className="card">
      <div className="row-2" style={{ alignItems: "baseline", marginBottom: 4 }}>
        <div className="card-title">Hours</div>
        {total > 0 && <span className="mut t-small">{formatHours(total)} logged</span>}
      </div>
      {canEdit && (
        <div className="row-2" style={{ marginBottom: entries.length ? 10 : 0 }}>
          <input className="t-body" value={draft.hours} onChange={(e) => setDraft({ ...draft, hours: e.target.value })}
            onKeyDown={(e) => { if (e.key === "Enter") submit(); }}
            placeholder="1.5, 1:30 or 45m" inputMode="decimal"
            aria-label="Hours worked" style={{ flex: "0 1 120px" }} />
          <input className="t-body" value={draft.person} list="hours-people" onChange={(e) => setDraft({ ...draft, person: e.target.value })}
            placeholder="Who" aria-label="Who did the work" style={{ flex: "0 1 130px" }} />
          <datalist id="hours-people">{people.map((p) => <option key={p} value={p} />)}</datalist>
          <input className="t-body" type="date" value={draft.date} max={today} onChange={(e) => setDraft({ ...draft, date: e.target.value })}
            aria-label="Date worked" style={{ width: "auto" }} />
          <input className="t-body" value={draft.note} onChange={(e) => setDraft({ ...draft, note: e.target.value })}
            onKeyDown={(e) => { if (e.key === "Enter") submit(); }}
            placeholder="What was done (optional)" style={{ flex: "1 1 160px" }} />
          <button className="btn sm accent" onClick={submit} disabled={pending || !draft.hours.trim()}>
            {pending ? "Logging..." : "Log"}
          </button>
        </div>
      )}

      {entries.map((e) => (
        <div key={e.id} className="row-2" style={{ alignItems: "baseline", padding: "5px 0", borderTop: "1px solid var(--line)" }}>
          <span className="t-body" style={{ fontWeight: 700, width: 52 }}>{formatHours(e.minutes)}</span>
          <span className="t-body">{e.person}</span>
          <span className="mut t-small">{mdy(e.date)}</span>
          {e.note && <span className="mut t-small">- {e.note}</span>}
          {isStaff && (
            <button className="btn link t-meta" style={{ marginLeft: "auto", color: "var(--t-bad-fg)" }} disabled={pending}
              onClick={async () => {
                const why = await confirmReason({
                  title: `Remove this ${formatHours(e.minutes)} entry?`,
                  body: "It stays in the audit history.",
                  action: "Remove entry", tone: "bad",
                });
                if (!why) return;
                startTransition(async () => {
                  const res = await deleteTimeEntry(e.id, why);
                  if (res?.error) setError(res.error);
                  else toast({ message: `Removed the ${formatHours(e.minutes)} entry` });
                });
              }}>remove</button>
          )}
        </div>
      ))}
      {error && <div className="t-small" style={{ color: "var(--t-bad-fg)", marginTop: 6 }}>{error}</div>}
    </div>
  );
}
