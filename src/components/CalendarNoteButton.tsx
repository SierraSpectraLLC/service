"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { addCalendarNote } from "@/app/actions";
import { NOTE_MAX_DAYS, checkNote } from "@/lib/calendarNotes";
import Dialog, { DialogStatus } from "@/components/ui/Dialog";
import { toast } from "@/components/ui/Toast";

/**
 * The shop's own note on its calendar.
 *
 * A client had "Add a note" on their calendar from the start - the shutdown
 * week, the audit - and the shop reads every one of those. The shop itself
 * had no way to write one: a holiday, a trade show, a delivery window, or a
 * client's closure the client never typed in. Same action, same rules
 * (lib/calendarNotes); the one extra is WHOSE note it is, because on the
 * shop's calendar "shut for stocktake" means nothing without the company in
 * front of it. Blank is the shop's own.
 */
export default function CalendarNoteButton({ today, month, orgs }: {
  today: string;
  /** The month being read, so a note defaults into it rather than into today. */
  month: string;
  /** Client organizations the note may be about. */
  orgs: { id: number; name: string }[];
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [error, setError] = useState("");
  const [pending, startTransition] = useTransition();
  const seedDay = month === today.slice(0, 7) ? today : `${month}-01`;
  const [note, setNote] = useState({ onDate: seedDay, endsOn: "", title: "", note: "", orgId: "" });

  const problem = checkNote(note);

  const openNote = () => {
    setError("");
    setNote({ onDate: seedDay, endsOn: "", title: "", note: "", orgId: "" });
    setOpen(true);
  };

  const save = () =>
    startTransition(async () => {
      setError("");
      const res = await addCalendarNote({
        onDate: note.onDate, endsOn: note.endsOn, title: note.title, note: note.note,
        orgId: note.orgId ? parseInt(note.orgId, 10) : null,
      });
      if (res?.error) { setError(res.error); return; }
      toast({ message: "Noted" });
      setOpen(false);
      router.refresh();
    });

  return (
    <>
      <button className="btn sm primary" onClick={openNote}>+ Note</button>
      {open && (
        <Dialog open onClose={() => setOpen(false)} size="sm" title="Add a note"
          context="Anything the calendar should carry that no record owns - a holiday, a closure, a delivery."
          footer={
            <>
              <DialogStatus error={error} problem={problem} />
              <button className="btn" onClick={() => setOpen(false)} disabled={pending}>Cancel</button>
              <button className="btn accent" onClick={save} disabled={pending || !!problem}>
                {pending ? "Saving..." : "Add it"}
              </button>
            </>
          }>
          <label>What is happening</label>
          <input value={note.title} maxLength={120} autoFocus aria-label="Title" disabled={pending}
            placeholder="Shop closed - trade show"
            onChange={(e) => setNote({ ...note, title: e.target.value })} />
          <div className="pf2" style={{ marginTop: 8 }}>
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
          {orgs.length > 0 && (
            <div style={{ marginTop: 8 }}>
              <label>About</label>
              <select value={note.orgId} aria-label="Whose note" disabled={pending}
                onChange={(e) => setNote({ ...note, orgId: e.target.value })}>
                <option value="">Us - the shop's own calendar</option>
                {orgs.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
              </select>
              <div className="field-hint">
                A note about a client shows on their calendar too, in your words.
              </div>
            </div>
          )}
          <label style={{ marginTop: 8 }}>Anything else</label>
          <input value={note.note} maxLength={1000} aria-label="Detail" disabled={pending}
            placeholder="Back on the Monday"
            onChange={(e) => setNote({ ...note, note: e.target.value })} />
          <div className="mut t-meta" style={{ marginTop: 8 }}>
            Up to {NOTE_MAX_DAYS} days; it is drawn on every day it covers.
          </div>
        </Dialog>
      )}
    </>
  );
}
