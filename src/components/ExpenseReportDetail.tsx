"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { upload } from "@vercel/blob/client";
import {
  attachPoolExpenses, deleteExpenseReport, logMyExpense, nameExpenseReport, payExpenseReport,
  removeReportExpense, returnExpenseReport, setReportWorkOrder, submitDraftReport,
  withdrawExpenseReport,
} from "@/app/actions";
import {
  REPORT_LABEL, REPORT_TONE, checkReportTitle, editableReport, reportSpan, reportTotalCents,
} from "@/lib/expenseReports";
import { formatCents } from "@/lib/money";
import Dialog, { DialogStatus } from "@/components/ui/Dialog";
import { confirmDialog, confirmReason } from "@/components/ui/ConfirmDialog";
import { Panel, Pill } from "@/components/ui";
import { toast } from "@/components/ui/Toast";

export type ReportExpense = {
  id: number; kind: string; description: string; amountCents: number; incurredOn: string;
  workOrderId: number | null; workOrderNumber: string; receiptUrl: string; receiptName: string;
};

/**
 * One expense report, opened like a record: the rows it claims, the receipt
 * behind each, and the actions its status allows.
 *
 * The empty-pocket flow this exists for: open a draft on the phone, and for
 * each crumpled receipt hit "+ Expense", tap "Scan receipt" - which opens the
 * CAMERA directly, the Lens move - type the amount, pick the job (open or
 * closed, or none), done. When the pocket is empty, Submit. The photo goes to
 * the same blob store the app's other files use.
 */
