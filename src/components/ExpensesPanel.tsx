"use client";

import { useState, useTransition } from "react";
import { confirmReason } from "@/components/ui/ConfirmDialog";
import { toast } from "@/components/ui/Toast";
import { deleteExpense, logExpense } from "@/app/actions";
import { EXPENSE_KINDS, EXPENSE_LABEL } from "@/lib/billing";
import { formatCents } from "@/lib/money";

export type ExpenseRow = {
  id: number; kind: string; description: string; amountCents: number; incurredOn: string;
};

const mdy = (iso: string) => {
  const [y, m, d] = iso.split("-");
  return `${parseInt(m)}/${parseInt(d)}/${y.slice(2)}`;
};

/**
 * What the job cost that was neither a part nor an hour: the mileage, the
 * freight, the night in a motel.
 *
 * It sits beside Parts because that is where somebody is already standing when
 * they remember it, and because an expense nobody logs is margin nobody can
 * find afterwards - it reaches both the invoice and the job cost from this one
 * entry.
 */
export default function ExpensesPanel({ workOrderId, rows, today, canEdit, isStaff }: {
  workOrderId: number;
  rows: ExpenseRow[];
  today: string;
  canEdit: boolean;
  isStaff: boolean;
}) {
  const [draft, setDraft] = useState({ kind: "mileage", description: "", amount: "", incurredOn: today });
  const [error, setError] = useState("");
  const [pending, startTransition] = useTransition();

  if (!canEdit && rows.length === 0) return null;

  const total = rows.reduce((n, r) => n + r.amountCents, 0);

  const submit = () => {
    if (!draft.amount.trim()) return;
    setError("");
    startTransition(async () => {
      const res = await logExpense(workOrderId, draft);
      if (res?.error) { setError(res.error); return; }
      toast({ message: `Logged ${draft.amount.trim()} of ${EXPENSE_LABEL[draft.kind].toLowerCase()}` });
      setDraft({ ...draft, description: "", amount: "" });
    });
  };

  return (
    <div className="card">
      <div className="row-2" style={{ alignItems: "baseline", marginBottom: 4 }}>
        <div className="card-title">Expenses</div>
        {total > 0 && <span className="mut t-small">{formatCents(total)} logged</span>}
      </div>
      {canEdit && (
        <div className="row-2" style={{ marginBottom: rows.length ? 10 : 0 }}>
          <select className="t-body" value={draft.kind} aria-label="Kind of expense"
            onChange={(e) => setDraft({ ...draft, kind: e.target.value })} style={{ width: "auto" }}>
            {EXPENSE_KINDS.map((k) => <option key={k} value={k}>{EXPENSE_LABEL[k]}</option>)}
          </select>
          <input className="t-body" value={draft.amount} inputMode="decimal" aria-label="Amount"
            onChange={(e) => setDraft({ ...draft, amount: e.target.value })}
            onKeyDown={(e) => { if (e.key === "Enter") submit(); }}
            placeholder="43.00" style={{ flex: "0 1 100px" }} />
          <input className="t-body" type="date" value={draft.incurredOn} max={today} aria-label="Date incurred"
            onChange={(e) => setDraft({ ...draft, incurredOn: e.target.value })} style={{ width: "auto" }} />
          <input className="t-body" value={draft.description} aria-label="What it was"
            onChange={(e) => setDraft({ ...draft, description: e.target.value })}
            onKeyDown={(e) => { if (e.key === "Enter") submit(); }}
            placeholder="62 mi round trip (optional)" style={{ flex: "1 1 160px" }} />
          <button className="btn sm accent" onClick={submit} disabled={pending || !draft.amount.trim()}>
            {pending ? "Logging..." : "Log"}
          </button>
        </div>
      )}

      {rows.map((r) => (
        <div key={r.id} className="row-2" style={{ alignItems: "baseline", padding: "5px 0", borderTop: "1px solid var(--line)" }}>
          <span className="t-body" style={{ fontWeight: 700, width: 70 }}>{formatCents(r.amountCents)}</span>
          <span className="pill neutral">{EXPENSE_LABEL[r.kind] ?? r.kind}</span>
          {r.incurredOn && <span className="mut t-small">{mdy(r.incurredOn)}</span>}
          {r.description && <span className="mut t-small">- {r.description}</span>}
          {isStaff && (
            <button className="btn link t-meta" style={{ marginLeft: "auto", color: "var(--t-bad-fg)" }} disabled={pending}
              onClick={async () => {
                const why = await confirmReason({
                  title: `Remove this ${formatCents(r.amountCents)} expense?`,
                  body: "It stays in the audit history.",
                  action: "Remove expense", tone: "bad",
                });
                if (!why) return;
                startTransition(async () => {
                  const res = await deleteExpense(r.id, why);
                  if (res?.error) setError(res.error);
                  else toast({ message: `Removed the ${formatCents(r.amountCents)} expense` });
                });
              }}>remove</button>
          )}
        </div>
      ))}
      {rows.length === 0 && !canEdit && <div className="mut t-small">Nothing logged.</div>}
      {error && <div className="t-small" style={{ color: "var(--t-bad-fg)", marginTop: 6 }}>{error}</div>}
    </div>
  );
}
