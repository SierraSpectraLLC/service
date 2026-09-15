"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { setCashOpening } from "@/app/money/actions";
import { toast } from "@/components/ui/Toast";

/**
 * "What is in the bank today?" - the one number the money side has to be
 * told. Inline on the overview rather than in settings, because the page
 * that shows the figure is where somebody notices it is missing or wrong.
 *
 * `compact` is the re-entry form under a figure that already exists: a link
 * that opens the same two fields, for correcting drift.
 */
export default function CashOpeningForm({ today, compact = false, canSet }: {
  today: string;
  compact?: boolean;
  /** Owner only. Anybody else reads the figure or the reason it is missing. */
  canSet: boolean;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(!compact);
  const [draft, setDraft] = useState({ amount: "", on: today });
  const [error, setError] = useState("");
  const [pending, startTransition] = useTransition();

  if (!canSet) {
    return compact ? null : (
      <div className="mut t-small">The owner tells it what is in the bank; it carries the figure forward from there.</div>
    );
  }
  if (!open) {
    return (
      <button className="btn link t-meta" onClick={() => setOpen(true)} style={{ padding: 0 }}>
        Correct it - enter today&apos;s balance
      </button>
    );
  }

  const save = () => startTransition(async () => {
    setError("");
    const res = await setCashOpening(draft);
    if (res.error) { setError(res.error); return; }
    toast({ message: `Bank balance set as of ${draft.on}` });
    setOpen(!compact);
    router.refresh();
  });

  return (
    <div>
      <div className="row-2" style={{ alignItems: "flex-end", flexWrap: "wrap", gap: 8 }}>
        <label className="t-meta" style={{ display: "grid", gap: 4 }}>
          In the bank ($)
          <input className="t-body" value={draft.amount} inputMode="decimal" placeholder="24,310.00"
            style={{ width: 130 }} autoFocus={!compact}
            onChange={(e) => setDraft({ ...draft, amount: e.target.value })}
            onKeyDown={(e) => { if (e.key === "Enter") save(); }} />
        </label>
        <label className="t-meta" style={{ display: "grid", gap: 4 }}>
          As of
          <input className="t-body" type="date" value={draft.on} max={today} style={{ width: "auto" }}
            onChange={(e) => setDraft({ ...draft, on: e.target.value })} />
        </label>
        <button className="btn sm accent" disabled={pending || !draft.amount.trim()} onClick={save}>
          {pending ? "Saving..." : "Set it"}
        </button>
        {compact && (
          <button className="btn sm" disabled={pending} onClick={() => setOpen(false)}>Cancel</button>
        )}
      </div>
      {error && <div className="t-small" style={{ color: "var(--t-bad-fg)", marginTop: 6 }}>{error}</div>}
    </div>
  );
}