export default function ExpenseReportDetail({ report, rows, mayWork, mine, isOwner, today, categories, workOrders, pool }: {
  report: {
    id: number; person: string; status: string; submittedAt: string;
    paidOn: string; paidRef: string; returnedReason: string;
    /** The filer's own words. The name is required now; the purpose is not. */
    title: string; purpose: string;
    /** The job this claim is for. Null is "no job - overhead", a real answer. */
    workOrderId: number | null;
    workOrderNumber: string;
    /** Who filed it, shown only when that is somebody other than its claimant. */
    openedByName: string;
  };
  rows: ReportExpense[];
  /**
   * May this reader FILL this claim - their own, or anybody's if they are HR.
   * Every editing affordance hangs off this rather than off `mine`, because
   * the office manager filing for an engineer is doing exactly the same job
   * the engineer would be doing.
   */
  mayWork: boolean;
  /** Whether it is the reader's OWN money. Only the wording turns on this. */
  mine: boolean;
  isOwner: boolean;
  today: string;
  categories: string[];
  workOrders: { id: number; label: string }[];
  /** The claimant's unclaimed expenses, offered for pulling onto an open report. */
  pool: { id: number; kind: string; description: string; amountCents: number; incurredOn: string }[];
}) {
  const router = useRouter();
  const editable = mayWork && editableReport(report.status);
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState({ kind: "", description: "", amount: "", incurredOn: "", workOrderId: "" });
  const [receipt, setReceipt] = useState<File | null>(null);
  const [addErr, setAddErr] = useState("");
  const [busy, setBusy] = useState("");
  const [pulling, setPulling] = useState(false);
  const [pulled, setPulled] = useState<Set<number>>(new Set());
  const [paying, setPaying] = useState(false);
  const [payDraft, setPayDraft] = useState({ paidOn: "", reference: "" });
  const [payErr, setPayErr] = useState("");
  const [pending, startTransition] = useTransition();

  /* Whose money the copy is about. HR filling a colleague's claim reads the
     same buttons, and "back to your unclaimed pool" would be wrong about whose
     pool it went back to. */
  const whose = mine ? "my" : `${report.person.split(" ")[0]}'s`;
  const theirs = mine ? "your" : `${report.person.split(" ")[0]}'s`;

  const [name, setName] = useState({ title: report.title, purpose: report.purpose });
  /* The job, as the picker holds it: "" is overhead here rather than an
     unanswered field, because the report already HAS an answer - it was made
     to give one at creation - and this control is only ever changing it. */
  const [job, setJob] = useState(report.workOrderId === null ? "" : String(report.workOrderId));
  const jobChanged = (report.workOrderId === null ? "" : String(report.workOrderId)) !== job;

  /* Greyed on the same rule the action refuses on - a report's name is no
     longer optional, so "save" with it emptied would be a round trip to a
     toast. */
  const named = checkReportTitle(name.title);
  const nameProblem = "error" in named ? named.error : null;

  const total = reportTotalCents(rows);

  const openAdd = () => {
    setDraft({
      kind: categories[0] ?? "Other", description: "", amount: "", incurredOn: today,
      /* Pre-picked to the report's own job. Every row on a Reno-install claim
         is, overwhelmingly, for the Reno install - typing it once on the report
         and then again on each of nine receipts is the friction this whole
         flow exists to remove. Still a picker: a stray toll on the drive home
         is changed here, not worked around. */
      workOrderId: report.workOrderId === null ? "" : String(report.workOrderId),
    });
    setReceipt(null); setAddErr(""); setAdding(true);
  };

  const saveExpense = () =>
    startTransition(async () => {
      let receiptUrl = "", receiptName = "";
      if (receipt) {
        try {
          setBusy(`Uploading ${receipt.name}...`);
          const blob = await upload(receipt.name, receipt, { access: "public", handleUploadUrl: "/api/upload" });
          receiptUrl = blob.url; receiptName = receipt.name;
        } catch (e) {
          setBusy("");
          setAddErr(`The receipt did not upload: ${(e as Error).message}. Save without it, or retry.`);
          return;
        }
        setBusy("");
      }
      const res = await logMyExpense({
        kind: draft.kind, description: draft.description, amount: draft.amount,
        incurredOn: draft.incurredOn,
        workOrderId: draft.workOrderId ? parseInt(draft.workOrderId, 10) : null,
        receiptUrl, receiptName, reportId: report.id,
      });
      if (res?.error) { setAddErr(res.error); return; }
      toast({ message: "Added to the report" });
      setAdding(false);
      router.refresh();
    });

  const act = (fn: () => Promise<{ error?: string } | void>, message: string) =>
    startTransition(async () => {
      const err = ((await fn()) as { error?: string })?.error;
      if (err) { toast({ message: err }); return; }
      if (message) toast({ message });
      router.refresh();
    });

  return (
    <>
      {/* What this claim is, why it happened, and which job it belongs to.
          Editable while the report is, because creation-time-only makes a typo
          permanent - and a trip often turns out to have been for the other
          site, which without this means deleting the claim and starting over.
          Read-only once the claim is fixed. */}
      <div className="card" style={{ marginBottom: 12 }}>
        {editable ? (
          <>
            <label>Name</label>
            <input value={name.title} aria-label="Report name"
              placeholder="Reno install, week of the 12th" disabled={pending}
              onChange={(e) => setName({ ...name, title: e.target.value })} />
            <label style={{ marginTop: 8 }}>What it was for</label>
            <input value={name.purpose} aria-label="Purpose" disabled={pending}
              placeholder="The sentence whoever pays this will read first"
              onChange={(e) => setName({ ...name, purpose: e.target.value })} />
            {(name.title !== report.title || name.purpose !== report.purpose) && (
              <div style={{ display: "flex", gap: 8, marginTop: 8, alignItems: "center" }}>
                <button className="btn sm accent" disabled={pending || nameProblem !== null}
                  onClick={() => act(() => nameExpenseReport(report.id, name), "Saved")}>
                  Save
                </button>
                <button className="btn sm" disabled={pending}
                  onClick={() => setName({ title: report.title, purpose: report.purpose })}>
                  Discard
                </button>
                {nameProblem && <span className="mut t-small">{nameProblem}</span>}
              </div>
            )}

            <label style={{ marginTop: 8 }}>The job it is for</label>
            {/* Open or closed alike, and "no job" is a real answer rather than
                an unset field - the same distinction the create form draws. */}
            <select value={job} aria-label="Work order" disabled={pending}
              onChange={(e) => setJob(e.target.value)}>
              <option value="">No job - overhead</option>
              {workOrders.map((w) => <option key={w.id} value={String(w.id)}>{w.label}</option>)}
            </select>
            {jobChanged && (
              <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
                <button className="btn sm accent" disabled={pending}
                  onClick={() => act(
                    () => setReportWorkOrder(report.id, job ? parseInt(job, 10) : null),
                    job ? "Moved onto that job" : "Filed as overhead - no job",
                  )}>
                  Save the job
                </button>
                <button className="btn sm" disabled={pending}
                  onClick={() => setJob(report.workOrderId === null ? "" : String(report.workOrderId))}>
                  Discard
                </button>
              </div>
            )}
          </>
        ) : (
          <>
            <div className="t-body">{report.purpose || report.title}</div>
            <div className="mut t-small" style={{ marginTop: 4 }}>
              {report.workOrderNumber
                ? <>Filed against <a href={`/work/${report.workOrderId}`}>{report.workOrderNumber}</a></>
                : "Overhead - no job caused this"}
            </div>
          </>
        )}
        {/* Who filed it, said only when that is not whose money it is - which
            is the one time anybody asks, and the time they always do. */}
        {report.openedByName && report.openedByName !== report.person && (
          <div className="mut t-small" style={{ marginTop: 4 }}>
            Opened by {report.openedByName} on {report.person}&apos;s behalf.
          </div>
        )}
      </div>

      {report.status === "returned" && (
        <div className="card" style={{ borderLeft: "3px solid var(--t-bad-fg)", marginBottom: 12 }}>
          <div className="t-small" style={{ color: "var(--t-bad-fg)" }}>
            Returned: {report.returnedReason || "no reason recorded"}
          </div>
          <div className="mut t-small">Fix the rows below and submit it again - same report, second lap.</div>
        </div>
      )}

      <Panel title="Expenses" count={rows.length || undefined}
        hint={editable ? "Each row is one receipt. Scan it as you add it - empty the pocket, then submit." : undefined}>
        {editable && (
          <div style={{ display: "flex", gap: 6, marginBottom: 6, flexWrap: "wrap" }}>
            <button className="btn sm primary" onClick={openAdd}>+ Expense</button>
            {pool.length > 0 && (
              <button className="btn sm" onClick={() => { setPulled(new Set()); setPulling(true); }}>
                Pull from {whose} unclaimed ({pool.length})
              </button>
            )}
          </div>
        )}
        {rows.map((r) => (
          <div key={r.id} className="row-hover"
            style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", padding: "6px 4px", borderTop: "1px solid var(--line)" }}>
            {/* The receipt leads the row: a claim with paper reads differently
                from one without, and the reviewer looks for exactly that. */}
            {r.receiptUrl ? (
              <a href={r.receiptUrl} target="_blank" rel="noreferrer" title={r.receiptName || "Receipt"}>
                {/\.pdf($|\?)/i.test(r.receiptName || r.receiptUrl)
                  ? <span className="pill info">PDF</span>
                  : <img src={r.receiptUrl} alt={r.receiptName || "Receipt"}
                      style={{ width: 34, height: 34, objectFit: "cover", borderRadius: 6, border: "1px solid var(--line)" }} />}
              </a>
            ) : (
              <span className="pill faint" title="No receipt attached">no receipt</span>
            )}
            <span className="mut t-meta mono">{r.incurredOn}</span>
            <span className="pill neutral">{r.kind}</span>
            <span className="t-body" style={{ flex: "1 1 130px", minWidth: 0 }}>{r.description}</span>
            {r.workOrderNumber && <span className="mut t-meta mono">{r.workOrderNumber}</span>}
            <span className="t-body" style={{ fontWeight: 700 }}>{formatCents(r.amountCents)}</span>
            {editable && (
              <button className="btn link" disabled={pending} aria-label={`Remove ${r.description}`}
                onClick={() => act(() => removeReportExpense(r.id), `Removed - it is back in ${theirs} unclaimed pool`)}>
                remove
              </button>
            )}
          </div>
        ))}
        {rows.length === 0 && (
          <div className="mut t-small">Nothing on it yet{editable ? " - add the first receipt above" : ""}.</div>
        )}
        {rows.length > 0 && (
          <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, paddingTop: 8, borderTop: "1px solid var(--line)", marginTop: 4 }}>
            <span className="mut t-small">Total</span>
            <span className="t-body" style={{ fontWeight: 800 }}>{formatCents(total)}</span>
          </div>
        )}
      </Panel>

      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 16 }}>
        {editable && (
          <>
            <button className="btn accent" disabled={pending || rows.length === 0}
              onClick={() => act(() => submitDraftReport(report.id),
                `Submitted ${formatCents(total)} for reimbursement`)}>
              {report.status === "returned" ? "Resubmit the report" : `Submit ${rows.length ? formatCents(total) : "the report"}`}
            </button>
            <button className="btn" disabled={pending}
              onClick={async () => {
                if (!(await confirmDialog({
                  title: "Throw this report away?",
                  body: rows.length ? `Its expenses go back to ${theirs} unclaimed pool - nothing is deleted but the folder.` : undefined,
                  action: "Delete report", tone: "bad",
                }))) return;
                const res = await deleteExpenseReport(report.id);
                if (res?.error) { toast({ message: res.error }); return; }
                router.push("/money/reimbursements");
              }}>
              Delete
            </button>
          </>
        )}
        {mayWork && report.status === "submitted" && (
          <button className="btn" disabled={pending}
            onClick={() => act(() => withdrawExpenseReport(report.id), "Back to draft - edit away")}>
            Withdraw to draft
          </button>
        )}
        {isOwner && report.status === "submitted" && (
          <>
            <button className="btn accent" disabled={pending}
              onClick={() => { setPayDraft({ paidOn: today, reference: "" }); setPayErr(""); setPaying(true); }}>
              Mark paid
            </button>
            <button className="btn" disabled={pending}
              onClick={async () => {
                const why = await confirmReason({
                  title: `Return ${report.person}'s report?`,
                  body: "The rows stay on it; they fix it in place and resubmit. They read the reason, so write it to them.",
                  action: "Return it",
                });
                if (why === null) return;
                act(() => returnExpenseReport(report.id, why), `Returned to ${report.person}`);
              }}>
              Return
            </button>
          </>
        )}
      </div>

      {adding && (
        <Dialog open onClose={() => setAdding(false)} size="sm" title="New expense"
          context={busy || "One receipt, one row"}
          footer={
            <>
              <DialogStatus error={addErr}
                problem={!draft.description.trim() ? "say what it was"
                  : !draft.amount.trim() ? "enter the amount"
                  : !draft.incurredOn ? "pick the date" : null}
                ok={receipt ? `Receipt: ${receipt.name}` : undefined} />
              <button className="btn" onClick={() => setAdding(false)} disabled={pending}>Cancel</button>
              <button className="btn accent" onClick={saveExpense}
                disabled={pending || !draft.description.trim() || !draft.amount.trim() || !draft.incurredOn}>
                {pending ? busy || "Saving..." : "Add it"}
              </button>
            </>
          }>
          {/* The receipt first: on a phone this is the whole gesture - point,
              shoot, then type what the picture says. capture="environment"
              opens the camera itself rather than a picker. */}
          <div className="dialog-section">The receipt</div>
          <div style={{ display: "flex", gap: 6, marginBottom: 8, flexWrap: "wrap", alignItems: "center" }}>
            <label className="btn sm primary" style={{ marginBottom: 0 }}>
              Scan receipt
              <input type="file" accept="image/*" capture="environment" style={{ display: "none" }}
                onChange={(e) => setReceipt(e.target.files?.[0] ?? null)} />
            </label>
            <label className="btn sm" style={{ marginBottom: 0 }}>
              Attach a file
              <input type="file" accept="image/*,.pdf" style={{ display: "none" }}
                onChange={(e) => setReceipt(e.target.files?.[0] ?? null)} />
            </label>
            {receipt && <span className="mut t-small">{receipt.name}</span>}
          </div>
          <div className="dialog-section">What it was</div>
          <div className="pf2" style={{ marginBottom: 8 }}>
            <div>
              <label>Category</label>
              <select value={draft.kind} aria-label="Category"
                onChange={(e) => setDraft({ ...draft, kind: e.target.value })}>
                {categories.map((c) => <option key={c} value={c}>{c}</option>)}
              </select>
            </div>
            <div>
              <label>Amount ($)</label>
              <input value={draft.amount} aria-label="Amount" inputMode="decimal" placeholder="43.00"
                onChange={(e) => setDraft({ ...draft, amount: e.target.value })} />
            </div>
          </div>
          <label>Description</label>
          <input value={draft.description} aria-label="Description" placeholder="Parking, downtown site"
            onChange={(e) => setDraft({ ...draft, description: e.target.value })} style={{ marginBottom: 8 }} />
          <div className="pf2">
            <div>
              <label>Date</label>
              <input type="date" value={draft.incurredOn} max={today} aria-label="Date incurred"
                onChange={(e) => setDraft({ ...draft, incurredOn: e.target.value })} />
            </div>
            <div>
              <label>Work order</label>
              <select value={draft.workOrderId} aria-label="Work order"
                onChange={(e) => setDraft({ ...draft, workOrderId: e.target.value })}>
                <option value="">No job - overhead</option>
                {workOrders.map((w) => <option key={w.id} value={String(w.id)}>{w.label}</option>)}
              </select>
            </div>
          </div>
        </Dialog>
      )}

      {pulling && (
        <Dialog open onClose={() => setPulling(false)} size="sm" title={`Pull from ${whose} unclaimed`}
          context="Expenses logged elsewhere - on a work order, or the quick add - not yet claimed"
          footer={
            <>
              <DialogStatus problem={pulled.size ? null : "pick at least one"} />
              <button className="btn" onClick={() => setPulling(false)} disabled={pending}>Cancel</button>
              <button className="btn accent" disabled={pending || !pulled.size}
                onClick={() => startTransition(async () => {
                  const res = await attachPoolExpenses(report.id, [...pulled]);
                  if (res?.error) { toast({ message: res.error }); return; }
                  toast({ message: `Pulled ${pulled.size} onto the report` });
                  setPulling(false);
                  router.refresh();
                })}>
                Pull {pulled.size || ""} in
              </button>
            </>
          }>
          {pool.map((p) => (
            <label key={p.id} style={{ display: "flex", gap: 8, alignItems: "center", padding: "6px 0", borderTop: "1px solid var(--line)", cursor: "pointer", margin: 0 }}>
              <input type="checkbox" checked={pulled.has(p.id)} style={{ width: 15, height: 15 }}
                onChange={() => setPulled((s) => { const n = new Set(s); if (n.has(p.id)) n.delete(p.id); else n.add(p.id); return n; })} />
              <span className="mut t-meta mono">{p.incurredOn}</span>
              <span className="pill neutral">{p.kind}</span>
              <span className="t-body" style={{ flex: 1, minWidth: 0 }}>{p.description}</span>
              <span className="t-body" style={{ fontWeight: 700 }}>{formatCents(p.amountCents)}</span>
            </label>
          ))}
        </Dialog>
      )}

      {paying && (
        <Dialog open onClose={() => setPaying(false)} size="sm"
          title={`Pay ${report.person} ${formatCents(total)}`}
          context={`${rows.length} expense${rows.length === 1 ? "" : "s"}, ${reportSpan(rows)}`}
          footer={
            <>
              <DialogStatus error={payErr} problem={payDraft.paidOn ? null : "pick the date"} />
              <button className="btn" onClick={() => setPaying(false)} disabled={pending}>Cancel</button>
              <button className="btn accent" disabled={pending || !payDraft.paidOn}
                onClick={() => startTransition(async () => {
                  const res = await payExpenseReport(report.id, payDraft);
                  if (res?.error) { setPayErr(res.error); return; }
                  toast({ message: `Recorded the payout to ${report.person}` });
                  setPaying(false);
                  router.refresh();
                })}>
                Record the payout
              </button>
            </>
          }>
          <div className="pf2">
            <div>
              <label>Paid on</label>
              <input type="date" value={payDraft.paidOn} max={today} aria-label="Paid on" autoFocus
                onChange={(e) => setPayDraft({ ...payDraft, paidOn: e.target.value })} />
            </div>
            <div>
              <label>Reference</label>
              <input value={payDraft.reference} aria-label="Payout reference" className="mono"
                placeholder="check 1044, payroll 8/29"
                onChange={(e) => setPayDraft({ ...payDraft, reference: e.target.value })} />
            </div>
          </div>
        </Dialog>
      )}
    </>
  );
}
