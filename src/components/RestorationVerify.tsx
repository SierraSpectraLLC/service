"use client";

import { useRouter } from "next/navigation";
import { useRef, useState, useTransition } from "react";
import { upload } from "@vercel/blob/client";
import { attachWipeCert, markPcBackup, recordCheckoutVerdict } from "@/app/actions";
import { Pill } from "@/components/ui";
import { toast } from "@/components/ui/Toast";
import RestorationChecklistCard from "@/components/RestorationChecklistCard";
import { fmtWhen } from "@/lib/when";
import type { VerifyStageData, VerdictView } from "@/lib/restorationData";

/** The Verify stage: bench setup, the checkout verdict, and data hygiene. */
export default function RestorationVerify({ projectId, data, canEdit }: {
  projectId: number;
  data: VerifyStageData;
  canEdit: boolean;
}) {
  return (
    <>
      <RestorationChecklistCard projectId={projectId} stage="verify_setup"
        title="Bench setup" eyebrow="everything talks before anything proves"
        data={data.bench} canEdit={canEdit} />
      <VerdictCard projectId={projectId} phase="verify" verdict={data.verdict} canEdit={canEdit}
        title="Instrument checkout" eyebrow="the tunecheck verdict attaches here" />
      <HygieneCard projectId={projectId} data={data} canEdit={canEdit} />
    </>
  );
}

/**
 * The verdict block - shared by Verify (bench) and Commission (on-site).
 * Manual entry is the v1 path and says so on the record; when the tunecheck
 * service is wired in, parsed verdicts land in the same block with the
 * metric grid filled.
 */
