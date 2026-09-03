"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { startProposal } from "@/app/actions";
import { toast } from "@/components/ui/Toast";

/** One click to the house template, filled in and ready to edit. */
export default function StartProposalButton({ quoteId, label = "Start the proposal" }: {
  quoteId: number;
  label?: string;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  return (
    <button className="btn sm accent" disabled={pending} onClick={() => start(async () => {
      const res = await startProposal(quoteId);
      if (res.error) { toast({ message: res.error, tone: "bad" }); return; }
      toast({ message: "Started from the house template" });
      router.refresh();
    })}>
      {pending ? "Starting..." : label}
    </button>
  );
}
