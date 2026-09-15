"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { confirmDialog, confirmReason } from "@/components/ui/ConfirmDialog";
import { toast } from "@/components/ui/Toast";
import { closeBooks, remitTax, reverseLedgerEntry, runPayroll } from "@/app/money/actions";

/** Reverse one entry: the mirror dated today, the reason kept. */
export function ReverseEntryButton({ entryId }: { entryId: number }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  return (
    <button className="btn sm" disabled={pending} onClick={async () => {
      // The question is asked BEFORE the transition: an update made inside an
      // async transition commits when the action settles, and an action that
      // is waiting on the dialog it has not yet shown never settles.
      const why = await confirmReason({
        title: `Reverse entry #${entryId}?`,
        body: "The original row stays. A mirror entry dated today corrects it, with your reason on it.",
        action: "Reverse",
      });
      if (!why) return;
      startTransition(async () => {
        const res = await reverseLedgerEntry(entryId, why);
        if (res.error) { toast({ message: res.error, tone: "bad" }); return; }
        toast({ message: `Reversed entry #${entryId} - the mirror is dated today` });
        router.refresh();
      });
    }}>{pending ? "Reversing…" : "Reverse this entry"}</button>
  );
}

/** Close the books through a month, or reopen. */
export function CloseBooksForm({ closedThrough, months }: { closedThrough: string; months: { ym: string; label: string }[] }) {
  const router = useRouter();
  const [ym, setYm] = useState(months[0]?.ym ?? "");
  const [pending, startTransition] = useTransition();
  const act = async (month: string) => {
    if (month && !(await confirmDialog({
      title: `Close the books through ${months.find((m) => m.ym === month)?.label ?? month}?`,
      body: "Nothing before it can be posted to again. A mistake found later is corrected by a reversing entry dated today, so the month your accountant already has never changes under them.",
      action: "Close",
    }))) return;
    startTransition(async () => {
      const res = await closeBooks(month);
      if (res.error) { toast({ message: res.error, tone: "bad" }); return; }
      toast({ message: month ? `Closed the books through ${month}` : "Reopened the books" });
      router.refresh();
    });
  };
  return (
    <div className="inline-form">
      {months.length > 0 && (
        <>
          <label>Through
            <select value={ym} onChange={(e) => setYm(e.target.value)}>
              {months.map((m) => <option key={m.ym} value={m.ym}>{m.label}</option>)}
            </select>
          </label>
          <button className="btn sm primary" disabled={pending || !ym} onClick={() => act(ym)}>Close</button>
        </>
      )}
      {closedThrough && <button className="btn sm" disabled={pending} onClick={() => act("")}>Reopen</button>}
    </div>
  );
}

/** Sales tax paid to the state: the liability down, bank down. */
export function RemitTaxButton({ period, today }: { period: string; today: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [paidOn, setPaidOn] = useState(today);
  const [label, setLabel] = useState(period);
  const [pending, startTransition] = useTransition();
  if (!open) return <button className="btn sm" onClick={() => setOpen(true)}>Remit</button>;
  return (
    <form className="inline-form" onSubmit={(e) => { e.preventDefault(); startTransition(async () => {
      const res = await remitTax({ period: label, paidOn });
      if (res.error) { toast({ message: res.error, tone: "bad" }); return; }
      toast({ message: "Remitted sales tax - sales tax owed / bank" });
      setOpen(false);
      router.refresh();
    }); }}>
      <label>Period<input type="text" value={label} onChange={(e) => setLabel(e.target.value)} required /></label>
      <label>Paid on<input type="date" value={paidOn} onChange={(e) => setPaidOn(e.target.value)} required /></label>
      <button className="btn sm primary" type="submit" disabled={pending}>{pending ? "Remitting…" : "Remit"}</button>
      <button className="btn sm" type="button" onClick={() => setOpen(false)}>Cancel</button>
    </form>
  );
}

/** Run a month's payroll from the register page. */
export function PayrollRunButton({ ym, label, grossLabel }: { ym: string; label: string; grossLabel: string }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  return (
    <button className="btn sm" disabled={pending} onClick={async () => {
      if (!(await confirmDialog({
        title: `Run payroll for ${label}?`,
        body: `Posts ${grossLabel} gross to payroll and out of the bank, dated today. Once per month; a correction is a reversal.`,
        action: "Run payroll",
      }))) return;
      startTransition(async () => {
        const res = await runPayroll(ym);
        if (res.error) { toast({ message: res.error, tone: "bad" }); return; }
        toast({ message: `Ran payroll for ${label} - payroll / bank` });
        router.refresh();
      });
    }}>{pending ? "Running…" : "Run payroll"}</button>
  );
}
