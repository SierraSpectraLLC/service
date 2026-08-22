"use client";

import Link from "next/link";
import { useState, useTransition } from "react";
import { setPoWorkOrder } from "@/app/actions";
import { toast } from "@/components/ui/Toast";

export type JobOption = { id: number; number: string; title: string; place: string };

/**
 * What this order was bought FOR.
 *
 * Purchasing could only ever answer "what did we buy and where did it go on the
 * shelf". "Why did we buy it" was unrecorded, which is why a client's parts
 * allowance could never be defended with a receipt: the spend was on their
 * system and the paperwork was on our shelf, with nothing joining them.
 *
 * Filing an order against a job also changes what receiving does - the part
 * lands on the client's system rather than only in the room - so the copy says
 * that plainly rather than letting somebody discover it.
 */
export default function PoJobCard({ poId, workOrder, options, canManage }: {
  poId: number;
  /** The job it is already against, if any. */
  workOrder: JobOption | null;
  /** Open jobs this order could be filed against. */
  options: JobOption[];
  canManage: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState("");
  const [pending, startTransition] = useTransition();

  const pick = (value: string) => {
    setError("");
    startTransition(async () => {
      const res = await setPoWorkOrder(poId, value === "" ? null : parseInt(value));
      if (res?.error) { setError(res.error); return; }
      toast({ message: value === "" ? "Filed the order as stock" : "Filed the order against the job" });
      setEditing(false);
    });
  };

  return (
    <div className="card">
      <div className="row-2" style={{ alignItems: "baseline", marginBottom: 4 }}>
        <div className="card-title">Bought for</div>
        {canManage && (
          <button className="btn sm" style={{ marginLeft: "auto" }}
            onClick={() => { setEditing(!editing); setError(""); }}>
            {editing ? "Cancel" : workOrder ? "Change" : "File against a job"}
          </button>
        )}
      </div>

      {workOrder ? (
        <>
          <Link href={`/work/${workOrder.id}`} style={{ textDecoration: "none", color: "inherit" }}>
            <span className="mono t-small" style={{ fontWeight: 700, color: "var(--navy)" }}>
              {workOrder.number}
            </span>
            <span className="t-body" style={{ marginLeft: 8 }}>{workOrder.title}</span>
          </Link>
          <div className="mut t-small" style={{ marginTop: 2 }}>{workOrder.place}</div>
          <div className="mut t-small" style={{ marginTop: 6 }}>
            Receiving a line puts the part on that system as well as on the shelf, and the
            receipt filed here shows on the job.
          </div>
        </>
      ) : (
        <div className="mut t-small">
          Stock. Nothing on this order is against a particular job, so receiving it only
          puts it on the shelf.
        </div>
      )}

      {editing && (
        <div style={{ marginTop: 8 }}>
          <select value={workOrder ? String(workOrder.id) : ""} disabled={pending}
            onChange={(e) => pick(e.target.value)} aria-label="Work order">
            <option value="">Stock - not for a particular job</option>
            {options.map((o) => (
              <option key={o.id} value={String(o.id)}>{o.number} · {o.title} · {o.place}</option>
            ))}
          </select>
          {options.length === 0 && (
            <div className="mut t-meta" style={{ marginTop: 4 }}>
              No open work orders you can reach.
            </div>
          )}
        </div>
      )}
      {error && <div className="t-small" style={{ color: "var(--t-bad-fg)", marginTop: 6 }}>{error}</div>}
    </div>
  );
}
