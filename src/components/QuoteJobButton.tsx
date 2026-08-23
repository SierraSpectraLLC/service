"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import Dialog from "@/components/ui/Dialog";
import { toast } from "@/components/ui/Toast";
import { draftQuote } from "@/app/actions";
import { addDays } from "@/lib/pm";

/**
 * Price the job before doing it.
 *
 * The lines are composed server-side from the same rows an invoice would use,
 * so the number the client agrees to and the number they are billed come from
 * one function. Two fields here, because they are the only two things a quote
 * has that an invoice does not: when it stops being true, and what is owed on
 * yes.
 */
export default function QuoteJobButton({ workOrderId, number, title, today }: {
  workOrderId: number; number: string; title: string; today: string;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  const [form, setForm] = useState({ title, expiresOn: addDays(today, 30), depositPct: "0" });
  const [error, setError] = useState("");

  const file = () => startTransition(async () => {
    setError("");
    const res = await draftQuote(workOrderId, {
      title: form.title,
      expiresOn: form.expiresOn,
      depositPct: parseInt(form.depositPct, 10) || 0,
    });
    if (res.error) { setError(res.error); return; }
    toast({ message: `Drafted the quote for ${number}` });
    setOpen(false);
    if (res.id) router.push(`/money/quotes/${res.id}`);
  });

  return (
    <>
      <button className="btn sm" onClick={() => setOpen(true)}>Quote this job</button>
      {open && (
        <Dialog open size="sm" title="Quote this job" context={number} onClose={() => setOpen(false)}
          footer={
            <>
              <span className="dialog-status">{error}</span>
              <button type="button" className="btn" onClick={() => setOpen(false)}>Cancel</button>
              <button type="button" className="btn primary" disabled={pending} onClick={file}>
                Draft the quote
              </button>
            </>
          }>
          <div className="field">
            <label htmlFor="q-title">What it is for</label>
            <input id="q-title" value={form.title} maxLength={160}
              onChange={(e) => setForm({ ...form, title: e.target.value })} />
          </div>
          <div className="field">
            <label htmlFor="q-expires">Good until</label>
            <input id="q-expires" type="date" value={form.expiresOn} min={today}
              onChange={(e) => setForm({ ...form, expiresOn: e.target.value })} />
            <div className="field-hint">
              After this it stops being answerable, and the digest starts asking about it a week out.
            </div>
          </div>
          <div className="field">
            <label htmlFor="q-deposit">Deposit on approval (%)</label>
            <input id="q-deposit" inputMode="numeric" value={form.depositPct} style={{ width: 90 }}
              onChange={(e) => setForm({ ...form, depositPct: e.target.value })} />
            <div className="field-hint">
              Zero means nothing is owed until the work is done. Anything else is invoiced the moment
              they approve, due immediately, and the portal says so before they press the button.
            </div>
          </div>
          <div className="mut t-small">
            The lines come from the parts and hours already on this job, priced at this client&apos;s rate
            card - the same composer the invoice uses.
          </div>
        </Dialog>
      )}
    </>
  );
}
