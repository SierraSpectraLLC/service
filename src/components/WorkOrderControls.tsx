"use client";

import { useState, useTransition } from "react";
import { attachWorkOrderSystem, deleteWorkOrder, resolveWorkOrder, setWorkOrderState, updateWorkOrder } from "@/app/actions";
import Dialog, { DialogStatus } from "@/components/ui/Dialog";
import { toast } from "@/components/ui/Toast";
import { useRouter } from "next/navigation";
import { confirmReason } from "@/components/ui/ConfirmDialog";
import { WO_LABEL, WO_SEVERITIES, woMoves, type Mover } from "@/lib/workOrders";

/**
 * The controls that move a job along, and the edit form behind them.
 *
 * Which buttons exist is decided by lib/workOrders and nothing else - the same
 * function the server checks against - so a viewer is never offered a button
 * that will refuse them. Somebody who is on neither side of the job (a second
 * service company invited onto the system, say) sees the order and no buttons,
 * which is the honest rendering of "you can work on this, it isn't yours to
 * close".
 *
 * Resolving is the one move with a form in front of it. What was done is the
 * sentence the record keeps, and a job closed with nothing written on it is how
 * a service history turns into a list of dates.
 */
export default function WorkOrderControls({
  id, number, state, mover, title, body, severity, assignee, people, systems = [], twoBox = false,
}: {
  id: number;
  number: string;
  state: string;
  /** Which side of the job the viewer is on. Null = neither, and no controls. */
  mover: Mover | null;
  title: string;
  body: string;
  severity: string;
  assignee: string;
  people: string[];
  /**
   * Systems this job could turn out to be about - passed ONLY when it has no
   * record of its own, which is what makes the control appear. Empty is the
   * ordinary case: the job is already on something.
   */
  systems?: { id: number; externalId: string; label: string }[];
  /**
   * custody.twoBox: the close-out splits into what travels with the machine
   * and what stays with the shop. Off leaves the single field exactly as it was.
   */
  twoBox?: boolean;
}) {
  const [mode, setMode] = useState<"" | "resolve" | "edit">("");
  const [systemId, setSystemId] = useState(0);
  const [summary, setSummary] = useState("");
  const [privateNotes, setPrivateNotes] = useState("");
  const [form, setForm] = useState({ title, body, severity, assignee });
  const [error, setError] = useState("");
  const [pending, startTransition] = useTransition();
  const router = useRouter();

  if (mover === null) return null;

  // Resolving has a form, so it is not one of the plain buttons.
  const moves = woMoves(state, mover).filter((s) => s !== "resolved");
  const canResolve = woMoves(state, mover).includes("resolved");

  // The first unmet requirement per form, live in the dialog footer.
  const resolveProblem = summary.trim().length < 3 ? "say what was done" : null;
  const editProblem = !form.title.trim() ? "say what the job is" : null;

  const run = (fn: () => Promise<{ error?: string } | void>, done?: string) => {
    setError("");
    startTransition(async () => {
      const res = await fn();
      if (res && "error" in res && res.error) { setError(res.error); return; }
      setMode(""); setSummary("");
      if (done) toast({ message: done });
    });
  };

  /** Plain-English verbs. "Set state to waiting" is not how anybody talks. */
  const verb = (to: string) => {
    if (to === "active") return state === "closed" || state === "resolved" ? "Reopen" : "Start work";
    if (to === "waiting") return "Waiting on something";
    if (to === "closed") return mover === "requester" ? "That's sorted - close it" : "Close it";
    if (to === "cancelled") return mover === "requester" ? "Withdraw it" : "Cancel it";
    if (to === "open") return "Reopen";
    return WO_LABEL[to] ?? to;
  };

  return (
    <div style={{ marginTop: 10 }}>
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
        {canResolve && (
          <button className="btn sm accent" disabled={pending}
            onClick={() => { setMode(mode === "resolve" ? "" : "resolve"); setError(""); }}>
            {mode === "resolve" ? "Cancel" : "Resolve it"}
          </button>
        )}
        {moves.map((to) => (
          <button key={to} className="btn sm" disabled={pending}
            onClick={() => run(() => setWorkOrderState(id, to))}>
            {verb(to)}
          </button>
        ))}
        {/* The call came in before anybody knew which instrument it was. Now
            somebody does - and the job, with its hours and parts, goes onto
            the system's history where it belongs. */}
        {mover === "house" && systems.length > 0 && (
          <span style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
            <select value={systemId || ""} aria-label="Put this job on a system" disabled={pending}
              className="t-small" style={{ width: "auto" }}
              onChange={(e) => setSystemId(parseInt(e.target.value) || 0)}>
              <option value="">Put it on a system...</option>
              {systems.map((x) => (
                <option key={x.id} value={x.id}>{x.externalId}{x.label ? ` - ${x.label}` : ""}</option>
              ))}
            </select>
            {systemId > 0 && (
              <button className="btn sm accent" disabled={pending}
                onClick={() => run(async () => {
                  const res = await attachWorkOrderSystem(id, systemId);
                  if (res.error) return res;
                  setSystemId(0);
                  toast({ message: `${number} is now on ${res.externalId}` });
                })}>
                {pending ? "Moving..." : "Move it"}
              </button>
            )}
          </span>
        )}
        {mover === "house" && (
          <span style={{ marginLeft: "auto", display: "flex", gap: 8, alignItems: "center" }}>
            <button className="btn sm" disabled={pending}
              onClick={() => { setMode(mode === "edit" ? "" : "edit"); setError(""); }}>
              {mode === "edit" ? "Cancel" : "Edit"}
            </button>
            {/* For the job opened by mistake. Cancelling is for one that was
                real and called off; this is for one that never should have
                existed - and it releases its work rather than taking it. */}
            <button className="btn link" style={{ color: "var(--t-bad-fg)" }} disabled={pending}
              onClick={async () => {
                const why = await confirmReason({
                  title: `Delete ${number}?`,
                  body: "Any tasks, hours, parts and files on it stay on the record, unattached. Its comments go with it.",
                  action: "Delete", tone: "bad",
                });
                if (!why) return;
                setError("");
                startTransition(async () => {
                  const res = await deleteWorkOrder(id, why);
                  if (res?.error) { setError(res.error); return; }
                  // The page it was on is gone; the list is where to land.
                  router.push("/work");
                });
              }}>Delete</button>
          </span>
        )}
      </div>

      {mode === "resolve" && (
        <Dialog open onClose={() => setMode("")} title={`Resolve ${number}`} context={title}
          footer={
            <>
              <DialogStatus error={error} problem={resolveProblem} />
              <button className="btn" onClick={() => setMode("")} disabled={pending}>Cancel</button>
              <button className="btn accent" disabled={pending || !!resolveProblem}
                onClick={() => run(() => resolveWorkOrder(id, summary, twoBox ? privateNotes : ""), `Resolved ${number}`)}>
                {pending ? "Saving..." : `Resolve ${number}`}
              </button>
            </>
          }>
          <label>{twoBox ? "Findings *" : "What was done? *"}</label>
          <textarea value={summary} onChange={(e) => setSummary(e.target.value)} rows={3} autoFocus
            placeholder="Replaced the deuterium lamp and re-ran the baseline - back in spec."
            style={{ width: "100%", marginBottom: 6 }} />
          <div className="mut t-meta" style={{ marginBottom: 8 }}>
            {twoBox
              ? <>Written for whoever owns this instrument next. It goes on the system&apos;s
                  discussion now, and travels with the machine if it ever changes hands - so
                  no site, no contact, no prices.</>
              : <>This is what {number} leaves behind. The tasks, hours and parts on it are counted and
                  added for you, and it goes on the system&apos;s discussion where the client will see it.</>}
          </div>
          {/* THE SPLIT, MADE AT THE KEYSTROKE. A read filter cannot tell which
              sentence names the client's site; the person typing can, and this
              is the only moment anybody asks them. */}
          {twoBox && (
            <div className="field">
              <label>Private notes <span className="field-opt">(stays with the shop)</span></label>
              <textarea value={privateNotes} onChange={(e) => setPrivateNotes(e.target.value)} rows={2}
                placeholder="Who to call, what it cost, what nearly went wrong - never leaves this workspace."
                style={{ width: "100%" }} />
            </div>
          )}
        </Dialog>
      )}

      {mode === "edit" && (
        <Dialog open onClose={() => setMode("")} title={`Edit ${number}`} context={title}
          footer={
            <>
              <DialogStatus error={error} problem={editProblem} />
              <button className="btn" onClick={() => setMode("")} disabled={pending}>Cancel</button>
              <button className="btn accent" disabled={pending || !!editProblem}
                onClick={() => run(() => updateWorkOrder(id, form), `Saved ${number}`)}>
                {pending ? "Saving..." : `Save ${number}`}
              </button>
            </>
          }>
          <div className="dialog-section">The job</div>
          <label>What is the job?</label>
          <input value={form.title} maxLength={160} style={{ marginBottom: 8 }}
            onChange={(e) => setForm({ ...form, title: e.target.value })} />
          <label>Detail</label>
          <textarea value={form.body} rows={3} style={{ width: "100%", marginBottom: 8 }}
            onChange={(e) => setForm({ ...form, body: e.target.value })} />
          <div className="dialog-section">Severity and assignee</div>
          <div className="pf2" style={{ marginBottom: 8 }}>
            <div>
              <label>How urgent</label>
              <select value={form.severity} onChange={(e) => setForm({ ...form, severity: e.target.value })}>
                {WO_SEVERITIES.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}
              </select>
            </div>
            <div>
              <label>Who has it</label>
              <select value={form.assignee} onChange={(e) => setForm({ ...form, assignee: e.target.value })}>
                <option value="">Nobody yet</option>
                {people.map((p) => <option key={p} value={p}>{p}</option>)}
              </select>
            </div>
          </div>
        </Dialog>
      )}

      {error && <div className="t-small" style={{ color: "var(--t-bad-fg)", marginTop: 8 }}>{error}</div>}
    </div>
  );
}
