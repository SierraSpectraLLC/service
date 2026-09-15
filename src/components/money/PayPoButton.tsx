"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { toast } from "@/components/ui/Toast";
import { payPurchaseOrder } from "@/app/money/actions";

/** Pay the vendor: the day and the reference, then payable down, bank down. */
export default function PayPoButton({ poId, label = "Pay", today }: { poId: number; label?: string; today?: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [paidOn, setPaidOn] = useState(today ?? new Date().toISOString().slice(0, 10));
  const [reference, setReference] = useState("");
  const [pending, startTransition] = useTransition();

  if (!open) return <button className="btn sm" onClick={() => setOpen(true)}>{label}</button>;
  return (
    <form className="inline-form" onSubmit={(e) => { e.preventDefault(); startTransition(async () => {
      const res = await payPurchaseOrder(poId, { paidOn, reference });
      if (res.error) { toast({ message: res.error, tone: "bad" }); return; }
      toast({ message: "Paid - payable / bank" });
      setOpen(false);
      router.refresh();
    }); }}>
      <label>Paid on<input type="date" value={paidOn} onChange={(e) => setPaidOn(e.target.value)} required /></label>
      <label>Reference<input type="text" value={reference} placeholder="check or ACH" onChange={(e) => setReference(e.target.value)} /></label>
      <button className="btn sm primary" type="submit" disabled={pending}>{pending ? "Paying…" : "Pay"}</button>
      <button className="btn sm" type="button" onClick={() => setOpen(false)}>Cancel</button>
    </form>
  );
}