export function VerdictCard({ projectId, phase, verdict, canEdit, title, eyebrow }: {
  projectId: number;
  phase: "verify" | "commission";
  verdict: VerdictView;
  canEdit: boolean;
  title: string;
  eyebrow: string;
}) {
  const router = useRouter();
  const fileRef = useRef<HTMLInputElement>(null);
  const [entering, setEntering] = useState(false);
  const [draft, setDraft] = useState({ verdict: "pass", summary: "" });
  const [report, setReport] = useState<{ fileName: string; url: string; size: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const [pending, startTransition] = useTransition();

  const pick = async (list: FileList | null) => {
    const f = list?.[0];
    if (!f) return;
    setBusy(true);
    try {
      const blob = await upload(f.name, f, { access: "public", handleUploadUrl: "/api/upload" });
      setReport({ fileName: f.name, url: blob.url, size: f.size });
    } catch (e) {
      toast({ message: (e as Error).message, tone: "bad" });
    } finally {
      setBusy(false);
    }
  };

  const record = () => startTransition(async () => {
    const res = await recordCheckoutVerdict(projectId, { phase, ...draft }, report ?? undefined);
    if (res?.error) { toast({ message: res.error, tone: "bad" }); return; }
    toast({ message: `${draft.verdict.toUpperCase()} recorded` });
    setEntering(false); setReport(null); setDraft({ verdict: "pass", summary: "" });
    router.refresh();
  });

  return (
    <section className="card">
      <h2 className="card-title">{title} <span className="eyebrow">{eyebrow}</span></h2>
      {verdict && !entering ? (
        <>
          <div className={`verdict${verdict.verdict === "fail" ? " fail" : ""}`}>
            <span className="v">{verdict.verdict.toUpperCase()}</span>
            <span className="vd">
              {verdict.summary || (phase === "verify" ? "Bench checkout" : "On-site checkout")}
              {" · "}{fmtWhen(verdict.recordedAt)}
              {" · "}{verdict.source === "parsed" ? "parsed by tunecheck" : "entered manually"}
              {verdict.hasReport ? " · report on file" : " · no report file"}
            </span>
            {canEdit && (
              <button className="btn sm" style={{ marginLeft: "auto" }} onClick={() => setEntering(true)}>
                Re-record
              </button>
            )}
          </div>
          {verdict.metrics.length > 0 && (
            <div className="metric-grid">
              {verdict.metrics.map((m) => (
                <div className="metric" key={m.name}>
                  <div className="mn">{m.name}</div>
                  <div className="mv">{m.value} <Pill tone={m.ok ? "good" : "bad"}>{m.ok ? "OK" : "OUT"}</Pill></div>
                </div>
              ))}
            </div>
          )}
        </>
      ) : canEdit ? (
        <>
          {!verdict && !entering && (
            <div className="mut t-body" style={{ marginBottom: 8 }}>
              No verdict on file. Attach the tune report and record the outcome -
              parsing arrives with the tunecheck integration; until then the
              entry is flagged manual.
            </div>
          )}
          {(entering || !verdict) && (
            <>
              <div className="row al-center sp-2" style={{ marginBottom: 8 }}>
                <div className="seg">
                  <button type="button" aria-pressed={draft.verdict === "pass"} onClick={() => setDraft({ ...draft, verdict: "pass" })}>PASS</button>
                  <button type="button" aria-pressed={draft.verdict === "fail"} onClick={() => setDraft({ ...draft, verdict: "fail" })}>FAIL</button>
                </div>
                <input value={draft.summary} placeholder="EI tune · full gauge set on file"
                  onChange={(e) => setDraft({ ...draft, summary: e.target.value })}
                  style={{ flex: "1 1 220px" }} />
              </div>
              <div className="row al-center sp-2">
                <input ref={fileRef} type="file" accept="application/pdf,image/*" hidden onChange={(e) => pick(e.target.files)} />
                <button className="btn sm" disabled={busy} onClick={() => fileRef.current?.click()}>
                  {busy ? "Uploading…" : report ? `Report: ${report.fileName}` : "Attach tune report"}
                </button>
                <button className="btn accent" disabled={pending} onClick={record}>
                  {pending ? "Recording…" : "Record verdict"}
                </button>
                {entering && verdict && <button className="btn" onClick={() => setEntering(false)}>Cancel</button>}
              </div>
            </>
          )}
        </>
      ) : (
        <div className="mut t-body">No verdict was recorded at this stage.</div>
      )}
    </section>
  );
}

function HygieneCard({ projectId, data, canEdit }: { projectId: number; data: VerifyStageData; canEdit: boolean }) {
  const router = useRouter();
  const fileRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [pending, startTransition] = useTransition();

  const toggleBackup = () => startTransition(async () => {
    const res = await markPcBackup(projectId, data.pcBackupAt === null);
    if (res?.error) { toast({ message: res.error, tone: "bad" }); return; }
    router.refresh();
  });

  const sendCert = async (list: FileList | null) => {
    const f = list?.[0];
    if (!f) return;
    setBusy(true);
    try {
      const blob = await upload(f.name, f, { access: "public", handleUploadUrl: "/api/upload" });
      const res = await attachWipeCert(projectId, { fileName: f.name, url: blob.url, size: f.size });
      if (res?.error) throw new Error(res.error);
      toast({ message: "Wipe certificate on file" });
      router.refresh();
    } catch (e) {
      toast({ message: (e as Error).message, tone: "bad" });
    } finally {
      setBusy(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  };

  return (
    <section className="card">
      <h2 className="card-title">Data hygiene <span className="eyebrow">the part lawyers ask about</span></h2>
      <div className="gate-item">
        {data.pcBackupAt !== null
          ? <Pill tone="good">Imaged {fmtWhen(data.pcBackupAt)}</Pill>
          : <Pill tone="warn">Not imaged</Pill>}
        Instrument PC backup
        {canEdit && (
          <button className="btn sm" style={{ marginLeft: "auto" }} disabled={pending} onClick={toggleBackup}>
            {data.pcBackupAt !== null ? "Clear" : "Mark imaged"}
          </button>
        )}
      </div>
      <div className="gate-item">
        {data.wipeCertOnFile
          ? <Pill tone="good">Certificate on file</Pill>
          : <Pill tone="warn">Wipe pending</Pill>}
        Prior-owner data wipe
        {canEdit && !data.wipeCertOnFile && (
          <>
            <input ref={fileRef} type="file" hidden onChange={(e) => sendCert(e.target.files)} />
            <button className="btn sm" style={{ marginLeft: "auto" }} disabled={busy}
              onClick={() => fileRef.current?.click()}>
              {busy ? "Uploading…" : "Attach wipe certificate"}
            </button>
          </>
        )}
      </div>
    </section>
  );
}
