"use client";

import { useState, useTransition } from "react";
import { confirmReason } from "@/components/ui/ConfirmDialog";
import { toast } from "@/components/ui/Toast";
import { deleteExpense, logOverheadExpense } from "@/app/actions";
import { EXPENSE_KINDS, EXPENSE_LABEL } from "@/lib/billing";
import { formatCents } from "@/lib/money";
import { Field, Panel } from "@/components/ui";

export type OverheadRow = {
  id: number; kind: string; description: string; amountCents: number;
  incurredOn: string; person: string;
};

const mdy = (iso: string) => {
  const [y, m, d] = iso.split("-");
  return `${parseInt(m)}/${parseInt(d)}/${y.slice(2)}`;
};

/** "2026-08" -> "August 2026", for the month headings the ledger groups by. */
const monthName = (ym: string) => {
  const [y, m] = ym.split("-").map(Number);
  return `${["January","February","March","April","May","June","July","August","September","October","November","December"][m - 1]} ${y}`;
};

/**
 * The overhead ledger: money the business spent that no job caused. The
 * engineer's internet bill, the software seat, the postage.
 *
 * Grouped by month because that is the question this page answers - "what did
 * it cost to exist in August" - where a job expense answers "what did this WO
 * cost". The two never mix: nothing here can reach an invoice, which is
 * enforced where the rows are written (logOverheadExpense stamps billable
 * false and no work order), not by this component behaving.
 */
export default function OverheadPanel({ rows, people, me, today, categories = [] }: {
  rows: OverheadRow[];
  /** This workspace's own expense vocabulary; empty falls back to the built-ins. */
  categories?: string[];
  /** Who can be reimbursed - the directory, same list every name field uses. */
  people: { name: string; org: string }[];
  me: string;
  today: string;
}) {
  const known = new Set(people.map((p) => p.name));
  const kinds: { value: string; label: string }[] = categories.length
    ? categories.map((c) => ({ value: c, label: c }))
    : EXPENSE_KINDS.map((k) => ({ value: k, label: EXPENSE_LABEL[k] }));
  const [draft, setDraft] = useState({
    // Overhead is mostly "Other" whatever the vocabulary - default to the tail.
    kind: kinds[kinds.length - 1]?.value ?? "other", description: "", amount: "", incurredOn: today,
    person: known.has(me) ? me : "",
  });
  const [error, setError] = useState("");
  const [pending, startTransition] = useTransition();

  const submit = () => {
    if (!draft.amount.trim() || !draft.description.trim()) return;
    setError("");
    startTransition(async () => {
      const res = await logOverheadExpense(draft);
      if (res?.error) { setError(res.error); return; }
      toast({ message: `Logged ${draft.amount.trim()} of overhead` });
      setDraft({ ...draft, description: "", amount: "" });
    });
  };

  // Months, newest first; rows inside keep the date order the page loaded.
  const months = new Map<string, OverheadRow[]>();
  for (const r of rows) {
    const ym = r.incurredOn.slice(0, 7);
    months.set(ym, [...(months.get(ym) ?? []), r]);
  }

  return (
    <>
      <Panel title="Log an overhead expense">
        <div className="row-2" style={{ alignItems: "flex-end", flexWrap: "wrap" }}>
          <Field label="Kind">
            <select className="t-body" value={draft.kind} style={{ width: "auto" }}
              onChange={(e) => setDraft({ ...draft, kind: e.target.value })}>
              {kinds.map((k) => <option key={k.value} value={k.value}>{k.label}</option>)}
            </select>
          </Field>
          <Field label="Amount">
            <input className="t-body" value={draft.amount} inputMode="decimal"
              onChange={(e) => setDraft({ ...draft, amount: e.target.value })}
              onKeyDown={(e) => { if (e.key === "Enter") submit(); }}
              placeholder="89.99" style={{ width: 110 }} />
          </Field>
          <Field label="Date">
            <input className="t-body" type="date" value={draft.incurredOn} max={today}
              onChange={(e) => setDraft({ ...draft, incurredOn: e.target.value })} style={{ width: "auto" }} />
          </Field>
          <Field label="Reimburses">
            <select className="t-body" value={draft.person} style={{ width: "auto" }}
              onChange={(e) => setDraft({ ...draft, person: e.target.value })}>
              <option value="">Nobody - a company cost</option>
              {people.map((p) => <option key={p.name} value={p.name}>{p.name}</option>)}
            </select>
          </Field>
          <Field label="What it was">
            <input className="t-body" value={draft.description}
              onChange={(e) => setDraft({ ...draft, description: e.target.value })}
              onKeyDown={(e) => { if (e.key === "Enter") submit(); }}
              placeholder="Internet, August" style={{ minWidth: 180 }} />
          </Field>
          <button className="btn sm accent" onClick={submit}
            disabled={pending || !draft.amount.trim() || !draft.description.trim()}>
            {pending ? "Logging..." : "Log"}
          </button>
        </div>
        {error && <div className="t-small" style={{ color: "var(--t-bad-fg)", marginTop: 6 }}>{error}</div>}
      </Panel>

      {[...months.entries()].map(([ym, list]) => (
        <Panel key={ym} title={monthName(ym)}
          hint={formatCents(list.reduce((n, r) => n + r.amountCents, 0))}>
          {list.map((r) => (
            <div key={r.id} className="row-2" style={{ alignItems: "baseline", padding: "5px 0", borderTop: "1px solid var(--line)" }}>
              <span className="t-body" style={{ fontWeight: 700, width: 80 }}>{formatCents(r.amountCents)}</span>
              <span className="pill neutral">{EXPENSE_LABEL[r.kind] ?? r.kind}</span>
              <span className="mut t-small">{mdy(r.incurredOn)}</span>
              <span className="t-small" style={{ flex: 1, minWidth: 0 }}>{r.description}</span>
              {r.person && <span className="mut t-small">reimburses {r.person}</span>}
              <button className="btn link t-meta" style={{ color: "var(--t-bad-fg)" }} disabled={pending}
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
            </div>
          ))}
        </Panel>
      ))}
      {rows.length === 0 && (
        <div className="card"><div className="mut t-body">Nothing logged yet. The first internet bill goes above.</div></div>
      )}
    </>
  );
}
