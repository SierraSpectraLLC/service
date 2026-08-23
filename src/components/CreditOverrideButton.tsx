"use client";

import { useRouter } from "next/navigation";
import { useTransition } from "react";
import { confirmDialog, confirmReason } from "@/components/ui/ConfirmDialog";
import { toast } from "@/components/ui/Toast";
import { formatCents } from "@/lib/money";
import { overrideCreditHold, requestDeposit } from "@/app/actions";

/**
 * The two ways a held account gets moving: ask for enough to clear it, or
 * decide to work anyway.
 *
 * The reason is demanded by the ACTION, not by this button - the same rule the
 * blocked-reason on a stage change follows. This only makes the reason easy to
 * give; a check that lives in the UI alone is a check that is not there.
 */
export default function CreditOverrideButton({ orgId, orgName, overridden, canOverride, depositCents }: {
  orgId: number;
  orgName: string;
  overridden: boolean;
  /** Owner only. Anybody on the bench may ask for the deposit. */
  canOverride: boolean;
  /** What would clear the hold. Zero hides the ask. */
  depositCents: number;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  const run = async () => {
    const why = await confirmReason({
      title: `Work for ${orgName} anyway?`,
      body: "New jobs stop opening on hold until this is lifted. Say why - the reason is the record, and it is what somebody asks about later.",
      action: "Override the hold",
    });
    if (!why) return;
    startTransition(async () => {
      const res = await overrideCreditHold(orgId, { reason: why, untilOn: "" });
      if (res.error) { toast({ message: res.error, tone: "bad" }); return; }
      toast({ message: `Overrode the hold on ${orgName}` });
      router.refresh();
    });
  };

  const ask = async () => {
    const ok = await confirmDialog({
      title: `Ask ${orgName} for ${formatCents(depositCents)}?`,
      body: "It raises a real invoice due on receipt, because \"pay us this and we will come out\" is "
        + "only an agreement once there is something to pay against. It does NOT lift the hold - "
        + "recording the payment does that by arithmetic, and lifting it early is what the override is for.",
      action: "Raise the deposit",
    });
    if (!ok) return;
    startTransition(async () => {
      const res = await requestDeposit(orgId, "");
      if (res.error) { toast({ message: res.error, tone: "bad" }); return; }
      toast({ message: `Raised a ${formatCents(depositCents)} deposit for ${orgName}` });
      if (res.id) router.push(`/money/invoices/${res.id}`);
    });
  };

  return (
    <>
      {depositCents > 0 && (
        <button className="btn sm" disabled={pending} onClick={ask}>
          Request {formatCents(depositCents)} to clear
        </button>
      )}
      {!overridden && canOverride && (
        <button className="btn sm" disabled={pending} onClick={run}>
          Override - owner, reason required
        </button>
      )}
    </>
  );
}
