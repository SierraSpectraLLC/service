"use client";

import { useRouter } from "next/navigation";
import { useMemo, useState, useTransition } from "react";
import { openWorkOrder } from "@/app/actions";
import Dialog, { DialogStatus } from "@/components/ui/Dialog";
import { toast } from "@/components/ui/Toast";
import { WO_SEVERITIES } from "@/lib/workOrders";

export type JobClient = { id: number; name: string };
export type JobSystem = {
  id: number;
  externalId: string;
  label: string;
  /** Whose system it is. Null = the shop's own bench. */
  ownerOrgId: number | null;
};

/**
 * A work order from nothing, on the queue page - because that is where
 * somebody is standing when the phone rings.
 *
 * The two pickers are deliberately independent, and either one can lead. Name
 * the system and the client follows from it, because a system's owner is not a
 * choice anybody should be able to get wrong. Name only the client and the job
 * is theirs without a system at all: the move, the site survey, the call that
 * arrives before anybody knows which instrument it is about. That job gets its
 * own page, its own tasks, hours and expenses, and can be pointed at a system
 * later - see the work order's own page.
 */
export default function NewWorkOrderButton({ clients, systems, people = [], canPickHouse }: {
  clients: JobClient[];
  systems: JobSystem[];
  people?: string[];
  /** Staff may open a job on nobody - the shop's own work. */
  canPickHouse: boolean;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [orgId, setOrgId] = useState(0);
  const [systemId, setSystemId] = useState(0);
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [severity, setSeverity] = useState("Degraded");
  const [assignee, setAssignee] = useState("");
  const [error, setError] = useState("");
  const [pending, startTransition] = useTransition();

  const nameOf = (id: number) => clients.find((c) => c.id === id)?.name ?? "";
  // A client's own systems, and the shop's own bench - a refurb on our floor
  // is still a job we may be doing for somebody. Another client's systems are
  // never offered; the server refuses them too.
  const theirs = useMemo(
    () => systems.filter((s) => !orgId || s.ownerOrgId === orgId || s.ownerOrgId === null),
    [systems, orgId],
  );
  const mine = theirs.filter((s) => s.ownerOrgId !== null);
  const bench = theirs.filter((s) => s.ownerOrgId === null);

  const chosen = systems.find((s) => s.id === systemId) ?? null;
  const problem = !title.trim() ? "say briefly what the job is"
    : !orgId && !systemId && !canPickHouse ? "pick the client this job is for"
    : null;

  // Picking a system settles whose job it is; picking a client drops a system
  // that is not theirs, so the pair can never disagree on the way in.
  const pickSystem = (id: number) => {
    setSystemId(id);
    const s = systems.find((x) => x.id === id);
    if (s?.ownerOrgId) setOrgId(s.ownerOrgId);
  };
  const pickClient = (id: number) => {
    setOrgId(id);
    const s = systems.find((x) => x.id === systemId);
    if (s && s.ownerOrgId !== null && s.ownerOrgId !== id) setSystemId(0);
  };

  const reset = () => {
    setOrgId(0); setSystemId(0); setTitle(""); setBody("");
    setSeverity("Degraded"); setAssignee(""); setError("");
  };

  const file = () => {
    if (problem) return;
    setError("");
    startTransition(async () => {
      const res = await openWorkOrder(
        { instrumentId: systemId || null, assetId: null, orgId: orgId || null },
        { title, body, severity, assignee },
      );
      if (res?.error || !res?.id) { setError(res?.error ?? "That didn't save"); return; }
      // Both of these ride the answer rather than refusing the job: the
      // instrument is down either way, and a client who cannot hear it is a
      // client nobody warned.
      if (res.hold) toast({ message: `${res.number} opened on credit hold`, tone: "bad" });
      else toast({ message: `Opened ${res.number}${assignee ? ` for ${assignee}` : ""}` });
      // The entitlement note is not toasted: the job's own page draws it in
      // amber and keeps it there, which is where it is still true a minute
      // from now.
      setOpen(false); reset();
      router.push(`/work/${res.id}`);
    });
  };

  const where = chosen ? `${chosen.externalId}${chosen.label ? ` · ${chosen.label}` : ""}`
    : orgId ? `${nameOf(orgId)} · no specific system`
    : "";

  return (
    <>
      <button className="btn sm primary" onClick={() => { reset(); setOpen(true); }}>
        ＋ Work order
      </button>
      <Dialog open={open} onClose={() => setOpen(false)} title="Open a work order"
        context={where || "A job on a client, a system, or both."}
        footer={
          <>
            <DialogStatus error={error} problem={problem} ok="Ready to open." />
            <button className="btn" onClick={() => setOpen(false)} disabled={pending}>Cancel</button>
            <button className="btn accent" onClick={file} disabled={pending || !!problem}>
              {pending ? "Opening..." : assignee ? `Open & dispatch to ${assignee}` : "Open work order"}
            </button>
          </>
        }>
        <div className="dialog-section">Who it is for</div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 8 }}>
          <div style={{ flex: "1 1 180px" }}>
            <label>Client</label>
            <select value={orgId || ""} aria-label="Client"
              onChange={(e) => pickClient(parseInt(e.target.value) || 0)}>
              <option value="">{canPickHouse ? "Our own work - no client" : "Pick the client"}</option>
              {clients.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </div>
          <div style={{ flex: "1 1 180px" }}>
            <label>System</label>
            <select value={systemId || ""} aria-label="System"
              onChange={(e) => pickSystem(parseInt(e.target.value) || 0)}>
              <option value="">No specific system</option>
              {mine.length > 0 && (
                <optgroup label={orgId ? `${nameOf(orgId)}'s systems` : "On the board"}>
                  {mine.map((s) => (
                    <option key={s.id} value={s.id}>{s.externalId}{s.label ? ` - ${s.label}` : ""}</option>
                  ))}
                </optgroup>
              )}
              {bench.length > 0 && (
                <optgroup label="Our own bench">
                  {bench.map((s) => (
                    <option key={s.id} value={s.id}>{s.externalId}{s.label ? ` - ${s.label}` : ""}</option>
                  ))}
                </optgroup>
              )}
            </select>
          </div>
        </div>
        <div className="mut t-meta" style={{ marginBottom: 8 }}>
          {chosen && chosen.ownerOrgId
            ? `Filed as ${nameOf(chosen.ownerOrgId)}'s job, because the system is theirs.`
            : systemId
              ? "On our own bench. The client above, if any, is who the work is for."
              : orgId
                ? "No system yet - a move, a survey, a call. You can point it at one later."
                : "Neither yet: this files as the shop's own job."}
        </div>

        <div className="dialog-section">The job</div>
        <label>What is the job? *</label>
        <input value={title} onChange={(e) => setTitle(e.target.value)} autoFocus maxLength={160}
          placeholder="Move the Quattro micro to the new lab" style={{ marginBottom: 8 }} />
        <label>Anything else</label>
        <textarea value={body} onChange={(e) => setBody(e.target.value)} rows={3}
          placeholder="Who called, what they said, when it started" style={{ width: "100%", marginBottom: 8 }} />

        <div className="dialog-section">How urgent</div>
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 8 }}>
          {WO_SEVERITIES.map((s) => (
            <button key={s.key} type="button" onClick={() => setSeverity(s.key)}
              className={severity === s.key ? "btn sm accent" : "btn sm"}
              title={s.hint} style={{ flex: "1 1 90px" }}>{s.label}</button>
          ))}
        </div>

        {people.length > 0 && (
          <>
            <div className="dialog-section">Who takes it</div>
            <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
              <label style={{ margin: 0 }}>Dispatch to</label>
              <select value={assignee} onChange={(e) => setAssignee(e.target.value)}
                aria-label="Dispatch to" className="t-body" style={{ width: "auto" }}>
                <option value="">Decide later</option>
                {people.map((x) => <option key={x} value={x}>{x}</option>)}
              </select>
              {assignee && <span className="mut t-meta">{assignee} gets notified the moment it files.</span>}
            </div>
          </>
        )}
      </Dialog>
    </>
  );
}
