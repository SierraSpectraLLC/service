"use client";

import { useState, useTransition } from "react";
import { raiseRetainerCycleNow, saveRecurringTerms } from "@/app/actions";
import { anticipated, billCadenceLabel, dueCycles, type RecurringTerms } from "@/lib/recurring";
import { centsToInput, formatCents } from "@/lib/money";
import Dialog, { DialogStatus } from "@/components/ui/Dialog";
import { Panel, Pill } from "@/components/ui";
import { toast } from "@/components/ui/Toast";

export type Retainer = RecurringTerms & {
  id: number;
  orgId: number;
  orgName: string;
  number: string;
  title: string;
};

const CADENCES: [number, string][] = [[1, "Monthly"], [3, "Quarterly"], [6, "Twice a year"], [12, "Annually"]];

const money = (s: string) => Math.round(parseFloat(s.replace(/[^0-9.]/g, "")) * 100);

/**
 * Standing money: what bills itself, and what is coming.
 *
 * A retainer is the one kind of revenue with no job behind it - nobody drove
 * out, nobody logged an hour, and the month falls due anyway - so it has
 * nowhere else in the app to live. It sits with the agreement because the
 * agreement is the piece of paper that says $20,000/month.
 *
 * The card never sends anything and says so. What the schedule produces is a
 * DRAFT in /money, and pressing send stays a person's job: an invoice that
 * left for a client because a cron fired overnight is a decision nobody made.
 */
