"use client";

import { useRouter } from "next/navigation";
import { useTransition } from "react";
import { runLedgerParity } from "@/app/money/actions";
import { toast } from "@/components/ui/Toast";

/** "Run now": the same check the hourly cron runs, stored the same way. */
export default function LedgerParityRun({ canRun }: { canRun: boolean }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  if (!canRun) return null;
  return (
    <button className="btn sm" disabled={pending} onClick={() => startTransition(async () => {
      const res = await runLedgerParity();
      if (res.error) { toast({ message: res.error }); return; }
      toast({ message: res.nonzero ? `Ran parity - ${res.nonzero} figure${res.nonzero === 1 ? "" : "s"} differ` : "Ran parity - every figure agrees" });
      router.refresh();
    })}>
      {pending ? "Running…" : "Run now"}
    </button>
  );
}
