"use client";

import Link from "next/link";
import { useState, useTransition } from "react";
import { logPastWorkOrder, openWorkOrder } from "@/app/actions";
import Dialog, { DialogStatus } from "@/components/ui/Dialog";
import { toast } from "@/components/ui/Toast";
import { WO_LABEL, WO_SEVERITIES, WO_TONE, woLine, woOpen } from "@/lib/workOrders";

export type WorkOrderRow = {
  id: number;
  number: string;
  title: string;
  severity: string;
  state: string;
  assignee: string;
  openedOn: string;
  /** Who asked, already resolved to a company name. */
  askedBy: string;
  tasks: number;
  done: number;
};

/**
 * The jobs on this record: what has been asked for, what is being done about it,
 * and what was done about the ones that are finished.
 *
 * Deliberately a list of links rather than an expandable thing. A work order has
 * its own tasks, hours, files and close-out; that is a page, and cramming it into
 * a panel on a page that already has six of them would make both unreadable.
 *
 * Finished orders fold away. A system serviced for three years has hundreds, and
 * the question this panel answers is "what is outstanding" - the archive is one
 * click below it for the day somebody asks what happened in March.
 */
export default function WorkOrdersPanel({ target, orders, today, canEdit, people = [], twoBox = false }: {
  target: { instrumentId: number | null; assetId: number | null };
  orders: WorkOrderRow[];
  today: string;
  canEdit: boolean;
  /** Who a job can be dispatched to, right at intake - the phone-call flow. */
  people?: string[];
  /** custody.twoBox: a past job's close-out splits into what travels and what stays. */
  twoBox?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [severity, setSeverity] = useState("Degraded");
  const [assignee, setAssignee] = useState("");
  // Backfilling: work that already happened, filed closed on its real date.
  const [past, setPast] = useState(false);
  const [pastDraft, setPastDraft] = useState({ title: "", summary: "", date: "", reference: "", doneBy: "", privateNotes: "" });
  const [error, setError] = useState("");
  // The entitlement heads-up that rode back on the filing - "out of included
  // visits". Amber, persistent until the next action: it must outlive the
  // form closing, because it is the one thing worth remembering afterwards.
  const [flag, setFlag] = useState("");
  const [pending, startTransition] = useTransition();

  const live = orders.filter((o) => woOpen(o.state) || o.state === "resolved");
  const filed = orders.filter((o) => !live.includes(o));

  // What the dialogs act on - all this panel is handed is the target ids.
  const targetLine = target.instrumentId != null ? `System #${target.instrumentId}`
    : target.assetId != null ? `Asset #${target.assetId}` : undefined;
  // The first unmet requirement, in plain words, live in the footer.
  const openProblem = !title.trim() ? "say briefly what the job is" : null;
  const pastProblem = !pastDraft.title.trim() ? "say briefly what the job was"
    : !pastDraft.summary.trim() ? "say what was done"
    : !pastDraft.date ? "pick the date it was done" : null;

  const file = () => {
    if (!title.trim()) { setError("Say briefly what the job is"); return; }
    setError("");
    startTransition(async () => {
      const res = await openWorkOrder(target, { title, body, severity, assignee });
      if (res?.error) { setError(res.error); return; }
      // Two things can ride the answer: a visit spent beyond the contract, and
      // a client on credit hold. Both are said out loud; neither refused the
      // job, because the instrument is down either way.
      setFlag([res?.flag, res?.hold].filter(Boolean).join(" "));
      if (res?.hold) toast({ message: "Opened on credit hold", tone: "bad" });
      setOpen(false); setTitle(""); setBody(""); setSeverity("Degraded"); setAssignee("");
    });
  };

  const row = (o: WorkOrderRow) => {
    const tone = WO_TONE[o.state] ?? WO_TONE.open;
    return (
      <Link key={o.id} href={`/work/${o.id}`} className="row-hover"
        style={{
          display: "flex", alignItems: "baseline", gap: 8, flexWrap: "wrap",
          padding: "7px 4px", borderTop: "1px solid var(--line)",
          textDecoration: "none", color: "inherit",
        }}>
        <span className="mono t-small" style={{ fontWeight: 700, color: "var(--navy)" }}>{o.number}</span>
        <span className="t-body" style={{ flex: "1 1 160px" }}>{o.title}</span>
        <span className={`pill ${tone}`}>{WO_LABEL[o.state] ?? o.state}</span>
        <span className="mut t-meta" style={{ width: "100%" }}>
          {woLine(o, today, { tasks: o.tasks, done: o.done })}
          {o.askedBy ? ` · asked by ${o.askedBy}` : ""}
        </span>
      </Link>
    );
  };

  return (
    <div className="card">
      <div style={{ display: "flex", alignItems: "baseline", gap: 8, marginBottom: 4 }}>
        <div className="card-title">Work orders</div>
        {canEdit && (
          <span style={{ marginLeft: "auto", display: "flex", gap: 6 }}>
            <button className="btn sm" onClick={() => { setPast(!past); setOpen(false); setError(""); }}>
              {past ? "Cancel" : "Log past work"}
            </button>
            <button className="btn sm primary" onClick={() => { setOpen(!open); setPast(false); setError(""); }}>
              {open ? "Cancel" : "Open one"}
            </button>
          </span>
        )}
      </div>

      {/* History a system arrived with: filed already closed, on the date it
          was done. "What was done" is the one required thing - a backfilled
          job with no summary is a date, not history. */}
      {past && (
        <Dialog open onClose={() => setPast(false)} title="Record a past job"
          context="Filed already closed, on the date it was done."
          footer={
            <>
              <DialogStatus error={error} problem={pastProblem} />
              <button className="btn" onClick={() => setPast(false)} disabled={pending}>Cancel</button>
              <button className="btn accent" disabled={pending || !!pastProblem}
                onClick={() => startTransition(async () => {
                  const res = await logPastWorkOrder(target, pastDraft);
                  if (res?.error) { setError(res.error); return; }
                  setPast(false); setPastDraft({ title: "", summary: "", date: "", reference: "", doneBy: "", privateNotes: "" });
                  toast({ message: "Filed the past job, closed" });
                })}>
                {pending ? "Filing..." : "File it, closed"}
              </button>
            </>
          }>
          <div className="dialog-section">The job</div>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 8 }}>
            <div style={{ flex: "2 1 180px" }}>
              <label>What was the job? *</label>
              <input value={pastDraft.title} onChange={(e) => setPastDraft({ ...pastDraft, title: e.target.value })}
                maxLength={160} placeholder="Replaced nebulizer, leak check" />
            </div>
            <div>
              <label>Done on *</label>
              <input type="date" value={pastDraft.date}
                onChange={(e) => setPastDraft({ ...pastDraft, date: e.target.value })} style={{ width: "auto" }} />
            </div>
          </div>
          <div className="dialog-section">The close-out</div>
          <label>{twoBox ? "Findings *" : "What was done *"}</label>
          <textarea value={pastDraft.summary} onChange={(e) => setPastDraft({ ...pastDraft, summary: e.target.value })}
            rows={3} placeholder="The close-out, as it would have been written that day" style={{ width: "100%", marginBottom: twoBox ? 4 : 8 }} />
          {twoBox && (
            <>
              <div className="field-hint" style={{ marginBottom: 8 }}>
                Written for whoever owns this instrument next - it travels if the machine changes hands.
              </div>
              <div className="field">
                <label>Private notes <span className="field-opt">(stays with the shop)</span></label>
                <textarea value={pastDraft.privateNotes}
                  onChange={(e) => setPastDraft({ ...pastDraft, privateNotes: e.target.value })} rows={2}
                  placeholder="Site, contact, cost - never leaves this workspace." style={{ width: "100%" }} />
              </div>
            </>
          )}
          <div className="dialog-section">Paper trail</div>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 8 }}>
            <div style={{ flex: "1 1 140px" }}>
              <label>Reference #</label>
              <input value={pastDraft.reference} onChange={(e) => setPastDraft({ ...pastDraft, reference: e.target.value })}
                placeholder="Old WO number (optional)" className="mono" />
            </div>
            <div style={{ flex: "1 1 140px" }}>
              <label>Done by</label>
              <input value={pastDraft.doneBy} onChange={(e) => setPastDraft({ ...pastDraft, doneBy: e.target.value })}
                placeholder="Engineer or vendor (optional)" />
            </div>
          </div>
        </Dialog>
      )}

      {open && (
        <Dialog open onClose={() => setOpen(false)} title="Open a work order" context={targetLine}
          footer={
            <>
              <DialogStatus error={error} problem={openProblem} />
              <button className="btn" onClick={() => setOpen(false)} disabled={pending}>Cancel</button>
              <button className="btn accent" onClick={file} disabled={pending || !!openProblem}>
                {pending ? "Opening..." : assignee ? `Open & dispatch to ${assignee}` : "Open work order"}
              </button>
            </>
          }>
          <div className="dialog-section">The job</div>
          <label>What is the job? *</label>
          <input value={title} onChange={(e) => setTitle(e.target.value)} autoFocus maxLength={160}
            placeholder="Lamp won't ignite" style={{ marginBottom: 8 }} />
          <label>Anything else</label>
          <textarea value={body} onChange={(e) => setBody(e.target.value)} rows={3}
            placeholder="Error code, when it started, what was running" style={{ width: "100%", marginBottom: 8 }} />
          <div className="dialog-section">How urgent</div>
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 8 }}>
            {WO_SEVERITIES.map((s) => (
              <button key={s.key} type="button" onClick={() => setSeverity(s.key)}
                className={severity === s.key ? "btn sm accent" : "btn sm"}
                title={s.hint} style={{ flex: "1 1 90px" }}>{s.label}</button>
            ))}
          </div>
          {/* Dispatch at intake: the call is still live, the engineer's name is
              known - filing and assigning in two screens was two too many.
              Optional, because triage-later is also a real workflow. */}
          {people.length > 0 && (
            <>
            <div className="dialog-section">Who takes it</div>
            <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", marginBottom: 8 }}>
              <label style={{ margin: 0 }}>Dispatch to</label>
              <select value={assignee} onChange={(e) => setAssignee(e.target.value)}
                aria-label="Dispatch to" className="t-body" style={{ width: "auto" }}>
                <option value="">Decide later</option>
                {people.map((x) => <option key={x} value={x}>{x}</option>)}
              </select>
              {assignee && <span className="mut t-meta">{assignee} gets notified the moment it files.</span>}
            </div>
            </>
          )}
        </Dialog>
      )}
      {!open && error && <div className="t-small" style={{ color: "var(--t-bad-fg)", marginBottom: 8 }}>{error}</div>}
      {flag && (
        <div className="t-small" style={{ padding: "8px 10px", borderRadius: 8, background: "#FAF0DC", color: "var(--t-warn-fg)", marginBottom: 8, display: "flex", gap: 8 }}>
          <span style={{ flex: 1 }}><b>Filed.</b> {flag}</span>
          <button className="btn link" style={{ color: "var(--t-warn-fg)" }} onClick={() => setFlag("")}>dismiss</button>
        </div>
      )}

      {live.map(row)}
      {live.length === 0 && (
        <div className="mut" style={{ fontSize: 13 }}>
          Nothing outstanding{filed.length ? ` - ${filed.length} finished` : ""}.
        </div>
      )}

      {filed.length > 0 && (
        <details style={{ borderTop: "1px solid var(--line)", marginTop: live.length ? 0 : 8 }}>
          <summary style={{ cursor: "pointer", padding: "8px 4px", fontSize: 13 }}>
            <b>Finished</b> <span className="mut">· {filed.length}</span>
          </summary>
          {filed.map(row)}
        </details>
      )}
    </div>
  );
}
