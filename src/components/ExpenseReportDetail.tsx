"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, useTransition } from "react";
import { upload } from "@vercel/blob/client";
import {
  approveExpenseAllowance, attachPoolExpenses, deleteExpenseReport, editReportExpense, logMyExpense,
  nameExpenseReport, payExpenseReport, removeReportExpense, returnExpenseReport, setReportWorkOrder,
  submitDraftReport, withdrawExpenseReport,
} from "@/app/actions";
import {
  REPORT_LABEL, REPORT_TONE, checkReportTitle, editableReport, reportSpan, reportTotalCents,
} from "@/lib/expenseReports";
import {
  isPerDiemKind, perDiemOffer, policyConfigured, type ExpensePolicy,
} from "@/lib/expensePolicy";
import { formatCents } from "@/lib/money";
import Dialog, { DialogStatus } from "@/components/ui/Dialog";
import { confirmDialog, confirmReason } from "@/components/ui/ConfirmDialog";
import { Panel, Pill } from "@/components/ui";
import { toast } from "@/components/ui/Toast";
import DocScanner from "@/components/DocScanner";

/** A PDF receipt has no thumbnail to show; an image does. Name first - a blob
 *  url is a hash, and the name is what the person actually uploaded. */
const isPdfReceipt = (name: string, url: string) => /\.pdf($|\?)/i.test(name || url);

export type ReportExpense = {
  id: number; kind: string; description: string; amountCents: number; incurredOn: string;
  workOrderId: number | null; workOrderNumber: string; receiptUrl: string; receiptName: string;
  /**
   * The trip the rulebook priced this against: which lab, and how many nights
   * away. Carried so that reopening the row reopens the same trip, rather than
   * resetting it to the job's default lab and a day out.
   */
  siteId: number | null;
  nights: number;
  /** What the travel rulebook made of it: "" | flagged | approved. */
  allowanceState: string;
  allowanceNote: string;
  /** Who cleared it, when somebody has. */
  allowanceByName: string;
};

