"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { toast } from "@/components/ui/Toast";
import { askAboutLine } from "@/app/money/actions";

/**
 * The client's question about one line, or about the whole bill. Opens a
 * dispute on the shop's side and pauses collection on that line until the
 * shop answers - which is the point: a question about a charge should stop
 * the reminders about it, not race them.
 */
export default function AskAboutLine({ invoiceId, lineId, label = "Ask about this" }: {
  invoiceId: number; lineId: number | null; label?: string;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [pending, startTransition] = useTransition();
  if (!open) return <button className="btn link t-meta" type="button" onClick={() => setOpen(true)}>{label}</button>;
  return (
    <form className="inline-form" onSubmit={(e) => { e.preventDefault(); startTransition(async () => {
      const res = await askAboutLine(invoiceId, { lineId, reason });
      if (res.error) { toast({ message: res.error, tone: "bad" }); return; }
      toast({ message: "Sent to the shop - reminders on this pause until they answer" });
      setOpen(false); setReason("");
      router.refresh();
    }); }}>
      <label>Your question<input type="text" value={reason} placeholder="What is this charge for?" onChange={(e) => setReason(e.target.value)} required autoFocus /></label>
      <button className="btn sm primary" type="submit" disabled={pending || reason.trim().length < 3}>{pending ? "Sending…" : "Send"}</button>
      <button className="btn sm" type="button" onClick={() => setOpen(false)}>Cancel</button>
    </form>
  );
}
