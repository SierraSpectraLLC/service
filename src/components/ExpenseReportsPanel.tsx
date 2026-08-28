"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useState, useTransition } from "react";
import {
  createExpenseReport, logMyExpense, payExpenseReport, returnExpenseReport,
  withdrawExpenseReport,
} from "@/app/actions";
import {
  REPORT_LABEL, REPORT_TONE, checkReportTitle, deskReports, reportPeople, reportSpan,
  reportTitle, reportTotalCents,
} from "@/lib/expenseReports";
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
  /** The filer's own name for the claim. Every report opened since the form insisted has one. */
  title: string;
  /** The job it is filed against, or "" for an overhead claim. */
  workOrderNumber: string;
  workOrderId: number | null;
  /** Who filed it, when that is not whose money it is. */
  openedByName: string;
  paidOn: string; paidRef: string; returnedReason: string; note: string;
  expenses: { id: number; kind: string; description: string; amountCents: number; incurredOn: string }[];
};

/** The work-order picker's unanswered state, kept distinct from "overhead". */
const NO_JOB = "none";

/**
 * The reimbursement desk, both sides of it.
 *
 * An engineer sees their pool - every expense of theirs not yet claimed -
 * opens a report for the trip, and watches the money instead of asking about
 * it: Awaiting payout, Paid (with the date and the check number), or Returned
 * (with why, the rows still on it, to fix and resubmit).
 *
 * The owner and HR see the SHOP's claims, all of them. That last word is the
 * fix: this panel used to show them the submitted queue and a tail of settled
 * reports, so a draft an engineer opened and never sent was visible to nobody
 * but its author - which is exactly the claim somebody needs to chase. The
 * three panels below are lib/expenseReports.deskReports, in the order the
 * questions get asked: what is on my desk, what is still being written, what
 * has gone out.
 *
 * Marking one paid records that a check went out. It does not move money.
 */
