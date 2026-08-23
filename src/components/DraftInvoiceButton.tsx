"use client";

import { useRouter } from "next/navigation";
import { useTransition } from "react";
import { toast } from "@/components/ui/Toast";
import { draftInvoice } from "@/app/actions";

/**
 * Compose the bill for a finished job and open it.
 *
 * The button never carries the numbers: it names the work order and the server
 * builds the lines from the rows. A page that has been sitting open since
 * Tuesday therefore cannot invoice Tuesday's prices.
 */
export default function DraftInvoiceButton({ workOrderId, number, label = "Draft invoice" }: {
  workOrderId: number;
  number: string;
  label?: string;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  return (
    <button
      className="btn sm accent"
      disabled={pending}
      onClick={() => startTransition(async () => {
        const res = await draftInvoice(workOrderId);
        if (res.error) { toast({ message: res.error, tone: "bad" }); return; }
        toast({ message: `Drafted the invoice for ${number}` });
        if (res.id) router.push(`/money/invoices/${res.id}`);
      })}
    >
      {pending ? "Drafting..." : label}
    </button>
  );
}
