"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useTransition } from "react";
import { confirmDialog } from "@/components/ui/ConfirmDialog";
import { toast } from "@/components/ui/Toast";
import { markInvoiceSent, runPayroll } from "@/app/money/actions";
import DraftInvoiceButton from "@/components/DraftInvoiceButton";
import PayPoButton from "@/components/money/PayPoButton";
import type { DecisionAction } from "@/lib/money/decisions";

/**
 * The button on a decision row. Every row's button IS the action: it posts,
 * or it opens the one page where the posting form lives. The verb on the
 * button is the verb in the toast.
 */
export default function DecisionButton({ action }: { action: DecisionAction }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  if (action.kind === "link") {
    const external = /^https?:\/\//.test(action.href);
    const cls = `btn sm${action.primary ? " primary" : action.accent ? " accent" : ""}`;
    return external
      ? <a className={cls} href={action.href} target="_blank" rel="noreferrer">{action.label}</a>
      : <Link className={cls} href={action.href}>{action.label}</Link>;
  }
  if (action.kind === "draft-invoice") {
    return <DraftInvoiceButton workOrderId={action.workOrderId} number={action.number} label={action.label} />;
  }
  if (action.kind === "pay-po") {
    return <PayPoButton poId={action.id} label={action.label} />;
  }
  if (action.kind === "send-invoice") {
    return (
      <button className="btn sm primary" disabled={pending} onClick={() => startTransition(async () => {
        const res = await markInvoiceSent(action.id);
        if (res.error) { toast({ message: res.error, tone: "bad" }); return; }
        toast({ message: "Sent - posted to receivable and revenue" });
        router.refresh();
      })}>{pending ? "Sending…" : action.label}</button>
    );
  }
  return (
    <button className="btn sm" disabled={pending} onClick={() => startTransition(async () => {
      if (!(await confirmDialog({
        title: `Run payroll for ${action.ym}?`,
        body: "Posts the register's gross for the month to payroll and out of the bank, dated today. Once per month; a correction is a reversal.",
        action: "Run payroll",
      }))) return;
      const res = await runPayroll(action.ym);
      if (res.error) { toast({ message: res.error, tone: "bad" }); return; }
      toast({ message: "Ran payroll - payroll / bank" });
      router.refresh();
    })}>{pending ? "Running…" : action.label}</button>
  );
}
