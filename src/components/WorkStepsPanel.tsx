"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { openWorkSteps } from "@/app/actions";
import { toast } from "@/components/ui/Toast";
import { Id, Pill } from "@/components/ui";
import type { Tone } from "@/lib/tones";
import { MOVE_STEPS, STEP_KINDS } from "@/lib/workOrders";

export type WorkStep = {
  id: number;
  number: string;
  title: string;
  kindLabel: string;
  stateLabel: string;
  tone: Tone;
  assignee: string;
  /** Its issued service reports, newest first - the paper this step owes. */
  reports: { id: number; number: string; issuedOn: string }[];
};

/**
 * The steps a job is made of - a move's pre-move validation, the move, and the
 * post-move OQ - each its own work order with its own report.
 *
 * The rows link to the steps, where the work is done and the report issued;
 * the newest report on each is one click from here, because the binder for
 * the whole job is what somebody is assembling when they open this.
 */
export default function WorkStepsPanel({ parentId, parentNumber, steps, canAdd, people }: {
  parentId: number;
  parentNumber: string;
  steps: WorkStep[];
  /** The service team, on a job still taking work. */
  canAdd: boolean;
  people: string[];
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [adding, setAdding] = useState(false);
  const [kind, setKind] = useState("other");
  const [title, setTitle] = useState("");
  const [assignee, setAssignee] = useState("");

  const run = (list: { title: string; kind: string; assignee?: string }[], done: string) =>
    startTransition(async () => {
      const res = await openWorkSteps(parentId, list);
      if (res.error) { toast({ message: res.error, tone: "bad" }); return; }
      toast({ message: done });
      setAdding(false); setTitle(""); setKind("other"); setAssignee("");
      router.refresh();
    });

  const pickKind = (k: string) => {
    // Picking a kind fills in a title only while nothing has been typed - a
    // title somebody wrote is never overwritten by a dropdown.
    const was = STEP_KINDS.find((x) => x.key === kind)?.label ?? "";
    if (!title.trim() || title === was) setTitle(k === "other" ? "" : STEP_KINDS.find((x) => x.key === k)?.label ?? "");
    setKind(k);
  };

  return (
    <div className="card">
      <div className="card-title">
        Steps{steps.length ? ` · ${steps.filter((x) => x.stateLabel === "Resolved" || x.stateLabel === "Closed").length}/${steps.length} done` : ""}
      </div>
      {steps.length === 0 ? (
        <div className="mut t-small">
          Break this job into steps when it takes more than one visit - each step gets its own
          number ({parentNumber}-1, -2...), its own tasks and hours, and its own service report.
        </div>
      ) : steps.map((s) => (
        <div key={s.id} className="row-2"
          style={{ alignItems: "baseline", padding: "6px 0", borderTop: "1px solid var(--line)", flexWrap: "wrap" }}>
          <Link href={`/work/${s.id}`} style={{ textDecoration: "none" }}><Id>{s.number}</Id></Link>
          <Link href={`/work/${s.id}`} className="t-body" style={{ fontWeight: 600, textDecoration: "none", color: "inherit", flex: 1, minWidth: 140 }}>
            {s.title}
          </Link>
          <span className="mut t-meta">{s.kindLabel}{s.assignee ? ` · ${s.assignee}` : " · unassigned"}</span>
          <Pill tone={s.tone}>{s.stateLabel}</Pill>
          {s.reports[0] ? (
            <a className="btn sm" style={{ textDecoration: "none" }} download
              href={`/api/doc/service-report/${s.reports[0].id}`}
              title={`Issued ${s.reports[0].issuedOn}${s.reports.length > 1 ? ` - ${s.reports.length} reports on this step` : ""}`}>
              {s.reports[0].number} PDF
            </a>
          ) : (
            <span className="mut t-meta">no report yet</span>
          )}
        </div>
      ))}

      {canAdd && (
        <div style={{ marginTop: 12, display: "flex", gap: 8, flexWrap: "wrap" }}>
          {steps.length === 0 && (
            <button className="btn sm accent" disabled={pending}
              title={MOVE_STEPS.map((m) => m.title).join(" → ")}
              onClick={() => run(MOVE_STEPS, `Added ${MOVE_STEPS.length} move steps to ${parentNumber}`)}>
              ＋ Move steps: validation, move, OQ
            </button>
          )}
          {!adding && (
            <button className="btn sm" disabled={pending} onClick={() => setAdding(true)}>＋ Step</button>
          )}
        </div>
      )}

      {canAdd && adding && (
        <div style={{ marginTop: 12, display: "flex", gap: 8, flexWrap: "wrap", alignItems: "flex-end" }}>
          <div style={{ flex: "0 1 180px" }}>
            <label>Kind</label>
            <select value={kind} onChange={(e) => pickKind(e.target.value)} aria-label="Kind of step">
              {STEP_KINDS.map((k) => <option key={k.key} value={k.key}>{k.label}</option>)}
            </select>
          </div>
          <div style={{ flex: "1 1 200px" }}>
            <label>What is the step? *</label>
            <input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={160} autoFocus
              placeholder="Post-move OQ" aria-label="Step title" />
          </div>
          {people.length > 0 && (
            <div style={{ flex: "0 1 160px" }}>
              <label>Dispatch to</label>
              <select value={assignee} onChange={(e) => setAssignee(e.target.value)} aria-label="Dispatch to">
                <option value="">Decide later</option>
                {people.map((x) => <option key={x} value={x}>{x}</option>)}
              </select>
            </div>
          )}
          <button className="btn sm accent" disabled={pending || !title.trim()}
            onClick={() => run([{ title, kind, assignee }], `Added a step to ${parentNumber}`)}>
            {pending ? "Adding..." : "Add step"}
          </button>
          <button className="btn sm" disabled={pending} onClick={() => setAdding(false)}>Cancel</button>
        </div>
      )}
    </div>
  );
}