export default function RetainerCard({ rows, today, canEdit }: {
  rows: Retainer[];
  today: string;
  canEdit: boolean;
}) {
  const [editing, setEditing] = useState<Retainer | null>(null);
  const [draft, setDraft] = useState({ everyMonths: "1", amount: "", description: "", dayOfMonth: "1", leadDays: "7" });
  const [error, setError] = useState("");
  const [pending, startTransition] = useTransition();

  // A year out is the horizon that answers "what does next quarter look like"
  // without turning the card into a spreadsheet.
  const horizon = `${parseInt(today.slice(0, 4), 10) + 1}${today.slice(4)}`;
  const live = rows.filter((r) => r.billEveryMonths > 0);

  const open = (r: Retainer) => {
    setDraft({
      everyMonths: String(r.billEveryMonths || 1),
      amount: r.billAmountCents ? centsToInput(r.billAmountCents) : "",
      description: r.billDescription,
      dayOfMonth: String(r.billDayOfMonth || 1),
      leadDays: String(r.billLeadDays ?? 7),
    });
    setError("");
    setEditing(r);
  };

  const cents = money(draft.amount);
  const every = parseInt(draft.everyMonths, 10);
  const problem = every > 0 && !(cents > 0) ? "say what each cycle bills" : null;

  const save = () =>
    startTransition(async () => {
      if (!editing) return;
      const res = await saveRecurringTerms(editing.id, {
        everyMonths: every,
        amountCents: Number.isFinite(cents) ? cents : 0,
        description: draft.description,
        dayOfMonth: parseInt(draft.dayOfMonth, 10) || 1,
        leadDays: parseInt(draft.leadDays, 10) || 0,
      });
      if (res?.error) { setError(res.error); return; }
      toast({
        message: every === 0
          ? `${editing.number || "Agreement"} no longer bills on a schedule`
          : `${editing.number || "Agreement"} bills ${formatCents(cents)} ${billCadenceLabel(every)}`
            + (res.nextOn ? ` - next ${res.nextOn}` : ""),
      });
      setEditing(null);
    });

  if (!rows.length) return null;

  return (
    <>
      <Panel title="Standing billing" count={live.length || undefined}
        hint="What bills on a schedule with no job behind it. The schedule raises a DRAFT - sending it stays yours.">
        {rows.map((r) => {
          const on = r.billEveryMonths > 0;
          const due = dueCycles(r, today);
          const next = anticipated(r, today, horizon).slice(0, 3);
          const yearCents = anticipated(r, today, horizon).reduce((n, c) => n + c.amountCents, 0);
          return (
            <div key={r.id} style={{ padding: "8px 0", borderTop: "1px solid var(--line)" }}>
              <div style={{ display: "flex", gap: 8, alignItems: "baseline", flexWrap: "wrap" }}>
                <span className="t-body" style={{ fontWeight: 700 }}>{r.number || r.title || `Agreement ${r.id}`}</span>
                <span className="mut t-meta">{r.orgName}</span>
                {on
                  ? <Pill tone="good">{formatCents(r.billAmountCents)} {billCadenceLabel(r.billEveryMonths)}</Pill>
                  : <Pill tone="faint">bills per job</Pill>}
                {/* A cycle sitting due means the pass has not run yet, or the
                    contract only just started billing itself. Saying so beats
                    an empty row that looks like nothing is happening. */}
                {due.length > 0 && (
                  <Pill tone="warn">{due.length} cycle{due.length === 1 ? "" : "s"} ready to raise</Pill>
                )}
                {canEdit && (
                  <button className="btn link" style={{ marginLeft: "auto" }} onClick={() => open(r)}>
                    {on ? "Change" : "Set up"}
                  </button>
                )}
              </div>
              {on && (
                <div className="mut t-small" style={{ marginTop: 4 }}>
                  {r.billDescription || r.title || "Service retainer"}
                  {" - "}
                  {next.length
                    ? <>next {next.map((c) => c.on).join(", ")}{next.length === 3 ? "..." : ""}
                        {yearCents > 0 && <> - {formatCents(yearCents)} anticipated over the next year</>}</>
                    : <>nothing further scheduled{r.endsOn ? ` - the contract ends ${r.endsOn}` : ""}</>}
                  {r.billLeadDays > 0 && <> - drafted {r.billLeadDays} day{r.billLeadDays === 1 ? "" : "s"} ahead</>}
                </div>
              )}
              {on && due.length > 0 && canEdit && (
                <div style={{ marginTop: 6 }}>
                  <button className="btn sm" disabled={pending}
                    onClick={() => startTransition(async () => {
                      const res = await raiseRetainerCycleNow(r.id, due[0]);
                      if (res?.error) { toast({ message: res.error }); return; }
                      toast({ message: `Drafted ${res.number} for the ${due[0]} cycle - open it in Money to send it` });
                    })}>
                    Raise the {due[0]} cycle now
                  </button>
                </div>
              )}
            </div>
          );
        })}
      </Panel>

      {editing && (
        <Dialog open onClose={() => setEditing(null)} size="sm"
          title={`Standing billing for ${editing.number || editing.title || "this agreement"}`}
          context={`${editing.orgName} - raises a draft, never sends it`}
          footer={
            <>
              <DialogStatus error={error} problem={problem} />
              <button className="btn" onClick={() => setEditing(null)} disabled={pending}>Cancel</button>
              <button className="btn accent" onClick={save} disabled={pending || !!problem}>
                {pending ? "Saving..." : every === 0 ? "Stop billing on a schedule" : "Save the schedule"}
              </button>
            </>
          }>
          <div className="dialog-section">How often</div>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 8 }}>
            <div>
              <label>Cadence</label>
              <select value={draft.everyMonths} aria-label="Cadence" style={{ width: "auto" }}
                onChange={(e) => setDraft({ ...draft, everyMonths: e.target.value })}>
                <option value="0">Not on a schedule - bill per job</option>
                {CADENCES.map(([n, label]) => <option key={n} value={String(n)}>{label}</option>)}
              </select>
            </div>
            {every > 0 && (
              <>
                <div style={{ width: 90 }}>
                  <label>On day</label>
                  <input value={draft.dayOfMonth} aria-label="Day of month" inputMode="numeric"
                    onChange={(e) => setDraft({ ...draft, dayOfMonth: e.target.value })} />
                </div>
                <div style={{ width: 110 }}>
                  <label>Draft ahead</label>
                  <input value={draft.leadDays} aria-label="Lead days" inputMode="numeric"
                    onChange={(e) => setDraft({ ...draft, leadDays: e.target.value })} />
                </div>
              </>
            )}
          </div>
          {every > 0 && (
            <>
              {/* A month shorter than the chosen day clamps to its last day -
                  a contract on the 31st bills Feb 28 rather than skipping. */}
              {parseInt(draft.dayOfMonth, 10) > 28 && (
                <div className="field-hint" style={{ marginBottom: 8 }}>
                  Short months bill on their last day, so February is billed, not skipped.
                </div>
              )}
              <div className="dialog-section">How much</div>
              <label>Each cycle ($)</label>
              <input value={draft.amount} aria-label="Amount per cycle" inputMode="decimal" placeholder="20,000"
                onChange={(e) => setDraft({ ...draft, amount: e.target.value })} />
              <label style={{ marginTop: 8 }}>Line description</label>
              <input value={draft.description} aria-label="Line description"
                placeholder={editing.title || "Service retainer"}
                onChange={(e) => setDraft({ ...draft, description: e.target.value })} />
              <div className="field-hint">What the client reads on the invoice line.</div>
            </>
          )}
        </Dialog>
      )}
    </>
  );
}
