"use client";

import { useState, useTransition } from "react";
import { attachWorkOrderSystem, bookWorkOrder, deleteWorkOrder, resolveWorkOrder, setWorkOrderState, updateWorkOrder } from "@/app/actions";
import Dialog, { DialogStatus } from "@/components/ui/Dialog";
import { toast } from "@/components/ui/Toast";
import { useRouter } from "next/navigation";
import { confirmReason } from "@/components/ui/ConfirmDialog";
import { WO_LABEL, WO_SEVERITIES, bookingSpan, checkBooking, woLive, woMoves, type Mover } from "@/lib/workOrders";

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
  id, number, state, mover, title, body, severity, assignee, people, systems = [],
  bookedOn = "", bookedUntil = "", dueOn = "",
  requestedBy = "", clientSignatory = "", equipment,
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
  /** The days it is booked for, blank when it is not on the calendar. */
  bookedOn?: string;
  bookedUntil?: string;
  /**
   * The day it is wanted by, where somebody agreed one with the client. Blank
   * leaves the job on whatever its severity implies - see lib/workOrders.dueDay.
   */
  dueOn?: string;
  /** Who asked, and who signs the service report for them. */
  requestedBy?: string;
  clientSignatory?: string;
  /**
   * What the job is on, and what it could be on instead. Passed to staff on
   * every job, not only a record-less one: a call taken over the phone lands
   * on the stack, and the module it turns out to be about is chosen after
   * somebody has looked at it.
   */
  equipment?: {
    instrumentId: number | null;
    assetId: number | null;
    systems: { id: number; externalId: string; label: string }[];
    /** Every candidate system's units, filtered to the chosen one below. */
    assets: { id: number; instrumentId: number | null; label: string }[];
  };
}) {
  const [mode, setMode] = useState<"" | "resolve" | "edit" | "book">("");
  const [booking, setBooking] = useState({ bookedOn, bookedUntil });
  const [systemId, setSystemId] = useState(0);
  const [summary, setSummary] = useState("");
  const [form, setForm] = useState({
    title, body, severity, assignee, requestedBy, clientSignatory, dueOn,
    instrumentId: equipment?.instrumentId ?? 0,
    assetId: equipment?.assetId ?? 0,
  });
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
  const bookProblem = checkBooking(booking);

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
          <span style={{ marginLeft: "auto", display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
            {/* The van and the days, committed. A client asks for the week
                of the 19th; this is the shop saying yes, and the calendar
                draws the span linked back here. Only while the job is live -
                a closed job has nothing left to book. */}
            {woLive(state) && (
              <button className="btn sm" disabled={pending}
                onClick={() => { setBooking({ bookedOn, bookedUntil }); setMode(mode === "book" ? "" : "book"); setError(""); }}>
                {mode === "book" ? "Cancel" : bookedOn ? `Booked ${bookingSpan({ bookedOn, bookedUntil })}` : "Book it"}
              </button>
            )}
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
                onClick={() => run(() => resolveWorkOrder(id, summary), `Resolved ${number}`)}>
                {pending ? "Saving..." : `Resolve ${number}`}
              </button>
            </>
          }>
          <label>What was done? *</label>
          <textarea value={summary} onChange={(e) => setSummary(e.target.value)} rows={3} autoFocus
            placeholder="Replaced the deuterium lamp and re-ran the baseline - back in spec."
            style={{ width: "100%", marginBottom: 6 }} />
          <div className="mut t-meta" style={{ marginBottom: 8 }}>
            This is what {number} leaves behind. The tasks, hours and parts on it are counted and
            added for you, and it goes on the system&apos;s discussion where the client will see it.
          </div>
        </Dialog>
      )}

      {mode === "book" && (
        <Dialog open onClose={() => setMode("")} size="sm" title={bookedOn ? `Change the booking for ${number}` : `Book ${number}`} context={title}
          footer={
            <>
              <DialogStatus error={error} problem={bookProblem}
                ok={bookProblem ? undefined : `On site ${bookingSpan(booking)}`} />
              {bookedOn && (
                <button className="btn link" style={{ color: "var(--t-bad-fg)" }} disabled={pending}
                  onClick={() => run(() => bookWorkOrder(id, { bookedOn: "" }), `${number} is off the calendar`)}>
                  Take it off the calendar
                </button>
              )}
              <button className="btn" onClick={() => setMode("")} disabled={pending}>Cancel</button>
              <button className="btn accent" disabled={pending || !!bookProblem}
                onClick={() => run(() => bookWorkOrder(id, booking), `Booked ${number} for ${bookingSpan(booking)}`)}>
                {pending ? "Booking..." : bookedOn ? "Save the booking" : "Book it"}
              </button>
            </>
          }>
          <div className="pf2" style={{ marginBottom: 8 }}>
            <div>
              <label>First day on site</label>
              <input type="date" value={booking.bookedOn} aria-label="First day" autoFocus disabled={pending}
                onChange={(e) => setBooking({ ...booking, bookedOn: e.target.value })} />
            </div>
            <div>
              <label>Last day (optional)</label>
              <input type="date" value={booking.bookedUntil} min={booking.bookedOn} aria-label="Last day" disabled={pending}
                onChange={(e) => setBooking({ ...booking, bookedUntil: e.target.value })} />
            </div>
          </div>
          <div className="mut t-meta">
            It goes on the calendar under Booked visits, one entry per day, linked back to this job.
            The client sees it on theirs. Leave the last day blank for a single day.
          </div>
        </Dialog>
      )}

      {mode === "edit" && (
        <Dialog open onClose={() => setMode("")} title={`Edit ${number}`} context={title}
          footer={
            <>
              <DialogStatus error={error} problem={editProblem} />
              <button className="btn" onClick={() => setMode("")} disabled={pending}>Cancel</button>
              <button className="btn accent" disabled={pending || !!editProblem}
                onClick={() => run(() => updateWorkOrder(id, {
                  ...form,
                  // Untouched stays untouched: a form that always sent the
                  // equipment would re-file the job on every typo fix.
                  ...(equipment ? { instrumentId: form.instrumentId || null, assetId: form.assetId || null } : {}),
                }), `Saved ${number}`)}>
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

          {/* What was agreed beats what the severity assumed. A job everybody
              has planned for the 20th should not sit in a list saying late. */}
          <div className="pf2" style={{ marginBottom: 8 }}>
            <div>
              <label>Wanted by</label>
              <input type="date" value={form.dueOn} aria-label="The day this job is wanted by"
                onChange={(e) => setForm({ ...form, dueOn: e.target.value })} />
              <div className="mut t-meta" style={{ marginTop: 3 }}>
                {form.dueOn
                  ? "Not late until this day passes."
                  : "Blank follows the severity - Down today, Planned in a month - or a booked visit, where one is further out."}
              </div>
            </div>
          </div>

          {/* The client's two people: the one who called, and the one who
              signs for the visit. On a big site they are rarely the same. */}
          <div className="dialog-section">The client&apos;s people</div>
          <div className="pf2" style={{ marginBottom: 8 }}>
            <div>
              <label>Who asked</label>
              <input value={form.requestedBy} maxLength={120} placeholder="Their name"
                onChange={(e) => setForm({ ...form, requestedBy: e.target.value })} />
            </div>
            <div>
              <label>Who signs the report</label>
              <input value={form.clientSignatory} maxLength={120}
                placeholder={form.requestedBy.trim() || "Whoever asked"}
                onChange={(e) => setForm({ ...form, clientSignatory: e.target.value })} />
              <div className="mut t-meta" style={{ marginTop: 3 }}>
                Prints beside &quot;Rep Name:&quot; on the service report. Blank means whoever asked.
              </div>
            </div>
          </div>

          {equipment && (
            <>
              <div className="dialog-section">What it is on</div>
              <div className="pf2" style={{ marginBottom: 8 }}>
                <div>
                  <label>System</label>
                  <select value={form.instrumentId || ""} aria-label="System this job is on"
                    onChange={(e) => {
                      const instrumentId = parseInt(e.target.value) || 0;
                      // A module belongs to its system, so moving the system
                      // takes the module off rather than carrying a unit that
                      // is fitted somewhere else.
                      const keep = equipment.assets.some((a) => a.id === form.assetId && a.instrumentId === instrumentId);
                      setForm({ ...form, instrumentId, assetId: keep ? form.assetId : 0 });
                    }}>
                    <option value="">No system</option>
                    {equipment.systems.map((x) => (
                      <option key={x.id} value={x.id}>{x.externalId}{x.label ? ` - ${x.label}` : ""}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <label>Module</label>
                  <select value={form.assetId || ""} aria-label="Module this job is on"
                    onChange={(e) => setForm({ ...form, assetId: parseInt(e.target.value) || 0 })}>
                    <option value="">The whole system</option>
                    {equipment.assets
                      .filter((a) => a.instrumentId === form.instrumentId)
                      .map((a) => <option key={a.id} value={a.id}>{a.label}</option>)}
                  </select>
                  <div className="mut t-meta" style={{ marginTop: 3 }}>
                    The unit the work was on. Its own model and serial are what the report names.
                  </div>
                </div>
              </div>
            </>
          )}
        </Dialog>
      )}

      {error && <div className="t-small" style={{ color: "var(--t-bad-fg)", marginTop: 8 }}>{error}</div>}
    </div>
  );
}
