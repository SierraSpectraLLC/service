"use client";

import { useState, useTransition } from "react";
import { confirmReason } from "@/components/ui/ConfirmDialog";
import { toast } from "@/components/ui/Toast";
import { deleteExpense, logExpense } from "@/app/actions";
import { EXPENSE_KINDS, EXPENSE_LABEL } from "@/lib/billing";
import { policyConfigured, tripAllowance, type ExpensePolicy } from "@/lib/expensePolicy";
import { formatCents } from "@/lib/money";

export type ExpenseRow = {
  id: number; kind: string; description: string; amountCents: number; incurredOn: string;
  billable: boolean;
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
export default function ExpensesPanel({ workOrderId, rows, today, canEdit, isStaff, policy, sites = [], defaultSiteId = null }: {
  workOrderId: number;
  rows: ExpenseRow[];
  today: string;
  canEdit: boolean;
  isStaff: boolean;
  /** The shop's travel rules, resolved. Unconfigured renders nothing extra. */
  policy?: ExpensePolicy;
  /** The client's labs, with their one-way miles where somebody measured. */
  sites?: { id: number; name: string; onewayMiles: number }[];
  /** The lab the work order's system lives at - the trip's obvious answer. */
  defaultSiteId?: number | null;
}) {
  const [draft, setDraft] = useState({ kind: "mileage", description: "", amount: "", incurredOn: today, billable: true });
  const [error, setError] = useState("");
  // The site answers the miles when it can. Seeding from the system's own lab
  // means a single-site client never touches this at all.
  const initialSite = sites.find((x) => x.id === defaultSiteId) ?? (sites.length === 1 ? sites[0] : undefined);
  const [trip, setTrip] = useState({
    siteId: initialSite?.id ?? null as number | null,
    miles: initialSite && initialSite.onewayMiles > 0 ? String(initialSite.onewayMiles) : "",
    nights: "",
  });
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
      // billable survives the reset on purpose: on a fixed-price job somebody
      // is about to log four receipts in a row, all ours to absorb.
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
          {/* Same control, same words as the Hours panel above it. Unticked
              means ours to absorb: it stays in the job's cost and off the
              invoice draft - no line to remember to delete. */}
          <label className="t-small" style={{ display: "flex", alignItems: "center", gap: 5, margin: 0, whiteSpace: "nowrap" }}>
            <input type="checkbox" checked={draft.billable} style={{ width: 15, height: 15 }}
              onChange={(e) => setDraft({ ...draft, billable: e.target.checked })} />
            Billable
          </label>
          <button className="btn sm accent" onClick={submit} disabled={pending || !draft.amount.trim()}>
            {pending ? "Logging..." : "Log"}
          </button>
        </div>
      )}

      {/* The travel rulebook, applied to THIS trip. The engineer answers the
          two questions only they know - how far, how many nights - and the
          policy answers everything else: whether the stipend already paid,
          what per diem the trip earned, what a room may cost. The buttons log
          the answer, so the amount on the row is the policy's number and not
          somebody's recollection of it. */}
      {canEdit && policy && policyConfigured(policy) && (() => {
        const miles = parseInt(trip.miles, 10) || 0;
        const nights = parseInt(trip.nights, 10) || 0;
        const a = tripAllowance(policy, { oneWayMiles: miles, nights });
        const site = sites.find((x) => x.id === trip.siteId);
        const quickLog = (kind: string, amountCents: number, description: string) => {
          setError("");
          startTransition(async () => {
            const res = await logExpense(workOrderId, {
              kind, description: site ? `${description} - ${site.name}` : description,
              amount: (amountCents / 100).toFixed(2),
              incurredOn: draft.incurredOn, billable: draft.billable, siteId: trip.siteId,
            });
            if (res?.error) { setError(res.error); return; }
            toast({ message: `Logged ${formatCents(amountCents)} - ${description}` });
          });
        };
        return (
          <div className="t-small" style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", padding: "7px 9px", borderRadius: 8, background: "#F4F7FB", marginBottom: rows.length ? 10 : 0 }}>
            <span className="mut">Trip:</span>
            {sites.length > 1 && (
              // Which lab. Picking one answers the miles when the site knows
              // them; the box stays editable because the engineer's own start
              // point wins over the shop's.
              <select className="t-small" value={trip.siteId ?? ""} aria-label="Which site"
                style={{ width: "auto", padding: "3px 6px" }}
                onChange={(e) => {
                  const next = sites.find((x) => x.id === parseInt(e.target.value, 10)) ?? null;
                  setTrip({
                    ...trip, siteId: next?.id ?? null,
                    miles: next && next.onewayMiles > 0 ? String(next.onewayMiles) : trip.miles,
                  });
                }}>
                <option value="">Site?</option>
                {sites.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
              </select>
            )}
            {sites.length === 1 && <span className="mut">{sites[0].name} -</span>}
            <input className="t-small" inputMode="numeric" value={trip.miles} placeholder="mi"
              aria-label="One-way miles from home"
              onChange={(e) => setTrip({ ...trip, miles: e.target.value.replace(/[^0-9]/g, "") })}
              style={{ width: 58, padding: "3px 6px" }} />
            <span className="mut">mi one-way,</span>
            <input className="t-small" inputMode="numeric" value={trip.nights} placeholder="0"
              aria-label="Nights away"
              onChange={(e) => setTrip({ ...trip, nights: e.target.value.replace(/[^0-9]/g, "") })}
              style={{ width: 44, padding: "3px 6px" }} />
            <span className="mut">nights</span>
            {trip.miles === "" ? (
              <span className="mut">- enter the distance and the rules answer.</span>
            ) : a.withinRadius && nights === 0 ? (
              <span style={{ color: "var(--t-warn-fg)", fontWeight: 600 }}>
                Within the {policy.radiusMiles} mi radius - gas and meals ride the car stipend.
              </span>
            ) : (
              <>
                {a.perDiemCents > 0 && (
                  <button className="btn sm" disabled={pending}
                    onClick={() => quickLog("per_diem",
                      a.perDiemCents,
                      `Per diem, ${a.perDiemBreakdown}${miles ? ` - ${miles} mi` : ""}`)}>
                    Log per diem {formatCents(a.perDiemCents)}
                  </button>
                )}
                {a.hotelNightCapCents > 0 && (
                  <span className="mut">
                    Lodging up to {formatCents(a.hotelNightCapCents)}/night - log the receipt as Lodging.
                  </span>
                )}
                {!a.withinRadius && nights === 0 && a.perDiemCents === 0 && (
                  <span className="mut">Beyond the radius - receipts are on us.</span>
                )}
              </>
            )}
          </div>
        );
      })()}

      {rows.map((r) => (
        <div key={r.id} className="row-2" style={{ alignItems: "baseline", padding: "5px 0", borderTop: "1px solid var(--line)" }}>
          <span className="t-body" style={{ fontWeight: 700, width: 70 }}>{formatCents(r.amountCents)}</span>
          <span className="pill neutral">{EXPENSE_LABEL[r.kind] ?? r.kind}</span>
          {!r.billable && <span className="pill faint" title="Ours to absorb - counts in the job cost, never reaches the invoice">not billed</span>}
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
