"use client";

import { useRouter } from "next/navigation";
import { useTransition } from "react";
import { confirmDialog } from "@/components/ui/ConfirmDialog";
import { toast } from "@/components/ui/Toast";
import { sendQuote } from "@/app/actions";

/** Sending is the only thing the shop does to a quote; the client does the rest. */
export default function QuoteActions({ id, number, status }: {
  id: number; number: string; status: string;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  if (status !== "draft") return null;

  const send = async () => {
    const ok = await confirmDialog({
      title: `Send ${number}?`,
      body: "Emails the client a link to approve or decline.",
      action: "Send quote",
    });
    if (!ok) return;
    startTransition(async () => {
      const res = await sendQuote(id);
      if (res.error) { toast({ message: res.error, tone: "bad" }); return; }
      toast({ message: res.warning || `Sent ${number}`, ...(res.warning ? { tone: "bad" as const } : {}) });
      router.refresh();
    });
  };

  return <button className="btn sm accent" disabled={pending} onClick={send}>Send quote</button>;
}
