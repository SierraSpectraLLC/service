"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useState, useTransition } from "react";
import {
  createExpenseReport, logMyExpense, payExpenseReport, returnExpenseReport,
  submitExpenseReport, withdrawExpenseReport,
} from "@/app/actions";
import { REPORT_LABEL, REPORT_TONE, reportSpan, reportTotalCents } from "@/lib/expenseReports";
import { formatCents } from "@/lib/money";
import Dialog, { DialogStatus } from "@/components/ui/Dialog";
import { confirmReason } from "@/components/ui/ConfirmDialog";
import { Panel, Pill } from "@/components/ui";
import { toast } from "@/components/ui/Toast";

export type PoolRow = {
  id: number; kind: string; description: string; amountCents: number;
  incurredOn: string; workOrderNumber: string; billable: boolean;
};
export type ReportRow = {
  id: number; person: string; status: string; submittedAt: string;
  /** The filer's own name for the claim. Blank reads as it always did. */
  title: string;
  paidOn: string; paidRef: string; returnedReason: string; note: string;
  expenses: { id: number; kind: string; description: string; amountCents: number; incurredOn: string }[];
};

/**
 * The reimbursement desk, both sides of it.
 *
 * An engineer sees their pool - every expense of theirs not yet claimed -
 * ticks what this check should cover, and submits. From then on the money has
 * a status they can watch instead of a question they have to ask: Awaiting
 * payout, Paid (with the date and the check number), or Returned (with why,
 * and the rows back in the pool to fix and resubmit).
 *
 * The owner sees the queue: every submitted report, its rows, its summed
 * total - never a stored one - and two honest buttons. Mark paid records
 * that a check went out; it does not move money.
 */
