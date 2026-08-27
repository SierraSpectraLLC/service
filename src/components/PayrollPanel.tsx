"use client";

import { useState, useTransition } from "react";
import { addPayrollEntry, deletePayrollEntry, endPayrollEntry, useDerivedLaborRate } from "@/app/actions";
import Dialog, { DialogStatus } from "@/components/ui/Dialog";
import { confirmReason } from "@/components/ui/ConfirmDialog";
import { toast } from "@/components/ui/Toast";
import { Field, Panel, Pill } from "@/components/ui";
import { formatCents } from "@/lib/money";
import { monthName, PAY_KINDS } from "@/lib/payroll";

export type PayrollRow = {
  id: number; name: string; title: string; personEmail: string;
  kind: string; amountCents: number; hoursPerWeek: number;
  ftePct: number; burdenPct: number; effectiveOn: string; endsOn: string; note: string;
};

export type MonthRow = {
  ym: string;
  payrollCents: number;
  otherCents: number;
  totalCents: number;
  headcount: number;
  billedMinutes: number;
  loadedCents: number | null;
  people: { id: number; name: string; title: string; kind: string; monthlyCents: number; ftePct: number }[];
};

const kindLabel = (k: string) => PAY_KINDS.find((x) => x.key === k)?.label ?? k;
const unitOf = (k: string) => PAY_KINDS.find((x) => x.key === k)?.unit ?? "";

/**
 * The register, and what it makes a month cost.
 *
 * Pay is added, never edited: a change closes the row in force and opens a new
 * one, so the months behind it keep saying what they cost. The form calls that
 * out rather than hiding it, because somebody who expects an edit and gets a
 * second row will otherwise think it double-counted - it does not, and the
 * month total is the place that proves it.
 */