/** One of the job's labs, with the claimant's road miles to it. */
export type TripSite = { siteId: number; name: string; miles: number | null; estimated: boolean };

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
export default function ExpenseReportDetail({
  report, rows, mayWork, mine, isOwner, adminsPeople, today, categories, workOrders, pool,
  policy, tripSites, defaultSiteId,
}: {
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
  /**
   * Whether this reader may CLEAR a flagged row - HR and the owner. Separate
   * from isOwner because judging a claim against the rules and writing the
   * check are different jobs, the same split the desk already draws.
   */
  adminsPeople: boolean;
  today: string;
  categories: string[];
  workOrders: { id: number; label: string }[];
  /** The claimant's unclaimed expenses, offered for pulling onto an open report. */
  pool: { id: number; kind: string; description: string; amountCents: number; incurredOn: string }[];
  /** The shop's travel rules. All zeros = the rulebook is off and nothing below shows. */
  policy: ExpensePolicy;
  /** The job's labs and the CLAIMANT's road miles to each. Empty when there is no job. */
  tripSites: TripSite[];
  defaultSiteId: number | null;
}) {
  const router = useRouter();
  const editable = mayWork && editableReport(report.status);
  /*
   * The expense dialog, in whichever of its two moods: "new" while one is
   * being added, the row itself while one already on the report is open, null
   * when it is shut.
   *
   * ONE dialog rather than two, because adding a row and fixing one are the
   * same eight fields, the same rulebook and the same receipt. Fixing one was
   * missing entirely - the rows have carried the app's "this is a record"
   * hover highlight since they were written, and clicking one did nothing - so
   * a receipt photographed after the fact, or an amount typed from memory that
   * the paper later disagreed with, meant removing the row and starting over,
   * which threw away the parts that were right along with the part that wasn't.
   */
  const [editing, setEditing] = useState<ReportExpense | "new" | null>(null);
  /** The row being fixed, or null while one is being added. */
  const opened = editing === "new" ? null : editing;
  const [draft, setDraft] = useState({ kind: "", description: "", amount: "", incurredOn: "", workOrderId: "" });
  const [receipt, setReceipt] = useState<File | null>(null);
  /* The receipt already in the blob store, as it stands after any removing.
     Separate from `receipt` because that one is a file still waiting to be
     uploaded, and the two are told apart at save. */
  const [attached, setAttached] = useState({ url: "", name: "" });
  /* A photo waiting to be scanned. Set the moment the camera returns one and
     cleared when the scanner hands back a result - which may be the original,
     if that is what they chose. */
  const [scanning, setScanning] = useState<File | "live" | null>(null);
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
  /** Rows a reviewer still has to sign for. The payout waits on these. */
  const flagged = rows.filter((r) => r.allowanceState === "flagged");

  /*
   * The trip behind a per diem: which lab, and how many nights. Miles are not
   * asked for - they are the road distance from the claimant's own home to
   * that lab, which the server worked out before this page rendered.
   *
   * Nights defaults to 0, the day trip, because that is the case this whole
   * thing was built for: drive out, eat lunch, drive back. Somebody who stayed
   * over types a 1 and the rulebook prices the nights instead of the miles.
   */
  const [tripDraft, setTripDraft] = useState({ siteId: defaultSiteId, nights: "0" });
  const site = tripSites.find((x) => x.siteId === tripDraft.siteId)
    ?? tripSites.find((x) => x.siteId === defaultSiteId)
    ?? null;
  /* The same call the action makes on the server, for the same trip - so what
     the dialog promises and what the row is judged by cannot disagree. The
     server still recomputes it; this is the preview, not the authority. */
  const offer = perDiemOffer(policy, {
    oneWayMiles: site?.miles ?? null,
    nights: parseInt(tripDraft.nights, 10) || 0,
    siteName: site?.name ?? "",
  });
  /* Only when the rulebook is on, the claim names a job, and the category the
     engineer just picked is a per diem. Anything else and the dialog is the
     plain one it has always been. */
  const perDiem = policyConfigured(policy) && report.workOrderId !== null
    && tripSites.length > 0 && isPerDiemKind(draft.kind);

  /*
   * The autofill itself.
   *
   * The gesture this is built around has no typing in it: pick "Per diem" and
   * the amount and the sentence are already there, because the shop's rate and
   * the distance from this person's front door are both things the app knows
   * and the engineer standing in a car park does not want to look up.
   *
   * It only ever overwrites its OWN last answer, or an empty box. The moment
   * somebody types over the amount - a $52 airport lunch on a $30 day - that
   * number is theirs, and changing the nights afterwards must not quietly take
   * it back. Which is what lastFill remembers: not "has the user typed", but
   * "is what is in the box still the thing we put there".
   */
  const lastFill = useRef({ amount: "", description: "" });
  useEffect(() => {
    if (!perDiem || offer.allowedCents <= 0) return;
    const amount = (offer.allowedCents / 100).toFixed(2);
    const prev = lastFill.current;
    setDraft((d) => {
      const takeAmount = d.amount === "" || d.amount === prev.amount;
      const takeDesc = d.description === "" || d.description === prev.description;
      if (!takeAmount && !takeDesc) return d;
      return {
        ...d,
        amount: takeAmount ? amount : d.amount,
        description: takeDesc ? offer.description : d.description,
      };
    });
    lastFill.current = { amount, description: offer.description };
  }, [perDiem, offer.allowedCents, offer.description]);

  const openAdd = () => {
    setTripDraft({ siteId: defaultSiteId, nights: "0" });
    // A fresh dialog owns nothing yet, so the first offer fills both boxes.
    lastFill.current = { amount: "", description: "" };
    setDraft({
      kind: categories[0] ?? "Other", description: "", amount: "", incurredOn: today,
      /* Pre-picked to the report's own job. Every row on a Reno-install claim
         is, overwhelmingly, for the Reno install - typing it once on the report
         and then again on each of nine receipts is the friction this whole
         flow exists to remove. Still a picker: a stray toll on the drive home
         is changed here, not worked around. */
      workOrderId: report.workOrderId === null ? "" : String(report.workOrderId),
    });
    setReceipt(null); setAttached({ url: "", name: "" }); setAddErr(""); setEditing("new");
  };

  /*
   * Open a row already on the report - to read it, or to fix it.
   *
   * Everything comes off the row, the trip included: the nights and the lab
   * this per diem was priced against, so coming back to correct a description
   * does not quietly re-price two nights away as a day trip.
   *
   * lastFill is cleared rather than primed, which is the whole of the rule:
   * what is in these boxes is the CLAIMANT's, filed and stored, so the
   * autofill must treat it as typed-over and leave it alone. It only starts
   * offering again once they move the nights.
   */
  const openRow = (r: ReportExpense) => {
    setTripDraft({ siteId: r.siteId ?? defaultSiteId, nights: String(r.nights) });
    lastFill.current = { amount: "", description: "" };
    setDraft({
      kind: r.kind, description: r.description, amount: (r.amountCents / 100).toFixed(2),
      incurredOn: r.incurredOn,
      workOrderId: r.workOrderId === null ? "" : String(r.workOrderId),
    });
    setReceipt(null);
    setAttached({ url: r.receiptUrl, name: r.receiptName });
    setAddErr(""); setEditing(r);
  };

  const saveExpense = () =>
    startTransition(async () => {
      /* Whatever the receipt should be after this: the file just picked wins,
         then whatever was already on the row, then nothing - which on an edit
         means somebody removed it and meant to. */
      let receiptUrl = attached.url, receiptName = attached.name;
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
      const fields = {
        kind: draft.kind, description: draft.description, amount: draft.amount,
        incurredOn: draft.incurredOn,
        workOrderId: draft.workOrderId ? parseInt(draft.workOrderId, 10) : null,
        receiptUrl, receiptName,
        /* Only meaningful for a per diem; the server re-derives the verdict
           either way. Left UNSAID rather than zeroed otherwise, because the
           lab a row names is not only a per diem's business - a lunch was
           bought at one too - and an edit must not unset it. */
        nights: perDiem ? parseInt(tripDraft.nights, 10) || 0 : undefined,
        siteId: perDiem ? tripDraft.siteId : undefined,
      };
      const res = opened
        ? await editReportExpense(opened.id, fields)
        : await logMyExpense({ ...fields, reportId: report.id });
      if (res?.error) { setAddErr(res.error); return; }
      toast({ message: opened ? "Saved" : "Added to the report" });
      setEditing(null);
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
          <div key={r.id} style={{ padding: "6px 4px", borderTop: "1px solid var(--line)" }}>
          {/* The row OPENS. It has looked openable since it was written - the
              hover highlight is this app's tell for "there is a record behind
              this" - and clicking it did nothing, which is the bug: a receipt
              taken after the fact had nowhere to go, and a wrong amount could
              only be removed and retyped.

              A div rather than a button because the receipt thumbnail inside
              it is a link, and a link inside a button is invalid markup that
              swallows its own clicks; the controls with their own job stop the
              event. Enter and Space open it too - this is the primary gesture
              on the page, and the keyboard gets it. */}
          <div role="button" tabIndex={0} className="row-hover"
            aria-label={`${editable ? "Edit" : "View"} ${r.description || r.kind}, ${formatCents(r.amountCents)}`}
            onClick={() => openRow(r)}
            onKeyDown={(e) => {
              if (e.key !== "Enter" && e.key !== " ") return;
              e.preventDefault();
              openRow(r);
            }}
            style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", cursor: "pointer" }}>
            {/* The receipt leads the row: a claim with paper reads differently
                from one without, and the reviewer looks for exactly that. The
                thumbnail still opens the paper itself rather than the row -
                one click to check a total against the till slip. */}
            {r.receiptUrl ? (
              <a href={r.receiptUrl} target="_blank" rel="noreferrer" title={r.receiptName || "Receipt"}
                onClick={(e) => e.stopPropagation()}>
                {isPdfReceipt(r.receiptName, r.receiptUrl)
                  ? <span className="pill info">PDF</span>
                  : <img src={r.receiptUrl} alt={r.receiptName || "Receipt"}
                      style={{ width: 34, height: 34, objectFit: "cover", borderRadius: 6, border: "1px solid var(--line)" }} />}
              </a>
            ) : (
              <span className="pill faint"
                title={editable ? "No receipt attached - open the row to add one" : "No receipt attached"}>
                no receipt
              </span>
            )}
            <span className="mut t-meta mono">{r.incurredOn}</span>
            <span className="pill neutral">{r.kind}</span>
            <span className="t-body" style={{ flex: "1 1 130px", minWidth: 0 }}>{r.description}</span>
            {r.workOrderNumber && <span className="mut t-meta mono">{r.workOrderNumber}</span>}
            <span className="t-body" style={{ fontWeight: 700 }}>{formatCents(r.amountCents)}</span>
            {r.allowanceState === "flagged" && <Pill tone="warn">needs approval</Pill>}
            {r.allowanceState === "approved" && <Pill tone="good">approved</Pill>}
            {editable && (
              <button className="btn link" disabled={pending} aria-label={`Remove ${r.description}`}
                onClick={(e) => {
                  // Taking the row off is not opening it.
                  e.stopPropagation();
                  act(() => removeReportExpense(r.id), `Removed - it is back in ${theirs} unclaimed pool`);
                }}>
                remove
              </button>
            )}
          </div>
          {/*
            What the rulebook said, under the row it said it about. A flag is
            not a colour: this line is the sentence a reviewer has to agree
            with before the report can be paid, so it is spelled out where they
            are already looking rather than behind a hover.
          */}
          {r.allowanceState === "flagged" && (
            <div style={{ display: "flex", gap: 8, alignItems: "baseline", flexWrap: "wrap", marginTop: 2, paddingLeft: 2 }}>
              <span className="t-small" style={{ color: "var(--t-warn-fg)", flex: "1 1 240px" }}>
                {r.allowanceNote}
              </span>
              {adminsPeople && (
                <button className="btn sm" disabled={pending}
                  onClick={async () => {
                    if (!(await confirmDialog({
                      title: `Approve this ${formatCents(r.amountCents)} ${r.kind.toLowerCase()}?`,
                      body: `${r.allowanceNote} Approving puts your name on it and lets the report be paid.`,
                      action: "Approve it",
                    }))) return;
                    act(() => approveExpenseAllowance(r.id), "Approved - it can be paid now");
                  }}>
                  Approve
                </button>
              )}
            </div>
          )}
          {r.allowanceState === "approved" && r.allowanceByName && (
            <div className="mut t-small" style={{ marginTop: 2, paddingLeft: 2 }}>
              {r.allowanceNote} Approved by {r.allowanceByName}.
            </div>
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

      {/* The accountant's copy, under the actions because it is what you do
          WITH a claim rather than to it. Three formats because they are not a
          superset of one another: the PDF is what gets attached to an email
          (the claim, then its receipts on the pages after it), the CSV is what
          gets imported, and the packet is the CSV plus the receipt files named
          to match its rows. Plain links - the browser downloads them the way
          it downloads everything else, and they work on a phone. */}
      <Panel title="Send it to the bookkeeper"
        hint="The claim and the paper behind it, in whichever shape your accountant asks for.">
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <a className="btn sm" href={`/api/export/report/${report.id}?format=pdf`}>PDF with receipts</a>
          <a className="btn sm" href={`/api/export/report/${report.id}?format=csv`}>CSV</a>
          <a className="btn sm" href={`/api/export/report/${report.id}?format=zip`}>CSV + receipt files</a>
        </div>
      </Panel>

      {editing && (
        <Dialog open onClose={() => setEditing(null)} size="sm"
          title={opened ? "Expense" : "New expense"}
          /* What it acts on: the row as it stands, so a claimant fixing an
             amount can still see the one they came to fix. */
          context={busy || (opened
            ? `${formatCents(opened.amountCents)} · ${opened.incurredOn}`
            : "One receipt, one row")}
          footer={editable ? (
            <>
              <DialogStatus error={addErr}
                problem={!draft.description.trim() ? "say what it was"
                  : !draft.amount.trim() ? "enter the amount"
                  : !draft.incurredOn ? "pick the date" : null}
                ok={receipt ? `Receipt: ${receipt.name}`
                  : attached.url ? `Receipt: ${attached.name || "attached"}` : undefined} />
              <button className="btn" onClick={() => setEditing(null)} disabled={pending}>Cancel</button>
              <button className="btn accent" onClick={saveExpense}
                disabled={pending || !draft.description.trim() || !draft.amount.trim() || !draft.incurredOn}>
                {pending ? busy || "Saving..." : opened ? "Save the changes" : "Add it"}
              </button>
            </>
          ) : (
            /* A sent claim opens to be READ. Every field below is disabled
               rather than hidden, because "what does this row say" is the
               question somebody chasing a payout came with - and the sentence
               says why they cannot change it, which is a step (withdraw it)
               and not a wall. */
            <>
              <DialogStatus ok={`This report is ${(REPORT_LABEL[report.status] ?? report.status).toLowerCase()}`
                + (mayWork && report.status === "submitted"
                  ? " - withdraw it to change its rows." : " - its rows are fixed.")} />
              <button className="btn" onClick={() => setEditing(null)}>Close</button>
            </>
          )}>
          {/* The receipt first: on a phone this is the whole gesture - point,
              shoot, then type what the picture says. capture="environment"
              opens the camera itself rather than a picker.

              On a row opened for fixing this is often the ONLY reason it was
              opened: the claim went in without paper because the paper was in
              a jacket, and this is where it finally lands. */}
          <div className="dialog-section">The receipt</div>
          <div style={{ display: "flex", gap: 6, marginBottom: 8, flexWrap: "wrap", alignItems: "center" }}>
            {editable && (
              <>
                {/* Opens the LIVE viewfinder: edges found on the video, a
                    lock when it is steady, a shutter - and the scanner falls
                    back to the phone's own camera app by itself when the
                    browser will not stream. Either way what is stored is a
                    document, not a photograph of paper on a car seat. */}
                <button type="button" className="btn sm primary" style={{ marginBottom: 0 }}
                  onClick={() => setScanning("live")}>
                  {attached.url || receipt ? "Replace it" : "Scan receipt"}
                </button>
                {/* Attaching goes round the scanner on purpose: a PDF has no
                    corners to find, and an emailed invoice is already flat. An
                    image picked from the roll still gets offered the scan. */}
                <label className="btn sm" style={{ marginBottom: 0 }}>
                  Attach a file
                  <input type="file" accept="image/*,.pdf" style={{ display: "none" }}
                    onChange={(e) => {
                      const f = e.target.files?.[0] ?? null;
                      e.target.value = "";
                      if (!f) return;
                      if (f.type.startsWith("image/")) setScanning(f); else setReceipt(f);
                    }} />
                </label>
              </>
            )}
            {/* Where the receipt stands, in one of its three states: a file
                just picked and not yet uploaded, the paper already in the blob
                store, or nothing. Said out loud in all three, because "no
                receipt" is a fact about the claim and not an empty slot. */}
            {receipt ? (
              <>
                <span className="mut t-small">{receipt.name}</span>
                <button className="btn link" type="button" onClick={() => setReceipt(null)}>
                  remove
                </button>
              </>
            ) : attached.url ? (
              <>
                <a href={attached.url} target="_blank" rel="noreferrer" title={attached.name || "Receipt"}
                  style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                  {isPdfReceipt(attached.name, attached.url)
                    ? <span className="pill info">PDF</span>
                    : <img src={attached.url} alt={attached.name || "Receipt"}
                        style={{ width: 44, height: 44, objectFit: "cover", borderRadius: 6, border: "1px solid var(--line)" }} />}
                  <span className="t-small">{attached.name || "Open it"}</span>
                </a>
                {editable && (
                  <button className="btn link" type="button" disabled={pending}
                    onClick={() => setAttached({ url: "", name: "" })}>
                    remove
                  </button>
                )}
              </>
            ) : (
              <span className="mut t-small">
                {editable ? "None yet - scan it now, or save without one." : "None was attached."}
              </span>
            )}
          </div>
          <div className="dialog-section">What it was</div>
          <div className="pf2" style={{ marginBottom: 8 }}>
            <div>
              <label>Category</label>
              <select value={draft.kind} aria-label="Category" disabled={!editable || pending}
                onChange={(e) => setDraft({ ...draft, kind: e.target.value })}>
                {categories.map((c) => <option key={c} value={c}>{c}</option>)}
              </select>
            </div>
            <div>
              <label>Amount ($)</label>
              <input value={draft.amount} aria-label="Amount" inputMode="decimal" placeholder="43.00"
                disabled={!editable || pending}
                onChange={(e) => setDraft({ ...draft, amount: e.target.value })} />
            </div>
          </div>

          {/*
            The rulebook, answering as soon as the category says per diem.
            Nobody types a distance: the claim names a job, the job names a lab,
            and the lab is a known number of road miles from THIS claimant's
            front door. What is left to ask is the one thing only they know -
            whether they slept there.
          */}
          {perDiem && (
            <div style={{ padding: "8px 10px", borderRadius: 8, background: "#F4F7FB", marginBottom: 8 }}>
              <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                {tripSites.length > 1 ? (
                  <>
                    <span className="mut t-small">Lab</span>
                    <select className="t-small" value={tripDraft.siteId ?? ""} aria-label="Which lab"
                      disabled={!editable || pending} style={{ width: "auto", padding: "3px 6px" }}
                      onChange={(e) => setTripDraft({
                        ...tripDraft, siteId: parseInt(e.target.value, 10) || null,
                      })}>
                      {tripSites.map((x) => <option key={x.siteId} value={x.siteId}>{x.name}</option>)}
                    </select>
                  </>
                ) : site && <span className="t-small" style={{ fontWeight: 600 }}>{site.name}</span>}
                <span className="mut t-small">
                  {site?.miles == null
                    ? "distance from home unknown"
                    : `${site.miles} mi from ${mine ? "your" : `${report.person.split(" ")[0]}'s`} home`
                      + (site.estimated ? " (estimated)" : "")}
                </span>
                <span className="mut t-small">·</span>
                <input className="t-small" inputMode="numeric" value={tripDraft.nights} aria-label="Nights away"
                  disabled={!editable || pending} style={{ width: 44, padding: "3px 6px" }}
                  onChange={(e) => setTripDraft({ ...tripDraft, nights: e.target.value.replace(/[^0-9]/g, "") })} />
                <span className="mut t-small">nights away</span>
              </div>

              <div className="t-small" style={{ marginTop: 6 }}>
                {offer.allowedCents > 0 ? (
                  <>
                    The rulebook allows <b>{formatCents(offer.allowedCents)}</b>
                    {draft.amount === (offer.allowedCents / 100).toFixed(2)
                      ? " - filled in below."
                      : <>
                          , and you have claimed something else.{" "}
                          {/* Only offered once they have departed from it. A
                              button that undoes nothing is noise. */}
                          <button className="btn link" type="button" disabled={pending}
                            onClick={() => {
                              const amount = (offer.allowedCents / 100).toFixed(2);
                              setDraft((d) => ({ ...d, amount, description: offer.description }));
                              lastFill.current = { amount, description: offer.description };
                            }}>
                            put the allowance back
                          </button>
                        </>}
                  </>
                ) : (
                  <span className="mut">The rulebook offers nothing for this trip - claim what it cost and say why.</span>
                )}
              </div>

              {/* Said before it is filed, not after. Somebody about to claim a
                  lunch the stipend already covered should read the reason now,
                  while they can still decide it was not worth queueing a
                  reviewer for - and file it knowingly if it was. */}
              {offer.flag && (
                <div className="t-small" style={{ color: "var(--t-warn-fg)", marginTop: 6 }}>
                  Needs approval: {offer.flag}
                </div>
              )}
            </div>
          )}
          {/* Said BEFORE they type over the amount, not after it has been
              taken back. Somebody signed for this trip at this price; the
              signature covers that claim and not a different one, which is
              the same rule the server applies when it re-asks the rulebook. */}
          {editable && opened?.allowanceState === "approved" && (
            <div className="t-small" style={{ color: "var(--t-warn-fg)", marginBottom: 8 }}>
              {opened.allowanceByName ? `${opened.allowanceByName} approved this row.` : "This row was approved."}
              {" "}Changing the amount, category, nights or lab sends it back for approval.
            </div>
          )}
          <label>Description</label>
          <input value={draft.description} aria-label="Description" placeholder="Parking, downtown site"
            disabled={!editable || pending}
            onChange={(e) => setDraft({ ...draft, description: e.target.value })} style={{ marginBottom: 8 }} />
          <div className="pf2">
            <div>
              <label>Date</label>
              <input type="date" value={draft.incurredOn} max={today} aria-label="Date incurred"
                disabled={!editable || pending}
                onChange={(e) => setDraft({ ...draft, incurredOn: e.target.value })} />
            </div>
            <div>
              <label>Work order</label>
              <select value={draft.workOrderId} aria-label="Work order" disabled={!editable || pending}
                onChange={(e) => setDraft({ ...draft, workOrderId: e.target.value })}>
                <option value="">No job - overhead</option>
                {workOrders.map((w) => <option key={w.id} value={String(w.id)}>{w.label}</option>)}
              </select>
            </div>
          </div>
        </Dialog>
      )}

      {/* Over the add-expense dialog rather than inside it: the scan is its own
          decision, with its own way out, and burying a corner-dragging canvas
          inside a form makes both worse. */}
      {scanning && (
        /* Multi-page on purpose, even for "a receipt": a hotel folio is three
           pages, and the pages leave the scanner as one PDF - which the report
           PDF already knows how to copy in whole (lib/reportPdf). */
        <DocScanner file={scanning === "live" ? undefined : scanning} title="Scan the receipt"
          onCancel={() => setScanning(null)}
          onDone={(f) => { setReceipt(f); setScanning(null); }} />
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
