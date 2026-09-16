"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { closeQuoteAsLost } from "@/app/actions";
import Dialog, { DialogStatus } from "@/components/ui/Dialog";
import { toast } from "@/components/ui/Toast";
import { isLostOutcome, LOST_CHOICES, LOST_PROMPT, type LostOutcome } from "@/lib/quotes";

/**
 * We lost it: close the quote out and say which way.
 *
 * The sibling of AwardQuoteButton, and deliberately shaped like it, because a
 * shop does these two things at the same desk on the same afternoon. The
 * client's own page has Approve and Decline; what it has no button for is the
 * thing that actually happens most of the time - somebody rings, or replies to
 * the email, or says it on a visit - and until this existed the quote sat in
 * the pipeline awaiting an answer it had already been given, counting itself
 * into the quoted figure and onto the morning chase list until its expiry date
 * quietly rescued it.
 *
 * Three fields, and each is a thing the quote cannot know: WHICH loss it was,
 * WHO told us, and WHAT they said. The first is the one worth the extra click -
 * see LOST_CHOICES. A shop that files "they went with the OEM on lead time"
 * under the same word as "your price is too high" has thrown away the only
 * question this record was ever going to answer.
 */
export default function CloseQuoteButton({ quoteId, number }: {
  quoteId: number;
  number: string;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState("");
  const [form, setForm] = useState<{ outcome: LostOutcome; heardFrom: string; reason: string }>({
    outcome: "declined", heardFrom: "", reason: "",
  });

  // The server demands the reason too - see closeQuoteAsLost. This is the front
  // door, not the lock, and it says so before the button is pressed rather than
  // after: the reason IS the record here, and a loss filed with nothing beside
  // it is a row nobody will ever learn anything from.
  const problem = form.reason.trim().length < 3 ? "say what they told us" : null;
  const picked = LOST_CHOICES.find((c) => c.value === form.outcome);

  const save = () =>
    startTransition(async () => {
      const res = await closeQuoteAsLost(quoteId, {
        outcome: form.outcome, reason: form.reason, heardFrom: form.heardFrom,
      });
      if (res.error) { setError(res.error); return; }
      toast({ message: `${number} closed as ${picked?.label.toLowerCase() ?? "lost"}` });
      setOpen(false);
      router.refresh();
    });

  return (
    <>
      <button className="btn sm" onClick={() => { setError(""); setOpen(true); }}>
        Mark lost
      </button>
      {open && (
        <Dialog open onClose={() => setOpen(false)} size="sm"
          title={`How did ${number} end?`}
          context={LOST_PROMPT}
          footer={
            <>
              <DialogStatus error={error} problem={problem} ok={picked?.note} />
              <button className="btn" onClick={() => setOpen(false)} disabled={pending}>Cancel</button>
              <button className="btn accent" onClick={save} disabled={pending || !!problem}>
                {pending ? "Closing..." : "Close the quote"}
              </button>
            </>
          }>
          <div className="pf2">
            <div>
              <label htmlFor="lost-outcome">Outcome</label>
              <select id="lost-outcome" value={form.outcome}
                onChange={(e) => setForm({
                  ...form,
                  outcome: isLostOutcome(e.target.value) ? e.target.value : "declined",
                })}>
                {LOST_CHOICES.map((c) => (
                  <option key={c.value} value={c.value}>{c.label}</option>
                ))}
              </select>
              <div className="field-hint">
                Rejected is feedback about our price. Not awarded is where the work went.
              </div>
            </div>
            <div>
              <label htmlFor="lost-heard">Who told us</label>
              <input id="lost-heard" value={form.heardFrom} aria-label="Who told us"
                placeholder="blank if nobody was named"
                onChange={(e) => setForm({ ...form, heardFrom: e.target.value })} />
              {/* Their name, never ours. It is filed as the client's side of the
                  answer, and the account that recorded it is kept separately -
                  see quotes.closed_by. */}
              <div className="field-hint">Their name, not yours. Yours is recorded anyway.</div>
            </div>
          </div>
          <label htmlFor="lost-reason" style={{ marginTop: 8 }}>What they said</label>
          <textarea id="lost-reason" rows={3} value={form.reason} style={{ width: "100%" }}
            placeholder="Went to the OEM on lead time"
            onChange={(e) => setForm({ ...form, reason: e.target.value })} />
          <div className="field-hint">
            Kept with the quote and posted to the job, where the engineer will read it.
          </div>
        </Dialog>
      )}
    </>
  );
}
