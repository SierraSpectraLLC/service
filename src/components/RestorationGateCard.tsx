"use client";

import { useRouter } from "next/navigation";
import { useOptimistic, useState, useTransition } from "react";
import { advanceRestorationStage, confirmRestorationGateItem } from "@/app/actions";
import { toast } from "@/components/ui/Toast";
import type { GateItem } from "@/lib/restoration";

/**
 * The "Ready to advance?" card: the current stage's gate, and the button out.
 *
 * The marks here are a courtesy - the advance action re-evaluates the whole
 * gate server-side, so a stale page can never talk a project through a gate
 * it no longer passes. Confirm rows are the human half and toggle through
 * their own action, which stamps who and when.
 */
export default function RestorationGateCard({ projectId, items, advanceLabel }: {
  projectId: number;
  items: GateItem[];
  /** "Advance to Restore", "Mark shipped - Commission", ... */
  advanceLabel: string;
}) {
  const router = useRouter();
  const [error, setError] = useState("");
  const [pending, startTransition] = useTransition();
  // The checkbox flips now and the server catches up - or puts it back.
  const [shown, flip] = useOptimistic(items, (cur: GateItem[], flipped: string) =>
    cur.map((i) => (i.key === flipped ? { ...i, ok: !i.ok } : i)));

  const toggle = (item: GateItem) => {
    setError("");
    startTransition(async () => {
      flip(item.key);
      const res = await confirmRestorationGateItem(projectId, item.key, !item.ok);
      if (res?.error) { setError(res.error); return; }
      router.refresh();
    });
  };

  const advance = () => {
    setError("");
    startTransition(async () => {
      const res = await advanceRestorationStage(projectId);
      if (res?.error) { setError(res.error); return; }
      toast({ message: "Stage advanced - the ledger has it" });
      // Back to the canonical view of the new stage, not a stale ?s=.
      router.push(`/restorations/${projectId}`);
      router.refresh();
    });
  };

  const ready = shown.every((i) => i.ok);

  return (
    <section className="card">
      <h2 className="card-title">Ready to advance?</h2>
      {shown.map((i) =>
        i.kind === "system" ? (
          <div className="gate-item" key={i.key}>
            <span className={`gate-mark ${i.ok ? "ok" : "wait"}`}>{i.ok ? "✓" : "…"}</span>
            {i.label}
            <span className="gate-src">system</span>
          </div>
        ) : (
          <div className="gate-item" key={i.key}>
            <label>
              <input type="checkbox" checked={i.ok} disabled={pending} onChange={() => toggle(i)} />
              {i.label}
            </label>
            <span className="gate-src">confirm</span>
          </div>
        ),
      )}
      <div className="row al-center sp-2" style={{ marginTop: 12 }}>
        <button className="btn accent" onClick={advance} disabled={pending || !ready}>
          {pending ? "Working..." : advanceLabel}
        </button>
        {error && <span className="t-small" style={{ color: "var(--t-bad-fg)" }}>{error}</span>}
      </div>
    </section>
  );
}
