"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { addCalendarNote, requestPm } from "@/app/actions";
import { NOTE_MAX_DAYS, checkNote } from "@/lib/calendarNotes";
import { PM_WINDOWS, VISIT_KINDS, daysLabel } from "@/lib/pmRequest";
import Dialog, { DialogStatus } from "@/components/ui/Dialog";
import WeekdayPicker from "@/components/WeekdayPicker";
import { toast } from "@/components/ui/Toast";

/**
 * The two things a client can DO on their calendar.
 *
 * ASK FOR A VISIT: how soon, and which days of the week suit them. Which is a
 * request and says so - it files planned work into the shop's queue carrying
 * both, and the shop confirms it by booking the visit, at which point it
 * appears here as a booked visit rather than as an open job. Asking does not
 * put an engineer on a day, and the copy is careful to say so; see requestPm,
 * whose own comment is the rule this follows.
 *
 * Days of the WEEK rather than a date, because that is the shape of the fact a
 * lab actually has - "we are covered Mondays and Wednesdays" - and it leaves
 * the shop free to route a van. A single named date was the first cut of this
 * and asked the client to guess at a schedule they cannot see.
 *
 * WRITE A NOTE, which is the other half and the reason the portal is worth
 * opening: the shutdown week, the audit, the fortnight the only person who can
 * badge us in is away. The shop reads these on its own calendar, which is
 * what makes writing one worth the thirty seconds.
 */
