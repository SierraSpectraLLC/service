"use client";

import { useRouter } from "next/navigation";
import { useTransition } from "react";
import { backfillJournal } from "@/app/money/actions";
import { confirmDialog } from "@/components/ui/ConfirmDialog";
import { toast } from "@/components/ui/Toast";

/** Posts what the documents say and the journal has not seen. Safe to press twice. */
export default function BackfillJournalButton() {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  return (
    <button className="btn sm accent" disabled={pending} onClick={async () => {
      const ok = await confirmDialog({
        title: "Backfill the journal?",
        body: "Every invoice, payment, fee, claim, bill cycle and order the documents record gets its entry, dated the day it happened. Nothing already posted is posted again.",
        action: "Backfill",
      });
      if (!ok) return;
      startTransition(async () => {
        const res = await backfillJournal();
        if (res.error) { toast({ message: res.error, tone: "bad" }); return; }
        toast({ message: `Posted ${res.created} entr${res.created === 1 ? "y" : "ies"}; ${res.existing} were already there${res.skipped ? `; ${res.skipped} skipped` : ""}` });
        router.refresh();
      });
    }}>
      {pending ? "Backfilling..." : "Backfill the journal"}
    </button>
  );
}
