"use client";

import Link from "next/link";
import { useState, useTransition } from "react";
import { setPoWorkOrder } from "@/app/actions";

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
      setEditing(false);
    });
  };

  return (
    <div className="card">
      <div style={{ display: "flex", alignItems: "baseline", gap: 8, marginBottom: 4 }}>
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
            <span className="mono" style={{ fontWeight: 700, fontSize: 12, color: "var(--navy)" }}>
              {workOrder.number}
            </span>
            <span style={{ fontSize: 13, marginLeft: 8 }}>{workOrder.title}</span>
          </Link>
          <div className="mut" style={{ fontSize: 11.5, marginTop: 2 }}>{workOrder.place}</div>
          <div className="mut" style={{ fontSize: 11.5, marginTop: 6 }}>
            Receiving a line puts the part on that system as well as on the shelf, and the
            receipt filed here shows on the job.
          </div>
        </>
      ) : (
        <div className="mut" style={{ fontSize: 12.5 }}>
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
            <div className="mut" style={{ fontSize: 11, marginTop: 4 }}>
              No open work orders you can reach.
            </div>
          )}
        </div>
      )}
      {error && <div style={{ fontSize: 12, color: "#A32D2D", marginTop: 6 }}>{error}</div>}
    </div>
  );
}