export default function ExpenseReportsPanel({
  pool, mine, queue, adminsPeople, isOwner, subjects, me, openFor, today, categories, workOrders,
}: {
  pool: PoolRow[];
  mine: ReportRow[];
  /** Everyone's reports, every status - for HR and the owner, [] for anybody else. */
  queue: ReportRow[];
  /**
   * Whether this reader administers the people. They see the whole desk and
   * may open a claim in somebody else's name; PAYING one is separate below,
   * because assembling a claim and writing the check are different jobs.
   */
  adminsPeople: boolean;
  isOwner: boolean;
  /** The roster a claim can be opened for. Empty for anyone who is not HR. */
  subjects: { name: string; email: string }[];
  /** The reader's own directory name, for "Mine" in the whose-claim picker. */
  me: string;
  /**
   * A name arrived at from the People desk - "open a claim for this person".
   * It opens the one create dialog with them chosen, rather than minting a
   * nameless report the way the roster button used to.
   */
  openFor: string;
  today: string;
  /** The tenant's expense categories, for the new-expense picker. */
  categories: string[];
  /** Every work order, open or closed - a receipt often surfaces after the job wraps. */
  workOrders: { id: number; label: string }[];
}) {
  const [picked, setPicked] = useState<Set<number>>(new Set());
  const [paying, setPaying] = useState<ReportRow | null>(null);
  /* Arriving from the People desk with somebody chosen - "open a claim for
     this person" is that page's whole gesture, and it now comes here rather
     than minting a nameless report of its own. Initial state, not an effect:
     the link is a route change, so the panel mounts fresh with the dialog
     already open on the right name. */
  const [opening, setOpening] = useState(openFor !== "");
  const [newDraft, setNewDraft] = useState({ title: "", purpose: "", forWhom: openFor, workOrderId: "" });
  const [openErr, setOpenErr] = useState("");
  const [adding, setAdding] = useState(false);
  const [addDraft, setAddDraft] = useState({ kind: "", description: "", amount: "", incurredOn: "", workOrderId: "" });
  const [addErr, setAddErr] = useState("");
  const [payDraft, setPayDraft] = useState({ paidOn: "", reference: "" });
  const [payErr, setPayErr] = useState("");
  const [who, setWho] = useState("");
  const [pending, startTransition] = useTransition();
  const router = useRouter();

  const chosen = useMemo(() => pool.filter((p) => picked.has(p.id)), [pool, picked]);
  const chosenCents = reportTotalCents(chosen);

  const toggle = (id: number) =>
    setPicked((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });

  const openNew = (forWhom = "") => {
    setNewDraft({ title: "", purpose: "", forWhom, workOrderId: "" });
    setOpenErr(""); setOpening(true);
  };

  /* The shop's claims, split the way they get asked about. One authority, so
     this panel and the tests behind it cannot drift. */
  const desk = useMemo(() => deskReports(queue), [queue]);
  const everyone = useMemo(() => reportPeople(queue), [queue]);
  const byWho = (rows: ReportRow[]) => (who ? rows.filter((r) => r.person === who) : rows);

  const named = checkReportTitle(newDraft.title);
  const newProblem = "error" in named ? named.error
    : !newDraft.workOrderId ? "pick the job it is for, or say it is overhead"
    : null;

  const reportCard = (r: ReportRow, side: "mine" | "queue") => {
    const total = reportTotalCents(r.expenses);
    return (
      <div key={r.id} style={{ padding: "8px 0", borderTop: "1px solid var(--line)" }}>
        <div style={{ display: "flex", gap: 8, alignItems: "baseline", flexWrap: "wrap" }}>
          <Link href={`/money/reimbursements/${r.id}`} className="btn link" style={{ order: 99, marginLeft: "auto" }}>
            open
          </Link>
          {side === "queue" && <span className="t-body" style={{ fontWeight: 700 }}>{r.person}</span>}
          <span className="t-body" style={{ fontWeight: 600 }}>{reportTitle(r, r.expenses)}</span>
          {/* The job the claim is filed against - the fact a reviewer reaches
              for first, and the reason overhead says so out loud rather than
              showing nothing and reading as a gap. */}
          {r.workOrderNumber
            ? <span className="mut t-meta mono">{r.workOrderNumber}</span>
            : <span className="pill faint">overhead</span>}
          <span className="t-body">
            {reportSpan(r.expenses) || "no dated rows"} · {r.expenses.length} expense{r.expenses.length === 1 ? "" : "s"}
          </span>
          <span className="t-body" style={{ fontWeight: 700 }}>{formatCents(total)}</span>
          <Pill tone={REPORT_TONE[r.status] ?? "warn"}>{REPORT_LABEL[r.status] ?? r.status}</Pill>
          {r.status === "paid" && (
            <span className="mut t-meta">{r.paidOn}{r.paidRef ? ` · ${r.paidRef}` : ""}</span>
          )}
        </div>
        {/* Who filed it, only when that is not whose money it is - which is the
            only time the question comes up, and the time it always does. */}
        {r.openedByName && r.openedByName !== r.person && (
          <div className="mut t-small" style={{ marginTop: 2 }}>Opened by {r.openedByName}</div>
        )}
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
                  body: "Its rows stay on it, so they fix the claim in place and resubmit. They read the reason, so write it to them.",
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

  /* One filter across the three shop-wide panels: an owner chasing a person
     wants that person's claims in every state at once, which is a filter and
     not three separate searches. */
  const whoFilter = everyone.length > 1 && (
    <select value={who} aria-label="Whose claims" className="sm"
      onChange={(e) => setWho(e.target.value)}>
      <option value="">Everybody</option>
      {everyone.map((p) => <option key={p} value={p}>{p}</option>)}
    </select>
  );

  return (
    <>
      {adminsPeople && (
        <>
          <Panel title="Awaiting payout" count={byWho(desk.awaiting).length || undefined}
            actions={whoFilter}
            hint={isOwner
              ? "Claims that have been handed to you. Marking one paid records the payout - the check or payroll run happens where it happens."
              : "Claims that have been handed to the owner. Open one to check it; the owner marks it paid."}>
            {byWho(desk.awaiting).map((r) => reportCard(r, "queue"))}
            {byWho(desk.awaiting).length === 0 && (
              <div className="mut t-small">Nothing waiting on a check.</div>
            )}
          </Panel>

          {/*
            The half of the desk that was missing. A claim nobody has sent is
            still money the shop owes, and until now the only person who could
            see one was whoever opened it - so "what has my shop got open" was
            answered with "what has been handed to me", and the difference was
            every draft anybody had got distracted from.
          */}
          <Panel title="Being filled right now" count={byWho(desk.filling).length || undefined}
            actions={whoFilter}
            hint="Reports your people have opened and not yet submitted - drafts, and claims you sent back. Money the shop owes that nobody has asked for yet.">
            {byWho(desk.filling).map((r) => reportCard(r, "queue"))}
            {byWho(desk.filling).length === 0 && (
              <div className="mut t-small">
                {who ? `Nothing open in ${who}'s name.` : "Nobody has a claim part-written."}
              </div>
            )}
          </Panel>

          {/* Marking one paid should visibly MOVE the row, not vanish it -
              this is where it lands, so the click has a receipt on screen. */}
          {byWho(desk.paid).length > 0 && (
            <Panel title="Recently paid" count={byWho(desk.paid).length || undefined} actions={whoFilter}
              hint="Payouts recorded here. The money moved wherever it moves - this is the record that it did.">
              {byWho(desk.paid).slice(0, 8).map((r) => reportCard(r, "queue"))}
            </Panel>
          )}
        </>
      )}

      <Panel title="Start here"
        hint="A report is the folder a trip's receipts go into: name it, say which job it was for, then add the expenses one at a time. Nothing is claimed until you submit it.">
        <button className="btn primary" disabled={pending} onClick={() => openNew()}>
          + New expense report
        </button>
      </Panel>

      <Panel title="My unclaimed expenses" count={pool.length || undefined}
        hint="Everything of yours not yet on a report. Tick what a claim should cover and it opens a report with those rows already on it.">
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
            {/* The same door as "+ New expense report", carrying the ticked
                rows. This used to mint a nameless report already awaiting
                payout; now it opens the claim, names it, and leaves a draft to
                look over before anybody is asked for a check. */}
            <button className="btn sm accent" disabled={pending} onClick={() => openNew()}>
              Claim {picked.size} expense{picked.size === 1 ? "" : "s"} ({formatCents(chosenCents)})
            </button>
          </div>
        )}
      </Panel>

      <Panel title="My reports" count={mine.length || undefined}
        hint="Each claim of mine and where it stands - the status is the answer to 'has that check gone out'.">
        {mine.map((r) => reportCard(r, "mine"))}
        {mine.length === 0 && <div className="mut t-small">No claims yet.</div>}
      </Panel>

      {opening && (
        <Dialog open onClose={() => setOpening(false)} size="sm"
          title="New expense report"
          context={picked.size
            ? `${picked.size} ticked expense${picked.size === 1 ? "" : "s"} (${formatCents(chosenCents)}) go onto it`
            : "A folder for a trip's receipts. Nothing is claimed until you submit it."}
          footer={
            <>
              <DialogStatus error={openErr} problem={newProblem} />
              <button className="btn" onClick={() => setOpening(false)} disabled={pending}>Cancel</button>
              <button className="btn accent" disabled={pending || newProblem !== null}
                onClick={() => startTransition(async () => {
                  const res = await createExpenseReport({
                    onBehalfOf: newDraft.forWhom || undefined,
                    title: newDraft.title,
                    purpose: newDraft.purpose,
                    // The picker's own empty string never reaches here - the
                    // button is disabled until it is answered - so this is
                    // "overhead" or an id, never "the field was skipped".
                    workOrderId: newDraft.workOrderId === NO_JOB ? null : parseInt(newDraft.workOrderId, 10),
                    expenseIds: [...picked],
                  });
                  if (res?.error || !res.id) { setOpenErr(res.error ?? "That didn't save"); return; }
                  setPicked(new Set());
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
              from is theirs. Who actually opened it is recorded either way. */}
          {subjects.length > 0 && (
            <>
              <label>Whose claim</label>
              <select value={newDraft.forWhom} aria-label="Whose claim"
                onChange={(e) => setNewDraft({ ...newDraft, forWhom: e.target.value })}>
                <option value="">Mine{me ? ` (${me})` : ""}</option>
                {subjects.filter((p) => p.name !== me).map((p) => (
                  <option key={p.email} value={p.name}>{p.name}</option>
                ))}
              </select>
              <div className="field-hint">
                Opening one for somebody else fills it from their unclaimed receipts, not yours,
                and the payout is owed to them. Your name goes on it as who filed it.
              </div>
            </>
          )}
          <label style={{ marginTop: subjects.length > 0 ? 8 : 0 }}>Name it</label>
          <input value={newDraft.title} aria-label="Report name" autoFocus
            placeholder="Reno install, week of the 12th"
            onChange={(e) => setNewDraft({ ...newDraft, title: e.target.value })} />
          <div className="field-hint">
            What whoever pays it will read on the list. Everybody&apos;s claims sit on one desk now,
            so &quot;a week in July&quot; is not enough to tell two apart.
          </div>
          {/* The job. Open or closed alike - a receipt surfaces long after the
              order it belongs to wraps - and "no job" is a deliberate answer
              rather than a skipped field, which is why it starts unset. */}
          <label style={{ marginTop: 8 }}>The job it is for</label>
          <select value={newDraft.workOrderId} aria-label="Work order"
            onChange={(e) => setNewDraft({ ...newDraft, workOrderId: e.target.value })}>
            <option value="">Pick the job...</option>
            <option value={NO_JOB}>No job - overhead</option>
            {workOrders.map((w) => <option key={w.id} value={String(w.id)}>{w.label}</option>)}
          </select>
          <div className="field-hint">
            Open or closed - the receipts usually turn up after the job does. Pick overhead for
            spend no job caused, the way the internet bill is.
          </div>
          <label style={{ marginTop: 8 }}>What it was for</label>
          <input value={newDraft.purpose} aria-label="Purpose"
            placeholder="Commissioning the new LC-MS at the Reno site"
            onChange={(e) => setNewDraft({ ...newDraft, purpose: e.target.value })} />
          <div className="field-hint">
            Optional. The sentence whoever pays it will read before they do.
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
          context={`${reportTitle(paying, paying.expenses)} · ${paying.expenses.length} expense${paying.expenses.length === 1 ? "" : "s"}, ${reportSpan(paying.expenses) || "no dated rows"}`}
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
