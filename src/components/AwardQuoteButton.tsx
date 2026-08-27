"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { awardFromQuote } from "@/app/actions";
import Dialog, { DialogStatus } from "@/components/ui/Dialog";
import { toast } from "@/components/ui/Toast";

/**
 * We won it: turn the quote's coverage periods into contracts.
 *
 * One button because the quote already holds the shape - the CLIN lines the
 * estimate builder wrote ARE the periods, in order - so nothing is retyped and
 * the contract that goes into force is the one the client accepted. What it
 * asks for is only what the quote cannot know: their contract number, the day
 * the base year actually begins (a solicitation's start is rarely the day they
 * signed), and how long before each option year they have to tell us.
 */
export default function AwardQuoteButton({ quoteId, periods, today, defaultNumber }: {
  quoteId: number;
  periods: number;
  today: string;
  defaultNumber: string;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState("");
  const [form, setForm] = useState({
    number: defaultNumber, startsOn: "", awardedOn: today, notice: "60", visits: "",
  });

  const problem = !form.startsOn ? "say when the base year begins"
    : form.visits.trim() !== "" && !Number.isFinite(Number(form.visits)) ? "visits must be a number"
      : null;

  const save = () =>
    startTransition(async () => {
      const res = await awardFromQuote(quoteId, {
        number: form.number, startsOn: form.startsOn, awardedOn: form.awardedOn,
        optionNoticeDays: Number(form.notice) || 0,
        visitsIncluded: Number(form.visits) || 0,
      });
      if (res.error) { setError(res.error); return; }
      toast({ message: `${res.periods} contracts - the base year is in force, the rest are options` });
      setOpen(false);
      router.push("/money/contracts");
    });

  return (
    <>
      <button className="btn sm primary" onClick={() => { setError(""); setOpen(true); }}>
        Record the award
      </button>
      {open && (
        <Dialog open onClose={() => setOpen(false)} size="sm"
          title="Record the award"
          context={`${periods} contracts, one per period. Only the base year goes into force - the rest wait to be exercised.`}
          footer={
            <>
              <DialogStatus error={error} problem={problem} ok="Ready." />
              <button className="btn" onClick={() => setOpen(false)} disabled={pending}>Cancel</button>
              <button className="btn accent" onClick={save} disabled={pending || !!problem}>
                {pending ? "Recording..." : `Create ${periods} contracts`}
              </button>
            </>
          }>
          <div className="pf2">
            <div>
              <label>Their contract number</label>
              <input className="mono t-small" value={form.number} aria-label="Contract number"
                onChange={(e) => setForm({ ...form, number: e.target.value })} />
              <div className="field-hint">What they will quote back at you.</div>
            </div>
            <div>
              <label>Awarded on</label>
              <input type="date" value={form.awardedOn} aria-label="Awarded on"
                onChange={(e) => setForm({ ...form, awardedOn: e.target.value })} />
            </div>
          </div>
          <div className="pf2">
            <div>
              <label>Base year begins</label>
              <input type="date" value={form.startsOn} aria-label="Base year begins"
                onChange={(e) => setForm({ ...form, startsOn: e.target.value })} />
              {/* Rarely the day they signed. Every period is counted from here,
                  so it is the one field worth getting off the paperwork. */}
              <div className="field-hint">Each period runs twelve months from the one before.</div>
            </div>
            <div>
              <label>Option notice</label>
              <input className="mono t-small" value={form.notice} aria-label="Option notice days"
                onChange={(e) => setForm({ ...form, notice: e.target.value })} />
              <div className="field-hint">Days before a period starts that they must decide.</div>
            </div>
          </div>
          <label style={{ marginTop: 8 }}>Visits included a year</label>
          <input className="mono t-small" value={form.visits} aria-label="Visits included"
            placeholder="blank if it is not counted that way"
            onChange={(e) => setForm({ ...form, visits: e.target.value })} />
          <div className="field-hint">
            Parts are included on every period: the estimate priced them into the fee, so
            drawing them from an allowance as well would bill them twice.
          </div>
        </Dialog>
      )}
    </>
  );
}