export default function PayrollPanel({
  orgId, orgName, rows, months, today, whole, mayEdit, showRate, staff = [],
}: {
  orgId: number;
  orgName: string;
  rows: PayrollRow[];
  months: MonthRow[];
  today: string;
  /** Whether this reader gets the whole register or only their own row. */
  whole: boolean;
  mayEdit: boolean;
  /** The derived cost of a sold hour - only the shop has jobs to divide by. */
  showRate: boolean;
  /**
   * People this organization already knows about - its own staff, or a
   * client's own list. Picking one fills the form and, more importantly,
   * ATTACHES the row to their account, which is what lets them see their own
   * pay and nobody else's.
   */
  staff?: { email: string; name: string; title: string; already: boolean }[];
}) {
  const BLANK = {
    name: "", personEmail: "", title: "", kind: "salary", amount: "",
    hoursPerWeek: 40, ftePct: 100, burdenPct: 0, effectiveOn: today, note: "",
  };
  const [draft, setDraft] = useState(BLANK);
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState("");
  const [pending, startTransition] = useTransition();

  const current = rows.filter((r) => !r.endsOn || r.endsOn >= today);
  const past = rows.filter((r) => r.endsOn && r.endsOn < today);
  const problem = !draft.name.trim() ? "whose pay this is"
    : !draft.amount.trim() ? "what they are paid"
    : !draft.effectiveOn ? "the day it takes effect" : null;

  const save = () => {
    if (problem) return;
    setError("");
    startTransition(async () => {
      const res = await addPayrollEntry(orgId, draft);
      if (res?.error) { setError(res.error); return; }
      toast({
        message: res.superseded
          ? `Saved. Their previous pay now ends ${res.superseded}, so the months before it are unchanged.`
          : `Put ${draft.name.trim()} on the payroll`,
      });
      setAdding(false); setDraft(BLANK);
    });
  };

  // The person this row is about, and the pay itself, on one line.
  const payLine = (r: PayrollRow) => {
    const amount = r.kind === "hourly" ? `${formatCents(r.amountCents)}/h × ${r.hoursPerWeek} h a week`
      : `${formatCents(r.amountCents)} ${unitOf(r.kind)}`;
    return [
      amount,
      r.ftePct !== 100 ? `${r.ftePct}% time` : "",
      r.burdenPct ? `+${r.burdenPct}% employer costs` : "",
    ].filter(Boolean).join(" · ");
  };

  return (
    <>
      {whole && months.length > 0 && (
        <Panel title="What a month costs"
          hint={showRate ? "Payroll, plus the running costs with a receipt" : "Payroll"}
          actions={mayEdit ? (
            <button className="btn sm primary" onClick={() => { setDraft(BLANK); setError(""); setAdding(true); }}>
              + Add somebody
            </button>
          ) : undefined}>
          {months.map((m) => (
            <div key={m.ym} style={{ display: "flex", alignItems: "baseline", gap: 10, padding: "7px 0", borderTop: "1px solid var(--line)", flexWrap: "wrap" }}>
              <span className="t-body" style={{ fontWeight: 700, minWidth: 130 }}>{monthName(m.ym)}</span>
              <span className="t-body" style={{ fontWeight: 700 }}>{formatCents(m.totalCents)}</span>
              <span className="mut t-small" style={{ flex: 1, minWidth: 0 }}>
                {formatCents(m.payrollCents)} payroll
                {m.headcount > 0 && ` · ${m.headcount % 1 === 0 ? m.headcount : m.headcount.toFixed(1)} ${m.headcount === 1 ? "person" : "people"}`}
                {showRate && m.otherCents > 0 && ` · ${formatCents(m.otherCents)} running costs`}
              </span>
              {/* What an hour of sold work has to carry. The number job costing
                  has been guessing at, finally derived from what is real. */}
              {showRate && m.loadedCents !== null && (
                <span className="pill info" title={`${Math.round(m.billedMinutes / 60)} billable hours in the month`}>
                  {formatCents(m.loadedCents)}/h loaded
                </span>
              )}
              {showRate && m.loadedCents === null && m.totalCents > 0 && (
                <span className="mut t-meta">no billable hours yet</span>
              )}
            </div>
          ))}
          {/* Adopting it is a deliberate act, not a silent override: costing
              has always read one number, and this makes that number derived. */}
          {showRate && months[0]?.loadedCents !== null && (
            <div style={{ marginTop: 10, display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
              <button className="btn sm" disabled={pending}
                onClick={() => startTransition(async () => {
                  const res = await useDerivedLaborRate(months[0].loadedCents!);
                  if (res?.error) { setError(res.error); return; }
                  toast({ message: `Job costing now uses ${formatCents(months[0].loadedCents!)}/h` });
                })}>
                Use {formatCents(months[0].loadedCents!)}/h for job costing
              </button>
              <span className="mut t-meta">
                Costing reads one loaded-labor rate. This replaces the typed guess with {monthName(months[0].ym)}&apos;s real figure.
              </span>
            </div>
          )}
        </Panel>
      )}

      <Panel title={whole ? <>On the payroll at {orgName}</> : "Your pay"}
        count={whole ? current.length : undefined}
        actions={mayEdit && !whole ? undefined : undefined}>
        {current.map((r) => (
          <div key={r.id} style={{ display: "flex", alignItems: "baseline", gap: 8, padding: "7px 0", borderTop: "1px solid var(--line)", flexWrap: "wrap" }}>
            <span className="t-body" style={{ fontWeight: 600 }}>{r.name}</span>
            {r.title && <span className="mut t-meta">{r.title}</span>}
            <Pill tone="neutral">{kindLabel(r.kind)}</Pill>
            <span className="t-small" style={{ flex: 1, minWidth: 0 }}>{payLine(r)}</span>
            <span className="mut t-meta">from {r.effectiveOn}{r.endsOn ? ` to ${r.endsOn}` : ""}</span>
            {mayEdit && (
              <span style={{ display: "flex", gap: 8 }}>
                <button className="btn link t-meta" disabled={pending}
                  onClick={() => {
                    setDraft({
                      name: r.name, personEmail: r.personEmail, title: r.title, kind: r.kind,
                      amount: (r.amountCents / 100).toFixed(2), hoursPerWeek: r.hoursPerWeek,
                      ftePct: r.ftePct, burdenPct: r.burdenPct, effectiveOn: today, note: "",
                    });
                    setError(""); setAdding(true);
                  }}>change pay</button>
                <button className="btn link t-meta" disabled={pending}
                  onClick={() => startTransition(async () => {
                    const res = await endPayrollEntry(r.id, today);
                    if (res?.error) { setError(res.error); return; }
                    toast({ message: `${r.name} ends today` });
                  })}>they left</button>
                <button className="btn link t-meta" style={{ color: "var(--t-bad-fg)" }} disabled={pending}
                  onClick={async () => {
                    const why = await confirmReason({
                      title: `Delete ${r.name}'s pay row?`,
                      body: "For a row typed wrong. If they left, use 'they left' instead - that keeps what the months before cost.",
                      action: "Delete row", tone: "bad",
                    });
                    if (!why) return;
                    startTransition(async () => {
                      const res = await deletePayrollEntry(r.id, why);
                      if (res?.error) { setError(res.error); return; }
                      toast({ message: `Deleted ${r.name}'s row` });
                    });
                  }}>delete</button>
              </span>
            )}
          </div>
        ))}
        {current.length === 0 && (
          <div className="mut t-small" style={{ padding: "6px 0" }}>Nobody currently on it.</div>
        )}

        {past.length > 0 && (
          <details style={{ borderTop: "1px solid var(--line)", marginTop: 6 }}>
            <summary style={{ cursor: "pointer", padding: "8px 4px", fontSize: 13 }}>
              <b>Ended</b> <span className="mut">· {past.length}</span>
            </summary>
            {past.map((r) => (
              <div key={r.id} className="mut" style={{ display: "flex", gap: 8, padding: "5px 0", borderTop: "1px solid var(--line)", flexWrap: "wrap" }}>
                <span className="t-small" style={{ fontWeight: 600 }}>{r.name}</span>
                <span className="t-small" style={{ flex: 1, minWidth: 0 }}>{payLine(r)}</span>
                <span className="t-meta">{r.effectiveOn} to {r.endsOn}</span>
              </div>
            ))}
          </details>
        )}
        {error && <div className="t-small" style={{ color: "var(--t-bad-fg)", marginTop: 8 }}>{error}</div>}
      </Panel>

      {adding && (
        <Dialog open onClose={() => setAdding(false)} size="md"
          title={draft.name ? `Pay for ${draft.name}` : "Add somebody to the payroll"}
          context="Pay is dated. A change closes the current line and opens a new one, so the months already counted stay as they were."
          footer={
            <>
              <DialogStatus error={error} problem={problem} ok="Ready to save." />
              <button className="btn" onClick={() => setAdding(false)} disabled={pending}>Cancel</button>
              <button className="btn accent" onClick={save} disabled={pending || !!problem}>
                {pending ? "Saving..." : "Save"}
              </button>
            </>
          }>
          <div className="dialog-section">Who</div>
          {/* The list the app already has. Choosing somebody fills the three
              fields below AND ties the row to their login - a payroll row with
              nobody's address on it is one that person can never check. */}
          {staff.length > 0 && (
            <div style={{ marginBottom: 8 }}>
              <label>Pick somebody</label>
              <select value={draft.personEmail} aria-label="Pick somebody"
                onChange={(e) => {
                  const hit = staff.find((x) => x.email === e.target.value);
                  if (!hit) { setDraft({ ...draft, personEmail: "" }); return; }
                  setDraft({
                    ...draft, personEmail: hit.email,
                    name: hit.name, title: hit.title || draft.title,
                  });
                }}>
                <option value="">Somebody not on the list - type them below</option>
                {staff.map((x) => (
                  <option key={x.email} value={x.email}>
                    {x.name}{x.title ? ` - ${x.title}` : ""}{x.already ? " · already on the payroll" : ""}
                  </option>
                ))}
              </select>
              {draft.personEmail && staff.some((x) => x.email === draft.personEmail && x.already) && (
                <div className="mut t-meta" style={{ marginTop: 4 }}>
                  They already have a line. Saving this closes it the day before and starts a new one,
                  so the months already counted stay as they were.
                </div>
              )}
            </div>
          )}
          <div className="pf3" style={{ marginBottom: 8 }}>
            <div>
              <label>Name *</label>
              <input value={draft.name} autoFocus placeholder="Steve Jones"
                onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
            </div>
            <div>
              <label>Job title</label>
              <input value={draft.title} placeholder="Field engineer"
                onChange={(e) => setDraft({ ...draft, title: e.target.value })} />
            </div>
            <div>
              <label>Their login</label>
              {/* What lets somebody see their own row without seeing anybody
                  else's. Optional: most of a payroll has no account. */}
              <input value={draft.personEmail} className="mono" inputMode="email" placeholder="optional"
                onChange={(e) => setDraft({ ...draft, personEmail: e.target.value })} />
            </div>
          </div>

          <div className="dialog-section">Pay</div>
          <div className="row-2" style={{ alignItems: "flex-end", flexWrap: "wrap", marginBottom: 8 }}>
            <Field label="How">
              <select value={draft.kind} style={{ width: "auto" }}
                onChange={(e) => setDraft({ ...draft, kind: e.target.value })}>
                {PAY_KINDS.map((k) => <option key={k.key} value={k.key}>{k.label}</option>)}
              </select>
            </Field>
            <Field label="Amount *">
              <input value={draft.amount} inputMode="decimal" style={{ width: 130 }}
                placeholder={draft.kind === "hourly" ? "45.00" : draft.kind === "monthly" ? "4,000" : "96,000"}
                onChange={(e) => setDraft({ ...draft, amount: e.target.value })} />
            </Field>
            <span className="mut t-small" style={{ paddingBottom: 8 }}>
              {PAY_KINDS.find((k) => k.key === draft.kind)?.unit}
            </span>
            {draft.kind === "hourly" && (
              <Field label="Hours a week">
                <input type="number" min={1} max={80} value={draft.hoursPerWeek} style={{ width: 90 }}
                  onChange={(e) => setDraft({ ...draft, hoursPerWeek: parseInt(e.target.value) || 40 })} />
              </Field>
            )}
          </div>
          <div className="row-2" style={{ alignItems: "flex-end", flexWrap: "wrap", marginBottom: 8 }}>
            <Field label="Time worked">
              <select value={draft.ftePct} style={{ width: "auto" }}
                onChange={(e) => setDraft({ ...draft, ftePct: parseInt(e.target.value) })}>
                <option value={100}>Full time</option>
                <option value={80}>80%</option>
                <option value={60}>60%</option>
                <option value={50}>Half time</option>
                <option value={25}>25%</option>
              </select>
            </Field>
            <Field label="Employer costs on top">
              {/* Payroll taxes, insurance, the benefits line - the part that
                  makes a wage cost more than the wage. A contractor carries
                  none, which is why this is per person. */}
              <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                <input type="number" min={0} max={200} value={draft.burdenPct} style={{ width: 80 }}
                  onChange={(e) => setDraft({ ...draft, burdenPct: parseInt(e.target.value) || 0 })} />
                <span className="mut t-small">%</span>
              </div>
            </Field>
            <Field label="Takes effect *">
              <input type="date" value={draft.effectiveOn} style={{ width: "auto" }}
                onChange={(e) => setDraft({ ...draft, effectiveOn: e.target.value })} />
            </Field>
          </div>
          <label>Note</label>
          <input value={draft.note} placeholder="Annual review, promotion, contract change"
            onChange={(e) => setDraft({ ...draft, note: e.target.value })} />
        </Dialog>
      )}
    </>
  );
}