export default function ClientCalendarActions({ systems, today, month }: {
  /** Their own machines, for the "which one" picker. Empty hides the ask. */
  systems: { id: number; label: string }[];
  today: string;
  /** The month being read, so a note defaults into it rather than into today. */
  month: string;
}) {
  const router = useRouter();
  const [open, setOpen] = useState<null | "visit" | "note">(null);
  const [error, setError] = useState("");
  const [pending, startTransition] = useTransition();

  /* A day in the month being looked at, which is where somebody's attention
     already is - defaulting to today would put the note in another month when
     they are three pages ahead planning a shutdown. */
  const firstOfMonth = `${month}-01`;
  const seedDay = month === today.slice(0, 7) ? today : firstOfMonth;

  const [visit, setVisit] = useState({
    instrumentId: String(systems[0]?.id ?? ""), kind: "pm",
    days: [] as number[], window: "month", note: "",
  });
  const [note, setNote] = useState({ onDate: seedDay, endsOn: "", title: "", note: "" });

  const openVisit = () => {
    setError("");
    setVisit({
      instrumentId: String(systems[0]?.id ?? ""), kind: "pm",
      days: [], window: "month", note: "",
    });
    setOpen("visit");
  };
  const openNote = () => {
    setError("");
    setNote({ onDate: seedDay, endsOn: "", title: "", note: "" });
    setOpen("note");
  };

  const noteProblem = checkNote(note);
  const visitProblem = !visit.instrumentId ? "pick which system"
    : !visit.note.trim() ? "say what you need" : null;

  const askForVisit = () =>
    startTransition(async () => {
      setError("");
      const res = await requestPm(parseInt(visit.instrumentId, 10), {
        window: visit.window, note: visit.note,
        days: visit.days, kind: visit.kind,
      });
      if (res?.error) { setError(res.error); return; }
      toast({
        message: res.already
          ? "Added to the request already open for that system"
          : `Sent${res.number ? ` as ${res.number}` : ""} - we will confirm a date`,
      });
      setOpen(null);
      router.refresh();
    });

  const saveNote = () =>
    startTransition(async () => {
      setError("");
      const res = await addCalendarNote(note);
      if (res?.error) { setError(res.error); return; }
      toast({ message: "Noted - your service team can see it too" });
      setOpen(null);
      router.refresh();
    });

  return (
    <>
      <div className="card" style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
        {systems.length > 0 && (
          <button className="btn sm primary" onClick={openVisit}>Ask for a visit</button>
        )}
        <button className="btn sm" onClick={openNote}>Add a note</button>
        <span className="mut t-small" style={{ flex: "1 1 220px" }}>
          Tell us when suits and we will confirm a date. Notes are for anything we
          should know - a shutdown, an audit week, a delivery.
        </span>
      </div>

      {open === "visit" && (
        <Dialog open onClose={() => setOpen(null)} size="sm" title="Ask for a visit"
          context="We will confirm the date with you"
          footer={
            <>
              <DialogStatus error={error} problem={visitProblem}
                ok={visit.days.length ? `Prefers ${daysLabel(visit.days)}` : undefined} />
              <button className="btn" onClick={() => setOpen(null)} disabled={pending}>Cancel</button>
              <button className="btn accent" onClick={askForVisit} disabled={pending || !!visitProblem}>
                {pending ? "Sending..." : "Send the request"}
              </button>
            </>
          }>
          <div className="dialog-section">What you need</div>
          <div className="pf2" style={{ marginBottom: 8 }}>
            <div>
              <label>Which system</label>
              <select value={visit.instrumentId} aria-label="Which system" disabled={pending}
                onChange={(e) => setVisit({ ...visit, instrumentId: e.target.value })}>
                {systems.map((x) => <option key={x.id} value={String(x.id)}>{x.label}</option>)}
              </select>
            </div>
            <div>
              <label>What kind</label>
              <select value={visit.kind} aria-label="What kind" disabled={pending}
                onChange={(e) => setVisit({ ...visit, kind: e.target.value })}>
                {VISIT_KINDS.map((k) => <option key={k.key} value={k.key}>{k.label}</option>)}
              </select>
            </div>
          </div>
          <div className="field-hint" style={{ marginBottom: 8 }}>
            {VISIT_KINDS.find((k) => k.key === visit.kind)?.hint}
            {" "}Something broken right now is better reported from the system&apos;s own page,
            where you can set how bad it is and attach a photo.
          </div>

          <div className="dialog-section">How soon</div>
          <select value={visit.window} aria-label="How soon" disabled={pending}
            style={{ marginBottom: 8 }}
            onChange={(e) => setVisit({ ...visit, window: e.target.value })}>
            {PM_WINDOWS.map((w) => <option key={w.key} value={w.key}>{w.label}</option>)}
          </select>

          <div className="dialog-section">Days that suit you</div>
          <WeekdayPicker value={visit.days} disabled={pending}
            onChange={(days) => setVisit({ ...visit, days })} />
          {/* Said plainly, because a form that takes a preference and then goes
              quiet is the one way this could leave somebody standing around
              waiting for an engineer nobody dispatched. */}
          <div className="field-hint" style={{ margin: "8px 0" }}>
            This asks - it does not book. We will confirm a date, and it will appear
            on this calendar as a booked visit.
          </div>

          <label>What needs doing</label>
          <textarea value={visit.note} aria-label="What needs doing" rows={3} disabled={pending}
            placeholder="The autosampler is due its service, and we have the bay free that week"
            onChange={(e) => setVisit({ ...visit, note: e.target.value })} />
        </Dialog>
      )}

      {open === "note" && (
        <Dialog open onClose={() => setOpen(null)} size="sm" title="Add a note"
          context="Your service team sees this too"
          footer={
            <>
              <DialogStatus error={error} problem={noteProblem} />
              <button className="btn" onClick={() => setOpen(null)} disabled={pending}>Cancel</button>
              <button className="btn accent" onClick={saveNote} disabled={pending || !!noteProblem}>
                {pending ? "Saving..." : "Add it"}
              </button>
            </>
          }>
          <label>What is happening</label>
          <input value={note.title} aria-label="What is happening" disabled={pending}
            placeholder="Site closed - annual audit"
            onChange={(e) => setNote({ ...note, title: e.target.value })} style={{ marginBottom: 8 }} />
          <div className="pf2">
            <div>
              <label>From</label>
              <input type="date" value={note.onDate} aria-label="From" disabled={pending}
                onChange={(e) => setNote({ ...note, onDate: e.target.value })} />
            </div>
            <div>
              <label>To (optional)</label>
              <input type="date" value={note.endsOn} min={note.onDate} aria-label="To" disabled={pending}
                onChange={(e) => setNote({ ...note, endsOn: e.target.value })} />
            </div>
          </div>
          <div className="field-hint" style={{ marginTop: 4, marginBottom: 8 }}>
            Leave the end date empty for a single day. At most {NOTE_MAX_DAYS} days at a time.
          </div>
          <label>Anything else</label>
          <textarea value={note.note} aria-label="Anything else" rows={2} disabled={pending}
            placeholder="Badge office closed too - call ahead"
            onChange={(e) => setNote({ ...note, note: e.target.value })} />
        </Dialog>
      )}
    </>
  );
}
