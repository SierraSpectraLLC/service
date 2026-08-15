"use client";

import Link from "next/link";
import { useState, useTransition } from "react";
import { openWorkOrder } from "@/app/actions";
import { WO_COLOR, WO_LABEL, WO_SEVERITIES, woLine, woOpen } from "@/lib/workOrders";

export type WorkOrderRow = {
  id: number;
  number: string;
  title: string;
  severity: string;
  state: string;
  assignee: string;
  openedOn: string;
  /** Who asked, already resolved to a company name. */
  askedBy: string;
  tasks: number;
  done: number;
};

/**
 * The jobs on this record: what has been asked for, what is being done about it,
 * and what was done about the ones that are finished.
 *
 * Deliberately a list of links rather than an expandable thing. A work order has
 * its own tasks, hours, files and close-out; that is a page, and cramming it into
 * a panel on a page that already has six of them would make both unreadable.
 *
 * Finished orders fold away. A system serviced for three years has hundreds, and
 * the question this panel answers is "what is outstanding" - the archive is one
 * click below it for the day somebody asks what happened in March.
 */
export default function WorkOrdersPanel({ target, orders, today, canEdit }: {
  target: { instrumentId: number | null; assetId: number | null };
  orders: WorkOrderRow[];
  today: string;
  canEdit: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [severity, setSeverity] = useState("Degraded");
  const [error, setError] = useState("");
  const [pending, startTransition] = useTransition();

  const live = orders.filter((o) => woOpen(o.state) || o.state === "resolved");
  const filed = orders.filter((o) => !live.includes(o));

  const file = () => {
    if (!title.trim()) { setError("Say briefly what the job is"); return; }
    setError("");
    startTransition(async () => {
      const res = await openWorkOrder(target, { title, body, severity });
      if (res?.error) { setError(res.error); return; }
      setOpen(false); setTitle(""); setBody(""); setSeverity("Degraded");
    });
  };

  const row = (o: WorkOrderRow) => {
    const color = WO_COLOR[o.state] ?? WO_COLOR.open;
    return (
      <Link key={o.id} href={`/work/${o.id}`} className="row-hover"
        style={{
          display: "flex", alignItems: "baseline", gap: 8, flexWrap: "wrap",
          padding: "7px 4px", borderTop: "1px solid var(--line)",
          textDecoration: "none", color: "inherit",
        }}>
        <span className="mono" style={{ fontWeight: 700, fontSize: 12, color: "var(--navy)" }}>{o.number}</span>
        <span style={{ fontSize: 13, flex: "1 1 160px" }}>{o.title}</span>
        <span className="pill" style={{ background: color.bg, color: color.fg }}>{WO_LABEL[o.state] ?? o.state}</span>
        <span className="mut" style={{ fontSize: 11, width: "100%" }}>
          {woLine(o, today, { tasks: o.tasks, done: o.done })}
          {o.askedBy ? ` · asked by ${o.askedBy}` : ""}
        </span>
      </Link>
    );
  };

  return (
    <div className="card">
      <div style={{ display: "flex", alignItems: "baseline", gap: 8, marginBottom: 4 }}>
        <div className="card-title">Work orders</div>
        {canEdit && (
          <button className="btn sm primary" style={{ marginLeft: "auto" }}
            onClick={() => { setOpen(!open); setError(""); }}>
            {open ? "Cancel" : "Open one"}
          </button>
        )}
      </div>

      {open && (
        <div className="dash-form" style={{ marginBottom: 8 }}>
          <label>What is the job? *</label>
          <input value={title} onChange={(e) => setTitle(e.target.value)} autoFocus maxLength={160}
            placeholder="Lamp won't ignite" style={{ marginBottom: 8 }} />
          <label>Anything else</label>
          <textarea value={body} onChange={(e) => setBody(e.target.value)} rows={3}
            placeholder="Error code, when it started, what was running" style={{ width: "100%", marginBottom: 8 }} />
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 8 }}>
            {WO_SEVERITIES.map((s) => (
              <button key={s.key} type="button" onClick={() => setSeverity(s.key)}
                className={severity === s.key ? "btn sm accent" : "btn sm"}
                title={s.hint} style={{ flex: "1 1 90px" }}>{s.label}</button>
            ))}
          </div>
          <button className="btn sm accent" onClick={file} disabled={pending || !title.trim()}>
            {pending ? "Opening..." : "Open work order"}
          </button>
          {error && <div style={{ fontSize: 12, color: "#A32D2D", marginTop: 8 }}>{error}</div>}
        </div>
      )}
      {!open && error && <div style={{ fontSize: 12, color: "#A32D2D", marginBottom: 8 }}>{error}</div>}

      {live.map(row)}
      {live.length === 0 && (
        <div className="mut" style={{ fontSize: 12.5 }}>
          Nothing outstanding{filed.length ? ` - ${filed.length} finished` : ""}.
        </div>
      )}

      {filed.length > 0 && (
        <details style={{ borderTop: "1px solid var(--line)", marginTop: live.length ? 0 : 8 }}>
          <summary style={{ cursor: "pointer", padding: "8px 4px", fontSize: 12.5 }}>
            <b>Finished</b> <span className="mut">· {filed.length}</span>
          </summary>
          {filed.map(row)}
        </details>
      )}
    </div>
  );
}
