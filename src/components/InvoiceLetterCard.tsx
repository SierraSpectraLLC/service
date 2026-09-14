"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { updateInvoice } from "@/app/actions";
import { Panel } from "@/components/ui";
import { toast } from "@/components/ui/Toast";

/**
 * The words around an invoice's table: what it is for, the PO it answers,
 * and the shop's note under the total.
 *
 * A quote is a letter and has had a card like this for a while; an invoice
 * had the same three fields on its row and no way to write them - the title
 * was borrowed from the job, the note was set nowhere. The PO stays
 * editable after send, because that is when a client's purchasing department
 * sends it; the title and the note are draft-only, like the lines, since the
 * copy the client is reading should stay as read.
 */
export default function InvoiceLetterCard({ invoiceId, status, letter }: {
  invoiceId: number;
  status: string;
  letter: { title: string; poNumber: string; note: string };
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [d, setD] = useState(letter);
  const draft = status === "draft";
  const dirty = d.title !== letter.title || d.poNumber !== letter.poNumber || d.note !== letter.note;

  const save = () => start(async () => {
    const res = await updateInvoice(invoiceId, {
      poNumber: d.poNumber,
      ...(draft ? { title: d.title, note: d.note } : {}),
    });
    if (res.error) { toast({ message: res.error, tone: "bad" }); return; }
    toast({ message: "Saved" });
    router.refresh();
  });

  return (
    <Panel title="About this invoice"
      hint={draft
        ? "The title prints under the number on every copy; the note prints under the total, in your words."
        : "Sent, so it reads as sent - only the PO can still be filled in."}>
      <label>What it is for</label>
      <input value={d.title} maxLength={160} disabled={pending || !draft} aria-label="Invoice title"
        placeholder="Onsite engineering support, September 2026"
        onChange={(e) => setD({ ...d, title: e.target.value })} />
      <div className="pf2" style={{ marginTop: 8 }}>
        <div>
          <label>Client PO</label>
          <input value={d.poNumber} maxLength={60} disabled={pending} aria-label="PO number" className="mono"
            placeholder="PO-4471" onChange={(e) => setD({ ...d, poNumber: e.target.value })} />
        </div>
      </div>
      <label style={{ marginTop: 8 }}>Note to the client</label>
      <textarea value={d.note} rows={3} maxLength={2000} disabled={pending || !draft} aria-label="Invoice note"
        placeholder="Thank you - the next visit is booked for the week of the 19th."
        style={{ width: "100%" }} onChange={(e) => setD({ ...d, note: e.target.value })} />
      <div className="row-2" style={{ marginTop: 8 }}>
        <button className="btn sm accent" onClick={save} disabled={pending || !dirty}>
          {pending ? "Saving..." : "Save"}
        </button>
        {dirty && <button className="btn sm" onClick={() => setD(letter)} disabled={pending}>Discard</button>}
      </div>
    </Panel>
  );
}
