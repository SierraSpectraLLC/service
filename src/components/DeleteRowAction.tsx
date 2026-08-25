"use client";

import { useRouter } from "next/navigation";
import { useTransition } from "react";
import { deleteInvoice, deletePurchaseOrder, deleteQuote } from "@/app/actions";
import { confirmReason } from "@/components/ui/ConfirmDialog";
import { toast } from "@/components/ui/Toast";
import RowActions from "@/components/ui/RowActions";

/**
 * Delete, from the list rather than from the record.
 *
 * The record pages have carried this for a while, which was fine for the
 * record somebody was already reading and useless for the four test orders
 * they want gone. Opening each one to destroy it is the kind of friction that
 * ends with somebody leaving the junk in the list and learning to read past
 * it - and a list nobody trusts is worse than a list with a delete on it.
 *
 * Same guard as the record page, because it is the same action: an owner, a
 * written reason, and an audit line that keeps both. Everything about what may
 * be deleted is decided on the server - a purchase order with goods received
 * against it is refused there, and the refusal comes back as the error.
 */
export default function DeleteRowAction({ kind, id, number, what, note }: {
  kind: "invoice" | "quote" | "po";
  id: number;
  number: string;
  /** What this row is, in the confirm's own words: "the order", "this quote". */
  what: string;
  /** The consequence worth naming before they type a reason. */
  note?: string;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  const run = async () => {
    const why = await confirmReason({
      title: `Delete ${number}?`,
      body: note,
      action: `Delete ${what}`, cancel: "Keep it", tone: "bad",
    });
    if (!why) return;
    startTransition(async () => {
      const res = kind === "invoice" ? await deleteInvoice(id, why)
        : kind === "quote" ? await deleteQuote(id, why)
        : await deletePurchaseOrder(id, why);
      if (res?.error) { toast({ message: res.error, tone: "bad" }); return; }
      toast({ message: `Deleted ${number}` });
      router.refresh();
    });
  };

  return (
    <RowActions
      menuLabel={`Actions for ${number}`}
      items={[{ label: pending ? "Deleting..." : "Delete", onClick: run, tone: "bad" }]}
    />
  );
}
