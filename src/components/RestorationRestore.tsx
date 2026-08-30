"use client";

import { useRouter } from "next/navigation";
import { useRef, useState, useTransition } from "react";
import { upload } from "@vercel/blob/client";
import {
  addRestorationPart, addRestorationTask, attachOutsideWorkReport,
  logOutsideWork, setTaskState,
} from "@/app/actions";
import Dialog, { DialogStatus } from "@/components/ui/Dialog";
import { Pill } from "@/components/ui";
import { toast } from "@/components/ui/Toast";
import type { RestoreStageData } from "@/lib/restorationData";

const TASK_TONE: Record<string, "neutral" | "info" | "warn" | "good"> = {
  Open: "neutral", "In progress": "info", Blocked: "warn", Done: "good",
};

/** The Restore stage: the task list findings queued (plus hand-made ones),
 * parts used, and outside work - documented or it didn't happen. */
export default function RestorationRestore({ projectId, data, canEdit }: {
  projectId: number;
  data: RestoreStageData;
  canEdit: boolean;
}) {
  return (
    <>
      <TasksCard projectId={projectId} data={data} canEdit={canEdit} />
      <PartsCard projectId={projectId} data={data} canEdit={canEdit} />
      <OutsideCard projectId={projectId} data={data} canEdit={canEdit} />
    </>
  );
}

function TasksCard({ projectId, data, canEdit }: { projectId: number; data: RestoreStageData; canEdit: boolean }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState({ title: "", body: "" });
  const [error, setError] = useState("");
  const [pending, startTransition] = useTransition();

  const flip = (id: number, state: string) => startTransition(async () => {
    const res = await setTaskState(id, state === "Done" ? "Open" : "Done");
    if (res?.error) { toast({ message: res.error, tone: "bad" }); return; }
    router.refresh();
  });

  const file = () => {
    if (!draft.title.trim()) return;
    startTransition(async () => {
      const res = await addRestorationTask(projectId, draft);
      if (res?.error) { setError(res.error); return; }
      setOpen(false); setDraft({ title: "", body: "" });
      router.refresh();
    });
  };

  return (
    <section className="card">
      <h2 className="card-title">Restore tasks <span className="eyebrow">from receiving findings + plan</span></h2>
      {data.taskList.map((t) => (
        <div className="finding" key={t.id}>
          <span className={`fdot ${t.state === "Done" ? "good" : t.severity === "bad" ? "bad" : "warn"}`} />
          <div className="fbody">
            <div className="ftitle">{t.title}</div>
            <div className="fmeta">
              {t.componentLabel}
              {t.assignee.trim() ? ` · ${t.assignee}` : ""}
              {t.findingId !== null ? ` · from finding #${t.findingId}` : ""}
              {" "}<Pill tone={TASK_TONE[t.state] ?? "neutral"}>{t.state}</Pill>
            </div>
          </div>
          {canEdit && (
            <button className="btn sm" disabled={pending} onClick={() => flip(t.id, t.state)}>
              {t.state === "Done" ? "Reopen" : "Done"}
            </button>
          )}
        </div>
      ))}
      {data.taskList.length === 0 && <div className="mut t-body">Nothing queued - a clean receiving, or one nobody has read yet.</div>}
      {canEdit && <button className="addrow" onClick={() => { setError(""); setOpen(true); }}>+ Add task</button>}
      <Dialog open={open} onClose={() => setOpen(false)} title="Add a restore task"
        footer={
          <>
            <DialogStatus error={error} problem={!draft.title.trim() ? "say what the task is" : null} ok="Joins this project's list." />
            <button className="btn" onClick={() => setOpen(false)} disabled={pending}>Cancel</button>
            <button className="btn accent" onClick={file} disabled={pending || !draft.title.trim()}>Add task</button>
          </>
        }>
        <label>Task *</label>
        <input value={draft.title} autoFocus maxLength={160}
          placeholder="Full PM — source clean, filament, septa, liner, pump oil"
          onChange={(e) => setDraft({ ...draft, title: e.target.value })} style={{ marginBottom: 8 }} />
        <label>Notes</label>
        <textarea rows={3} value={draft.body} onChange={(e) => setDraft({ ...draft, body: e.target.value })}
          style={{ width: "100%" }} />
      </Dialog>
    </section>
  );
}

const money = (cents: number) => `$${(cents / 100).toFixed(2)}`;