export default function ExpenseReportsPanel({ pool, mine, queue, adminsPeople, isOwner, subjects, today, categories, workOrders }: {
  pool: PoolRow[];
  mine: ReportRow[];
  /** Everyone's reports - for HR and the owner, [] for anybody else. */
  queue: ReportRow[];
  /**
   * Whether this reader administers the people. They see the queue and may
   * open a claim in somebody else's name; PAYING one is separate below,
   * because assembling a claim and writing the check are different jobs.
   */
  adminsPeople: boolean;
  isOwner: boolean;
  /** The roster a claim can be opened for. Empty for anyone who is not HR. */
  subjects: { name: string; email: string }[];
  today: string;
  /** The tenant's expense categories, for the new-expense picker. */
  categories: string[];
  /** Every work order, open or closed - a receipt often surfaces after the job wraps. */
  workOrders: { id: number; label: string }[];
}) {
  const [picked, setPicked] = useState<Set<number>>(new Set());
  const [paying, setPaying] = useState<ReportRow | null>(null);
  const [opening, setOpening] = useState(false);
  const [newDraft, setNewDraft] = useState({ title: "", purpose: "", forWhom: "" });
  const [adding, setAdding] = useState(false);
  const [addDraft, setAddDraft] = useState({ kind: "", description: "", amount: "", incurredOn: "", workOrderId: "" });
  const [addErr, setAddErr] = useState("");
  const [payDraft, setPayDraft] = useState({ paidOn: "", reference: "" });
  const [payErr, setPayErr] = useState("");
  const [pending, startTransition] = useTransition();
  const router = useRouter();

  const chosen = useMemo(() => pool.filter((p) => picked.has(p.id)), [pool, picked]);
  const chosenCents = reportTotalCents(chosen);

  const toggle = (id: number) =>
    setPicked((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });

  const submit = () =>
    startTransition(async () => {
      const res = await submitExpenseReport([...picked]);
      if (res?.error) { toast({ message: res.error }); return; }
      setPicked(new Set());
      toast({ message: `Submitted ${chosen.length} expense${chosen.length === 1 ? "" : "s"} (${formatCents(chosenCents)}) for reimbursement` });
    });

  const reportCard = (r: ReportRow, side: "mine" | "queue") => {
    const total = reportTotalCents(r.expenses);
    return (
      <div key={r.id} style={{ padding: "8px 0", borderTop: "1px solid var(--line)" }}>
        <div style={{ display: "flex", gap: 8, alignItems: "baseline", flexWrap: "wrap" }}>
          <Link href={`/money/reimbursements/${r.id}`} className="btn link" style={{ order: 99, marginLeft: "auto" }}>
            open
          </Link>
          {side === "queue" && <span className="t-body" style={{ fontWeight: 700 }}>{r.person}</span>}
          {r.title && <span className="t-body" style={{ fontWeight: 600 }}>{r.title}</span>}
          {/* A returned report has no rows left - they went back to the pool -
              so a count and a $0 would read as an empty claim, not a bounce. */}
          {r.status === "returned" && r.expenses.length === 0 ? (
            <span className="mut t-small">sent back {r.submittedAt}</span>
          ) : (
            <>
              <span className="t-body" style={{ fontWeight: side === "queue" ? 400 : 700 }}>
                {reportSpan(r.expenses) || "No dated rows"} · {r.expenses.length} expense{r.expenses.length === 1 ? "" : "s"}
              </span>
              <span className="t-body" style={{ fontWeight: 700 }}>{formatCents(total)}</span>
            </>
          )}
          <Pill tone={REPORT_TONE[r.status] ?? "warn"}>{REPORT_LABEL[r.status] ?? r.status}</Pill>
          {r.status === "paid" && (
            <span className="mut t-meta">{r.paidOn}{r.paidRef ? ` · ${r.paidRef}` : ""}</span>
          )}
        </div>
        {r.status === "returned" && r.returnedReason && (
          <div className="t-small" style={{ color: "var(--t-bad-fg)", marginTop: 2 }}>
            Returned: {r.returnedReason} - open it, fix it, resubmit.
          </div>
        )}
        {r.expenses.length > 0 && (
          <div className="mut t-small" style={{ marginTop: 2 }}>
            {r.expenses.slice(0, 4).map((e) => `${e.kind} ${formatCents(e.amountCents)}`).join(" · ")}
            {r.expenses.length > 4 ? ` · +${r.expenses.length - 4} more` : ""}
          </div>
        )}
        {side === "mine" && r.status === "submitted" && (
          <button className="btn link" disabled={pending}
            onClick={() => startTransition(async () => {
              const res = await withdrawExpenseReport(r.id);
              if (res?.error) { toast({ message: res.error }); return; }
              toast({ message: "Back to draft - open it to edit" });
            })}>withdraw</button>
        )}
        {side === "queue" && isOwner && r.status === "submitted" && (
          <div style={{ display: "flex", gap: 6, marginTop: 6 }}>
            <button className="btn sm accent" disabled={pending}
              onClick={() => { setPayDraft({ paidOn: today, reference: "" }); setPayErr(""); setPaying(r); }}>
              Mark paid
            </button>
            <button className="btn sm" disabled={pending}
              onClick={async () => {
                const why = await confirmReason({
                  title: `Return ${r.person}'s report?`,
                  body: "Its expenses go back to their pool to fix and resubmit. They read the reason, so write it to them.",
                  action: "Return it",
                });
                if (why === null) return;
                startTransition(async () => {
                  const res = await returnExpenseReport(r.id, why);
                  if (res?.error) { toast({ message: res.error }); return; }
                  toast({ message: `Returned to ${r.person}` });
                });
              }}>
              Return
            </button>
          </div>
        )}
      </div>
    );
  };

  return (
    <>
      {adminsPeople && (
        <Panel title="Awaiting payout" count={queue.filter((r) => r.status === "submitted").length || undefined}
          hint={isOwner
            ? "Submitted reimbursement claims. Marking one paid records the payout - the check or payroll run happens where it happens."
            : "Submitted reimbursement claims. Open one to check it; the owner marks it paid."}>
          {queue.filter((r) => r.status === "submitted").map((r) => reportCard(r, "queue"))}
          {queue.filter((r) => r.status === "submitted").length === 0 && (
            <div className="mut t-small">Nothing waiting. Engineers submit from this same page.</div>
          )}
          {/* Marking one paid should visibly MOVE the row, not vanish it -
              this is where it lands, so the click has a receipt on screen. */}
          {queue.some((r) => r.status === "paid" || r.status === "returned") && (
            <>
              <div className="eyebrow" style={{ marginTop: 12 }}>Recently settled</div>
              {queue.filter((r) => r.status === "paid" || r.status === "returned").slice(0, 5).map((r) => reportCard(r, "queue"))}
            </>
          )}
        </Panel>
      )}

      <Panel title="Start here" hint="A report is the folder a trip's receipts go into. Open one, scan receipts into it as they happen, submit when the pocket is empty.">
        <button className="btn primary" disabled={pending}
          onClick={() => { setNewDraft({ title: "", purpose: "", forWhom: "" }); setOpening(true); }}>
          + New expense report
        </button>
      </Panel>

      <Panel title="My unclaimed expenses" count={pool.length || undefined}
        hint="Everything of yours not yet on a report. Tick what this claim should cover and submit it.">
        <div style={{ marginBottom: 6 }}>
          <button className="btn sm primary" onClick={() => {
            setAddDraft({ kind: categories[0] ?? "Other", description: "", amount: "", incurredOn: today, workOrderId: "" });
            setAddErr(""); setAdding(true);
          }}>
            + Expense
          </button>
        </div>
        {pool.map((p) => (
          <label key={p.id} className="row-hover"
            style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", padding: "6px 4px", borderTop: "1px solid var(--line)", cursor: "pointer", margin: 0 }}>
            <input type="checkbox" checked={picked.has(p.id)} onChange={() => toggle(p.id)}
              style={{ width: 15, height: 15, flexShrink: 0 }} aria-label={`Select ${p.description}`} />
            <span className="mut t-meta mono">{p.incurredOn}</span>
            <span className="pill neutral">{p.kind}</span>
            <span className="t-body" style={{ flex: "1 1 140px", minWidth: 0 }}>{p.description}</span>
            {p.workOrderNumber && <span className="mut t-meta mono">{p.workOrderNumber}</span>}
            <span className="t-body" style={{ fontWeight: 700 }}>{formatCents(p.amountCents)}</span>
          </label>
        ))}
        {pool.length === 0 && (
          <div className="mut t-small">
            Nothing to claim. Job expenses are logged on their work orders; overhead at Financial › Overhead.
          </div>
        )}
        {picked.size > 0 && (
          <div style={{ marginTop: 10 }}>
            <button className="btn sm accent" disabled={pending} onClick={submit}>
              {pending ? "Submitting..." : `Submit ${picked.size} expense${picked.size === 1 ? "" : "s"} (${formatCents(chosenCents)}) for reimbursement`}
            </button>
          </div>
        )}
      </Panel>

      <Panel title="My reports" count={mine.length || undefined}
        hint="Each claim and where it stands - the status is the answer to 'has that check gone out'.">
        {mine.map((r) => reportCard(r, "mine"))}
        {mine.length === 0 && <div className="mut t-small">No claims yet.</div>}
      </Panel>

      {opening && (
        <Dialog open onClose={() => setOpening(false)} size="sm"
          title="New expense report"
          context="A folder for a trip's receipts. Nothing is claimed until you submit it."
          footer={
            <>
              <button className="btn" onClick={() => setOpening(false)} disabled={pending}>Cancel</button>
              <button className="btn accent" disabled={pending}
                onClick={() => startTransition(async () => {
                  const res = await createExpenseReport({
                    onBehalfOf: newDraft.forWhom || undefined,
                    title: newDraft.title,
                    purpose: newDraft.purpose,
                  });
                  if (res?.error || !res.id) { toast({ message: res.error ?? "That didn't save" }); return; }
                  setOpening(false);
                  router.push(`/money/reimbursements/${res.id}`);
                })}>
                {pending ? "Opening..." : "Open it"}
              </button>
            </>
          }>
          {/* The HR half, folded into the one flow rather than sitting beside
              it as a second button. Somebody hands the office manager a shoebox
              of receipts and never files anything; this opens the claim in
              THEIR name, so the payout is owed to them and the pool it fills
              from is theirs. */}
          {subjects.length > 0 && (
            <>
              <label>Whose claim</label>
              <select value={newDraft.forWhom} aria-label="Whose claim"
                onChange={(e) => setNewDraft({ ...newDraft, forWhom: e.target.value })}>
                <option value="">Mine</option>
                {subjects.map((p) => <option key={p.email} value={p.name}>{p.name}</option>)}
              </select>
              <div className="field-hint">
                Opening one for somebody else fills it from their unclaimed receipts, not yours.
              </div>
            </>
          )}
          <label style={{ marginTop: subjects.length > 0 ? 8 : 0 }}>Name it</label>
          <input value={newDraft.title} aria-label="Report name" autoFocus
            placeholder="Reno install, week of the 12th"
            onChange={(e) => setNewDraft({ ...newDraft, title: e.target.value })} />
          <div className="field-hint">
            Optional. Without one it reads as the person and the dates its receipts cover,
            which tells two reports apart and not much else.
          </div>
          <label style={{ marginTop: 8 }}>What it was for</label>
          <input value={newDraft.purpose} aria-label="Purpose"
            placeholder="Commissioning the new LC-MS at the Reno site"
            onChange={(e) => setNewDraft({ ...newDraft, purpose: e.target.value })} />
          <div className="field-hint">
            The sentence whoever pays it will read before they do.
          </div>
        </Dialog>
      )}

      {adding && (
        <Dialog open onClose={() => setAdding(false)} size="sm" title="New expense"
          context="Logged with your name on it - it lands in your pool above, ready to claim"
          footer={
            <>
              <DialogStatus error={addErr}
                problem={!addDraft.description.trim() ? "say what it was"
                  : !addDraft.amount.trim() ? "enter the amount"
                  : !addDraft.incurredOn ? "pick the date" : null} />
              <button className="btn" onClick={() => setAdding(false)} disabled={pending}>Cancel</button>
              <button className="btn accent"
                disabled={pending || !addDraft.description.trim() || !addDraft.amount.trim() || !addDraft.incurredOn}
                onClick={() => startTransition(async () => {
                  const res = await logMyExpense({
                    kind: addDraft.kind, description: addDraft.description,
                    amount: addDraft.amount, incurredOn: addDraft.incurredOn,
                    workOrderId: addDraft.workOrderId ? parseInt(addDraft.workOrderId, 10) : null,
                  });
                  if (res?.error) { setAddErr(res.error); return; }
                  toast({ message: "Logged - it is in your pool, ready to claim" });
                  setAdding(false);
                })}>
                {pending ? "Logging..." : "Log it"}
              </button>
            </>
          }>
          <div className="pf2" style={{ marginBottom: 8 }}>
            <div>
              <label>Category</label>
              <select value={addDraft.kind} aria-label="Category"
                onChange={(e) => setAddDraft({ ...addDraft, kind: e.target.value })}>
                {categories.map((c) => <option key={c} value={c}>{c}</option>)}
              </select>
            </div>
            <div>
              <label>Amount ($)</label>
              <input value={addDraft.amount} aria-label="Amount" inputMode="decimal" placeholder="43.00" autoFocus
                onChange={(e) => setAddDraft({ ...addDraft, amount: e.target.value })} />
            </div>
          </div>
          <label>What it was</label>
          <input value={addDraft.description} aria-label="What it was" placeholder="Parking, downtown site"
            onChange={(e) => setAddDraft({ ...addDraft, description: e.target.value })} style={{ marginBottom: 8 }} />
          <div className="pf2">
            <div>
              <label>Date</label>
              <input type="date" value={addDraft.incurredOn} max={today} aria-label="Date incurred"
                onChange={(e) => setAddDraft({ ...addDraft, incurredOn: e.target.value })} />
            </div>
            <div>
              <label>For the job</label>
              {/* Open or closed alike - a receipt often surfaces after the job
                  wraps - and "none" files it as overhead. */}
              <select value={addDraft.workOrderId} aria-label="Work order"
                onChange={(e) => setAddDraft({ ...addDraft, workOrderId: e.target.value })}>
                <option value="">No job - overhead</option>
                {workOrders.map((w) => <option key={w.id} value={String(w.id)}>{w.label}</option>)}
              </select>
            </div>
          </div>
        </Dialog>
      )}

      {paying && (
        <Dialog open onClose={() => setPaying(null)} size="sm"
          title={`Pay ${paying.person} ${formatCents(reportTotalCents(paying.expenses))}`}
          context={`${paying.expenses.length} expense${paying.expenses.length === 1 ? "" : "s"}, ${reportSpan(paying.expenses)}`}
          footer={
            <>
              <DialogStatus error={payErr} problem={payDraft.paidOn ? null : "pick the date"} />
              <button className="btn" onClick={() => setPaying(null)} disabled={pending}>Cancel</button>
              <button className="btn accent" disabled={pending || !payDraft.paidOn}
                onClick={() => startTransition(async () => {
                  const res = await payExpenseReport(paying.id, payDraft);
                  if (res?.error) { setPayErr(res.error); return; }
                  toast({ message: `Recorded the payout to ${paying.person}` });
                  setPaying(null);
                })}>
                {pending ? "Recording..." : "Record the payout"}
              </button>
            </>
          }>
          <div className="pf2">
            <div>
              <label>Paid on</label>
              <input type="date" value={payDraft.paidOn} max={today} aria-label="Paid on"
                onChange={(e) => setPayDraft({ ...payDraft, paidOn: e.target.value })} autoFocus />
            </div>
            <div>
              <label>Reference</label>
              <input value={payDraft.reference} aria-label="Payout reference" className="mono"
                placeholder="check 1044, payroll 8/29"
                onChange={(e) => setPayDraft({ ...payDraft, reference: e.target.value })} />
            </div>
          </div>
          <div className="field-hint" style={{ marginTop: 8 }}>
            This records that the money went out - it does not move it.
          </div>
        </Dialog>
      )}
    </>
  );
}
