"use client";

import { useRouter } from "next/navigation";
import { useTransition } from "react";
import { confirmReason } from "@/components/ui/ConfirmDialog";
import { toast } from "@/components/ui/Toast";
import { overrideCreditHold } from "@/app/actions";

/**
 * The owner deciding to work for somebody who owes money.
 *
 * The reason is demanded by the ACTION, not by this button - the same rule the
 * blocked-reason on a stage change follows. This only makes the reason easy to
 * give; a check that lives in the UI alone is a check that is not there.
 */
export default function CreditOverrideButton({ orgId, orgName, overridden }: {
  orgId: number;
  orgName: string;
  overridden: boolean;
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

  if (overridden) return null;
  return (
    <button className="btn sm" disabled={pending} onClick={run}>
      Override - owner, reason required
    </button>
  );
}