function PartsCard({ projectId, data, canEdit }: { projectId: number; data: RestoreStageData; canEdit: boolean }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState({ name: "", partNumber: "", qty: "1", vendor: "", cost: "" });
  const [error, setError] = useState("");
  const [pending, startTransition] = useTransition();

  const file = () => {
    if (!draft.name.trim()) return;
    startTransition(async () => {
      const res = await addRestorationPart(projectId, {
        name: draft.name, partNumber: draft.partNumber, qty: draft.qty, vendor: draft.vendor,
        costCents: Math.round(parseFloat(draft.cost || "0") * 100) || 0,
      });
      if (res?.error) { setError(res.error); return; }
      setOpen(false); setDraft({ name: "", partNumber: "", qty: "1", vendor: "", cost: "" });
      router.refresh();
    });
  };

  const total = data.partList.reduce((n, x) => n + x.costCents, 0);

  return (
    <section className="card">
      <h2 className="card-title">Parts used <span className="eyebrow">flows to cost & the record</span></h2>
      {data.partList.length > 0 && (
        <div style={{ overflowX: "auto" }}>
          <table className="t-body" style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr>{["Part", "PN", "Qty", "Source", "Cost"].map((h) => (
                <th key={h} className="t-meta mut" style={{ textAlign: "left", padding: 4, borderBottom: "1px solid var(--line)" }}>{h}</th>
              ))}</tr>
            </thead>
            <tbody>
              {data.partList.map((x) => (
                <tr key={x.id}>
                  <td style={{ padding: 8, borderBottom: "1px solid var(--bg)" }}>{x.name}</td>
                  <td className="mono t-small" style={{ padding: 8, borderBottom: "1px solid var(--bg)" }}>{x.partNumber || "—"}</td>
                  <td style={{ padding: 8, borderBottom: "1px solid var(--bg)" }}>{x.qty}</td>
                  <td style={{ padding: 8, borderBottom: "1px solid var(--bg)" }}>{x.vendor || "Stock"}</td>
                  <td className="mono" style={{ padding: 8, borderBottom: "1px solid var(--bg)" }}>{x.costCents ? money(x.costCents) : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {data.partList.length > 0 && total > 0 && (
        <div className="mut t-small" style={{ marginTop: 4 }}>Parts cost to date: <b className="mono">{money(total)}</b></div>
      )}
      {data.partList.length === 0 && !canEdit && <div className="mut t-body">No parts were logged.</div>}
      {canEdit && <button className="addrow" onClick={() => { setError(""); setOpen(true); }}>+ Add part — PN, source, cost</button>}
      <Dialog open={open} onClose={() => setOpen(false)} title="Log a part"
        footer={
          <>
            <DialogStatus error={error} problem={!draft.name.trim() ? "name the part" : null} ok="Flows to cost and the record." />
            <button className="btn" onClick={() => setOpen(false)} disabled={pending}>Cancel</button>
            <button className="btn accent" onClick={file} disabled={pending || !draft.name.trim()}>Log part</button>
          </>
        }>
        <label>Part *</label>
        <input value={draft.name} autoFocus placeholder="Electron multiplier"
          onChange={(e) => setDraft({ ...draft, name: e.target.value })} style={{ marginBottom: 8 }} />
        <div className="pf2">
          <div>
            <label>Part number</label>
            <input className="mono" value={draft.partNumber} placeholder="WE023950"
              onChange={(e) => setDraft({ ...draft, partNumber: e.target.value })} />
          </div>
          <div>
            <label>Qty</label>
            <input value={draft.qty} onChange={(e) => setDraft({ ...draft, qty: e.target.value })} />
          </div>
        </div>
        <div className="pf2" style={{ marginTop: 8 }}>
          <div>
            <label>Source</label>
            <input value={draft.vendor} placeholder="Stock, or the vendor"
              onChange={(e) => setDraft({ ...draft, vendor: e.target.value })} />
          </div>
          <div>
            <label>Cost ($)</label>
            <input className="mono" inputMode="decimal" value={draft.cost} placeholder="685.00"
              onChange={(e) => setDraft({ ...draft, cost: e.target.value })} />
          </div>
        </div>
      </Dialog>
    </section>
  );
}

function OutsideCard({ projectId, data, canEdit }: { projectId: number; data: RestoreStageData; canEdit: boolean }) {
  const router = useRouter();
  const fileRef = useRef<HTMLInputElement>(null);
  const [attachFor, setAttachFor] = useState(0);
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState({ vendor: "", rmaNumber: "", description: "", cost: "" });
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [pending, startTransition] = useTransition();

  const file = () => {
    if (!draft.vendor.trim()) return;
    startTransition(async () => {
      const res = await logOutsideWork(projectId, {
        vendor: draft.vendor, rmaNumber: draft.rmaNumber, description: draft.description,
        costCents: Math.round(parseFloat(draft.cost || "0") * 100) || 0,
      });
      if (res?.error) { setError(res.error); return; }
      setOpen(false); setDraft({ vendor: "", rmaNumber: "", description: "", cost: "" });
      router.refresh();
    });
  };

  const sendReport = async (list: FileList | null) => {
    const f = list?.[0];
    if (!f || !attachFor) return;
    setBusy(true);
    try {
      const blob = await upload(f.name, f, { access: "public", handleUploadUrl: "/api/upload" });
      const res = await attachOutsideWorkReport(attachFor, { fileName: f.name, url: blob.url, size: f.size });
      if (res?.error) throw new Error(res.error);
      toast({ message: "Report attached" });
      router.refresh();
    } catch (e) {
      toast({ message: (e as Error).message, tone: "bad" });
    } finally {
      setBusy(false); setAttachFor(0);
      if (fileRef.current) fileRef.current.value = "";
    }
  };

  return (
    <section className="card">
      <h2 className="card-title">Outside work <span className="eyebrow">3rd-party, documented or it didn&apos;t happen</span></h2>
      {data.outside.map((o) => (
        <div className="finding" key={o.id}>
          <span className={`fdot ${o.documented ? "good" : "warn"}`} />
          <div className="fbody">
            <div className="ftitle">{o.description || "Outside work"} — {o.vendor}</div>
            <div className="fmeta">
              {o.rmaNumber ? `RMA ${o.rmaNumber} · ` : ""}
              {o.costCents ? `${money(o.costCents)} · ` : ""}
              {o.documented
                ? <Pill tone="good">Docs on file</Pill>
                : <Pill tone="warn">Report missing</Pill>}
            </div>
          </div>
          {canEdit && !o.documented && (
            <button className="btn sm" disabled={busy}
              onClick={() => { setAttachFor(o.id); fileRef.current?.click(); }}>
              {busy && attachFor === o.id ? "Uploading…" : "Attach report"}
            </button>
          )}
        </div>
      ))}
      {data.outside.length === 0 && <div className="mut t-body">Nothing sent out{canEdit ? " - yet" : ""}.</div>}
      {canEdit && (
        <>
          <input ref={fileRef} type="file" hidden onChange={(e) => sendReport(e.target.files)} />
          <button className="addrow" onClick={() => { setError(""); setOpen(true); }}>+ Log outside work — vendor, RMA, attach report</button>
        </>
      )}
      <Dialog open={open} onClose={() => setOpen(false)} title="Log outside work"
        footer={
          <>
            <DialogStatus error={error} problem={!draft.vendor.trim() ? "name the vendor" : null}
              ok="Logs as undocumented until the report attaches." />
            <button className="btn" onClick={() => setOpen(false)} disabled={pending}>Cancel</button>
            <button className="btn accent" onClick={file} disabled={pending || !draft.vendor.trim()}>Log it</button>
          </>
        }>
        <label>Vendor *</label>
        <input value={draft.vendor} autoFocus placeholder="MotionRepair Co."
          onChange={(e) => setDraft({ ...draft, vendor: e.target.value })} style={{ marginBottom: 8 }} />
        <div className="pf2">
          <div>
            <label>RMA number</label>
            <input className="mono" value={draft.rmaNumber} placeholder="MR-2231"
              onChange={(e) => setDraft({ ...draft, rmaNumber: e.target.value })} />
          </div>
          <div>
            <label>Cost ($)</label>
            <input className="mono" inputMode="decimal" value={draft.cost}
              onChange={(e) => setDraft({ ...draft, cost: e.target.value })} />
          </div>
        </div>
        <div style={{ marginTop: 8 }}>
          <label>What was done</label>
          <input value={draft.description} placeholder="Headspace arm drive rebuild"
            onChange={(e) => setDraft({ ...draft, description: e.target.value })} />
        </div>
      </Dialog>
    </section>
  );
}
