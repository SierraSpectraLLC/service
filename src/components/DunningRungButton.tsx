"use client";

import { useRouter } from "next/navigation";
import { useTransition } from "react";
import { confirmDialog } from "@/components/ui/ConfirmDialog";
import { toast } from "@/components/ui/Toast";
import { sendDunningRung } from "@/app/actions";

/**
 * Climb one rung by hand. The same action the cron calls, so a reminder sent
 * on purpose and one sent on schedule are the same row on the record - which
 * is what makes the demand letter's "we have since sent 3 reminders" true.
 */
export default function DunningRungButton({ invoiceId, number, action }: {
  invoiceId: number;
  number: string;
  action: string;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  const run = async () => {
    const ok = await confirmDialog({
      title: action + "?",
      context: number,
      body: "It threads under the original send, quotes only what is undisputed, and writes the rung to the record.",
      action: "Send now",
    });
    if (!ok) return;
    startTransition(async () => {
      const res = await sendDunningRung(invoiceId);
      if (res.error) { toast({ message: res.error, tone: "bad" }); return; }
      toast({ message: `Sent the ${res.rung} rung on ${number}` });
      router.refresh();
    });
  };

  return (
    <button className="btn sm accent" disabled={pending} onClick={run}>
      Send now
    </button>
  );
}
