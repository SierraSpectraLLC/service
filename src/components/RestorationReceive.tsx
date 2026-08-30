"use client";

import { useRouter } from "next/navigation";
import { useRef, useState, useTransition } from "react";
import { upload } from "@vercel/blob/client";
import {
  addRestorationPhotos, answerProvenance, attachProvenanceDocs, logRestorationFinding,
  receiveRestorationComponents, removeReceivedComponent,
  revealHandoffCredential, saveHandoffKit, setComponentCondition,
} from "@/app/actions";
import PickOrAdd from "@/components/PickOrAdd";
import CatalogSelect from "@/components/CatalogSelect";
import Dialog, { DialogStatus } from "@/components/ui/Dialog";
import { Pill } from "@/components/ui";
import { toast } from "@/components/ui/Toast";
import {
  ARRIVAL_PHOTO_MIN, CONDITION_GRADES, LICENSE_STATES, PROVENANCE_QUESTIONS,
} from "@/lib/restoration";
import type { ReceiveData } from "@/lib/restorationData";

/**
 * The Receive stage's working surface: component intake through the same
 * add-asset mechanism as everywhere else (catalog type, model with the maker
 * riding along, free-text serial), condition grades, findings that queue
 * restore tasks, arrival photos, the provenance interview, and the handoff
 * kit with its vaulted credential. Read-only once the project has moved on -
 * the record stays visible, the controls go quiet.
 */
export type CatalogModels = Record<string, { name: string; manufacturer: string }[]>;

export default function RestorationReceive({ projectId, data, kinds, models, owners, defaultOwner, canEdit }: {
  projectId: number;
  data: ReceiveData;
  /** The equipment catalog's module types - same source as the add-asset form. */
  kinds: string[];
  /** Each type's models, maker riding along for the auto-fill. */
  models: CatalogModels;
  /** Everyone who already owns something here - the registry's owner list. */
  owners: string[];
  /** Whose company is intaking - the owner field's default, theirs to change. */
  defaultOwner: string;
  canEdit: boolean;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  const act = (fn: () => Promise<{ error?: string } | void>, done?: string) =>
    startTransition(async () => {
      const res = await fn();
      if (res && "error" in res && res.error) { toast({ message: res.error, tone: "bad" }); return; }
      if (done) toast({ message: done });
      router.refresh();
    });

  return (
    <>
      <ComponentsCard projectId={projectId} data={data} kinds={kinds} models={models}
        owners={owners} defaultOwner={defaultOwner} canEdit={canEdit} act={act} pending={pending} />
      <FindingsCard projectId={projectId} data={data} canEdit={canEdit} />
      <PhotosCard projectId={projectId} count={data.photoCount} canEdit={canEdit} />
      <InterviewCard projectId={projectId} data={data} canEdit={canEdit} act={act} pending={pending} />
      <HandoffCard projectId={projectId} kit={data.kit} canEdit={canEdit} />
    </>
  );
}

type Act = (fn: () => Promise<{ error?: string } | void>, done?: string) => void;

type DraftRow = { key: number; kind: string; model: string; manufacturer: string; serial: string; error: string };

function ComponentsCard({ projectId, data, kinds, models, owners, defaultOwner, canEdit, act, pending }: {
  projectId: number; data: ReceiveData; kinds: string[]; models: CatalogModels;
  owners: string[]; defaultOwner: string; canEdit: boolean; act: Act; pending: boolean;
}) {
  const router = useRouter();
  const blank = (key: number): DraftRow => ({ key, kind: "", model: "", manufacturer: "", serial: "", error: "" });
  const [drafts, setDrafts] = useState<DraftRow[]>([]);
  const [nextKey, setNextKey] = useState(1);
  const [owner, setOwner] = useState(defaultOwner);
  const [saving, startSaving] = useTransition();

  const addRow = () => { setDrafts((d) => [...d, blank(nextKey)]); setNextKey((k) => k + 1); };
  const cutRow = (key: number) => setDrafts((d) => d.filter((r) => r.key !== key));
  const patch = (key: number, part: Partial<DraftRow>) =>
    setDrafts((d) => d.map((r) => (r.key === key ? { ...r, ...part, error: "" } : r)));

  // Picking a catalog model brings its maker along; a hand-typed manufacturer
  // is never overwritten. Same rule as the parts intake.
  const pickModel = (key: number, model: string) => {
    setDrafts((d) => d.map((r) => {
      if (r.key !== key) return r;
      const pick = (models[r.kind] ?? []).find((m) => m.name === model);
      return { ...r, model, manufacturer: r.manufacturer.trim() || pick?.manufacturer || "", error: "" };
    }));
  };

  const filled = drafts.filter((r) => r.model.trim() || r.serial.trim());

  const receiveAll = () => {
    if (!filled.length) return;
    startSaving(async () => {
      const res = await receiveRestorationComponents(projectId,
        filled.map((r) => ({ serial: r.serial, kind: r.kind, model: r.model, manufacturer: r.manufacturer, owner })));
      if (res?.error) { toast({ message: res.error, tone: "bad" }); return; }
      const failedIdx = new Map((res.failures ?? []).map((f) => [filled[f.index].key, f.error]));
      // Rows that landed leave the sheet; rows that failed stay, wearing why.
      setDrafts((d) => d.filter((r) => failedIdx.has(r.key) || !(r.model.trim() || r.serial.trim()))
        .map((r) => ({ ...r, error: failedIdx.get(r.key) ?? r.error })));
      if (res.received) toast({ message: `Received ${res.received} component${res.received === 1 ? "" : "s"}` });
      router.refresh();
    });
  };

  return (
    <section className="card">
      <h2 className="card-title">Receive components <span className="eyebrow">what came off the truck</span></h2>

      {data.components.map((c) => (
        <div className="recv-item" key={c.assetId}>
          <div className="rbody">
            <div className="rname">
              {c.model || c.kind}
              {c.manufacturer && <span className="mut"> · {c.manufacturer}</span>}
            </div>
            <div className="rmeta">
              <span className="mono">{c.serial || "no serial"}</span>
              <Pill tone="faint">New to Ridgeline</Pill>
            </div>
            <div className="gchips" role="group" aria-label={`Condition of ${c.model || c.kind}`}>
              {CONDITION_GRADES.map((g) => (
                <button key={g} aria-pressed={c.grade === g} disabled={!canEdit || pending}
                  onClick={() => act(() => setComponentCondition(projectId, c.assetId, c.grade === g ? "" : g))}>
                  {g}
                </button>
              ))}
            </div>
          </div>
          {canEdit && (
            <button className="btn sm" aria-label={`Remove ${c.model || c.kind}`} disabled={pending}
              onClick={() => act(() => removeReceivedComponent(projectId, c.assetId))}>✕</button>
          )}
        </div>
      ))}
      {data.components.length === 0 && (
        <div className="mut t-body" style={{ marginBottom: 8 }}>
          {canEdit ? "Nothing received yet - the record starts with the first box opened." : "No components were received."}
        </div>
      )}

      {canEdit && (
        <>
          {drafts.map((r) => (
            <div className="recv-row" key={r.key}>
              <button className="btn sm rcut" aria-label="Cut this row" onClick={() => cutRow(r.key)}>✕</button>
              <div className="pf2" style={{ marginBottom: 8 }}>
                <div>
                  <label>Type</label>
                  <CatalogSelect value={r.kind} options={kinds} ariaLabel="Component type"
                    onChange={(kind) => patch(r.key, { kind, model: "" })}
                    hint="Define module types in Settings \u2192 Catalog" />
                </div>
                <div>
                  <label>Model</label>
                  <CatalogSelect value={r.model} options={(models[r.kind] ?? []).map((m) => m.name)}
                    ariaLabel="Model" allowNew="+ New model..."
                    onChange={(model) => pickModel(r.key, model)}
                    hint={`No ${r.kind || "?"} models defined yet`} />
                </div>
              </div>
              <div className="pf2">
                <div>
                  <label>Serial #</label>
                  <input className="mono" value={r.serial} placeholder="ISQ7N2009006" aria-label="Serial number"
                    onChange={(e) => patch(r.key, { serial: e.target.value })} />
                </div>
                <div>
                  <label>Manufacturer</label>
                  <input value={r.manufacturer} placeholder="Thermo"
                    onChange={(e) => patch(r.key, { manufacturer: e.target.value })} />
                </div>
              </div>
              {r.error && <div className="recv-row-err">{r.error}</div>}
            </div>
          ))}

          <button className="addrow" onClick={addRow}>+ Add a row</button>

          {drafts.length > 0 && (
            <div className="row al-center sp-2" style={{ marginTop: 12, flexWrap: "wrap" }}>
              <button className="btn accent" disabled={saving || !filled.length} onClick={receiveAll}>
                {saving ? "Receiving\u2026" : `Receive ${filled.length || "the"} component${filled.length === 1 ? "" : "s"}`}
              </button>
              <label className="row al-center sp-1" style={{ margin: 0, fontWeight: 400 }}>
                <span className="mut t-small">Owner</span>
                <span style={{ minWidth: 160 }}>
                  <PickOrAdd value={owner} options={[...new Set([defaultOwner, ...owners])]}
                    newLabel="+ New owner..." placeholder="Owner"
                    onChange={setOwner} />
                </span>
              </label>
              <span className="mut t-small">
                A row needs a model or a serial; a typed serial still matches shelf spares.
              </span>
            </div>
          )}
        </>
      )}
    </section>
  );
}

function FindingsCard({ projectId, data, canEdit }: { projectId: number; data: ReceiveData; canEdit: boolean }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState({ title: "", assetId: 0, severity: "warn", notes: "" });
  const [error, setError] = useState("");
  const [saving, startSaving] = useTransition();

  const problem = !draft.title.trim() ? "say what was found" : null;
  const file = () => {
    if (problem) return;
    startSaving(async () => {
      const res = await logRestorationFinding(projectId, {
        assetId: draft.assetId || null, severity: draft.severity,
        title: draft.title, notes: draft.notes,
      });
      if (res?.error) { setError(res.error); return; }
      toast({ message: "Finding logged - restore task queued" });
      setOpen(false); setDraft({ title: "", assetId: 0, severity: "warn", notes: "" }); setError("");
      router.refresh();
    });
  };

  return (
    <section className="card">
      <h2 className="card-title">Findings</h2>
      {data.findingList.map((f) => (
        <div className="finding" key={f.id}>
          <span className={`fdot ${f.severity === "bad" ? "bad" : "warn"}`} />
          <div className="fbody">
            <div className="ftitle">{f.title}</div>
            <div className="fmeta">
              {f.componentLabel} · logged by {f.createdBy}
              {f.taskState === "Done"
                ? <Pill tone="good">Task done</Pill>
                : f.taskState
                  ? <Pill tone="accent">Task queued — Restore</Pill>
                  : null}
            </div>
          </div>
        </div>
      ))}
      {data.findingList.length === 0 && !canEdit && <div className="mut t-body">Nothing was flagged at receiving.</div>}
      {canEdit && <button className="addrow" onClick={() => { setError(""); setOpen(true); }}>+ Log a finding</button>}
      <Dialog open={open} onClose={() => setOpen(false)} title="Log a finding"
        context="Every finding queues a restore task - nothing observed gets dropped."
        footer={
          <>
            <DialogStatus error={error} problem={problem} ok="Queues a task on the Restore stage." />
            <button className="btn" onClick={() => setOpen(false)} disabled={saving}>Cancel</button>
            <button className="btn accent" onClick={file} disabled={saving || !!problem}>
              {saving ? "Logging..." : "Log finding"}
            </button>
          </>
        }>
        <label>What was found? *</label>
        <input value={draft.title} onChange={(e) => setDraft({ ...draft, title: e.target.value })}
          autoFocus maxLength={160} placeholder="Headspace arm not operating properly" style={{ marginBottom: 8 }} />
        <label>Component</label>
        <select value={draft.assetId || ""} onChange={(e) => setDraft({ ...draft, assetId: parseInt(e.target.value) || 0 })}
          style={{ marginBottom: 8 }}>
          <option value="">The system as a whole</option>
          {data.components.map((c) => (
            <option key={c.assetId} value={c.assetId}>{c.model || c.kind}{c.serial ? ` (SN ${c.serial})` : ""}</option>
          ))}
        </select>
        <label>Severity</label>
        <div className="seg" style={{ marginBottom: 8 }}>
          <button type="button" aria-pressed={draft.severity === "warn"} onClick={() => setDraft({ ...draft, severity: "warn" })}>Worth an eye</button>
          <button type="button" aria-pressed={draft.severity === "bad"} onClick={() => setDraft({ ...draft, severity: "bad" })}>Broken</button>
        </div>
        <label>Notes</label>
        <textarea rows={3} value={draft.notes} onChange={(e) => setDraft({ ...draft, notes: e.target.value })}
          placeholder="What it does, when it started, what was tried" style={{ width: "100%" }} />
      </Dialog>
    </section>
  );
}

function PhotosCard({ projectId, count, canEdit }: { projectId: number; count: number; canEdit: boolean }) {
  const router = useRouter();
  const fileRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");

  const send = async (list: FileList | null) => {
    const files = Array.from(list ?? []);
    if (!files.length) return;
    setError("");
    try {
      const done: { fileName: string; url: string; size: number }[] = [];
      for (const f of files) {
        setBusy(f.name);
        const blob = await upload(f.name, f, { access: "public", handleUploadUrl: "/api/upload" });
        done.push({ fileName: f.name, url: blob.url, size: f.size });
      }
      const res = await addRestorationPhotos(projectId, done);
      if (res?.error) throw new Error(res.error);
      toast({ message: `Added ${done.length} photo${done.length === 1 ? "" : "s"}` });
      router.refresh();
    } catch (e) {
      setError(`${busy || "Upload"}: ${(e as Error).message}`);
    } finally {
      setBusy("");
      if (fileRef.current) fileRef.current.value = "";
    }
  };

  return (
    <section className="card">
      <h2 className="card-title">Arrival photos <span className="eyebrow">as it came off the truck</span></h2>
      <div className="row al-center sp-2 t-body">
        <Pill tone={count >= ARRIVAL_PHOTO_MIN ? "good" : "warn"}>{count} of {ARRIVAL_PHOTO_MIN} minimum</Pill>
      </div>
      {canEdit && (
        <>
          <input ref={fileRef} type="file" accept="image/*" capture="environment" multiple hidden
            onChange={(e) => send(e.target.files)} />
          <button className="addrow" disabled={!!busy} onClick={() => fileRef.current?.click()}>
            {busy ? `Uploading ${busy}…` : "+ Add photos"}
          </button>
          {error && <div className="t-small" style={{ color: "var(--t-bad-fg)", marginTop: 4 }}>{error}</div>}
        </>
      )}
    </section>
  );
}

const SEG_LABELS: Record<string, Record<string, string>> = {
  operational_at_deinstall: { running: "Running", down: "Down", unknown: "Nobody knows" },
  pm_docs: { none: "No docs", unknown: "Unknown" },
  contract_history: { yes: "Yes", no: "No", unknown: "Unknown" },
};

function InterviewCard({ projectId, data, canEdit, act, pending }: {
  projectId: number; data: ReceiveData; canEdit: boolean; act: Act; pending: boolean;
}) {
  const router = useRouter();
  const [pmDate, setPmDate] = useState(data.answers.last_pm_date?.detail ?? "");
  const docsRef = useRef<HTMLInputElement>(null);
  const [docsBusy, setDocsBusy] = useState(false);
  const answerOf = (key: string) => data.answers[key]?.answer ?? "";

  // "Docs on file" is a claim with a file behind it: tapping it opens the
  // picker, and the answer lands together with the attachment.
  const sendDocs = async (list: FileList | null) => {
    const f = list?.[0];
    if (!f) return;
    setDocsBusy(true);
    try {
      const blob = await upload(f.name, f, { access: "public", handleUploadUrl: "/api/upload" });
      const res = await attachProvenanceDocs(projectId, { fileName: f.name, url: blob.url, size: f.size });
      if (res?.error) throw new Error(res.error);
      toast({ message: "Maintenance records attached" });
      router.refresh();
    } catch (e) {
      toast({ message: (e as Error).message, tone: "bad" });
    } finally {
      setDocsBusy(false);
      if (docsRef.current) docsRef.current.value = "";
    }
  };

  return (
    <section className="card">
      <h2 className="card-title">Provenance interview <span className="eyebrow">asked once, travels forever</span></h2>
      {PROVENANCE_QUESTIONS.map((q) => (
        <div className="iv-q" key={q.key}>
          <div className="q">{q.question}</div>
          <div className="iv-row">
            {q.key === "last_pm_date" && (
              <input type="date" value={pmDate} aria-label="Last PM date"
                onChange={(e) => {
                  const v = e.target.value;
                  setPmDate(v);
                  if (v) act(() => answerProvenance(projectId, q.key, "date", v));
                }}
                disabled={!canEdit || pending} style={{ maxWidth: 200 }} />
            )}
            {q.key === "pm_docs" && (
              <>
                <input ref={docsRef} type="file" hidden onChange={(e) => sendDocs(e.target.files)} />
                <div className="seg">
                  <button type="button" aria-pressed={answerOf(q.key) === "docs"}
                    disabled={!canEdit || pending || docsBusy}
                    onClick={() => docsRef.current?.click()}>
                    {docsBusy ? "Uploading\u2026" : "Docs on file"}
                  </button>
                  {q.answers.filter((a) => a !== "docs").map((a) => (
                    <button key={a} type="button" aria-pressed={answerOf(q.key) === a}
                      disabled={!canEdit || pending}
                      onClick={() => act(() => answerProvenance(projectId, q.key, a, ""))}>
                      {SEG_LABELS[q.key]?.[a] ?? a}
                    </button>
                  ))}
                </div>
                {answerOf(q.key) === "docs" && data.answers.pm_docs?.detail && (
                  <span className="mut t-small mono">{data.answers.pm_docs.detail}</span>
                )}
              </>
            )}
            {q.key !== "pm_docs" && (
              <div className="seg">
                {q.answers.filter((a) => q.key !== "last_pm_date" || a === "unknown").map((a) => (
                  <button key={a} type="button" aria-pressed={answerOf(q.key) === a}
                    disabled={!canEdit || pending}
                    onClick={() => { if (q.key === "last_pm_date") setPmDate(""); act(() => answerProvenance(projectId, q.key, a, "")); }}>
                    {SEG_LABELS[q.key]?.[a] ?? (a === "unknown" ? "Unknown" : a)}
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>
      ))}
    </section>
  );
}

// One word per choice so four fit on a phone; N/A is the honest default.
const LICENSE_SHORT: Record<string, string> = { "": "N/A", active: "Active", required: "Required", none: "None" };

function HandoffCard({ projectId, kit, canEdit }: {
  projectId: number; kit: ReceiveData["kit"]; canEdit: boolean;
}) {
  const router = useRouter();
  const [draft, setDraft] = useState({
    softwareNotes: kit?.softwareNotes ?? "",
    licenseStatus: kit?.licenseStatus ?? "",
    utilities: kit?.utilities ?? "",
    credUsername: kit?.credUsername ?? "",
    credSecret: "",
  });
  const [shown, setShown] = useState<string | null>(null);
  const [saving, startSaving] = useTransition();

  const save = () => startSaving(async () => {
    const res = await saveHandoffKit(projectId, draft);
    if (res?.error) { toast({ message: res.error, tone: "bad" }); return; }
    toast({ message: draft.credSecret ? "Handoff kit saved - credential vaulted" : "Handoff kit saved" });
    setDraft({ ...draft, credSecret: "" });
    router.refresh();
  });

  const reveal = () => startSaving(async () => {
    if (shown !== null) { setShown(null); return; }
    const res = await revealHandoffCredential(projectId);
    if (res?.error) { toast({ message: res.error, tone: "bad" }); return; }
    setShown(res.secret ?? "");
  });

  return (
    <section className="card">
      <h2 className="card-title">Handoff kit <span className="eyebrow">what the next owner needs</span></h2>
      <label>Workstation login</label>
      <div className="cred">
        <input type="text" value={draft.credUsername} aria-label="Username" placeholder="Username"
          disabled={!canEdit} style={{ maxWidth: 130 }}
          onChange={(e) => setDraft({ ...draft, credUsername: e.target.value })} />
        {shown !== null
          ? <input type="text" readOnly value={shown} aria-label="Revealed password" />
          : <input type="password" value={draft.credSecret} aria-label="Password"
              placeholder={kit?.hasSecret ? "•••••••• vaulted" : "Password to vault"}
              disabled={!canEdit}
              onChange={(e) => setDraft({ ...draft, credSecret: e.target.value })} />}
        {kit?.hasSecret && (
          <button className="btn sm" onClick={reveal} disabled={saving}>{shown !== null ? "Hide" : "Reveal"}</button>
        )}
      </div>
      <div className="cred-note"><b>Vaulted.</b></div>
      <div style={{ marginTop: 12 }}>
        <label>Acquisition software</label>
        <input value={draft.softwareNotes} disabled={!canEdit}
          placeholder="TraceFinder required — no active license on system"
          onChange={(e) => setDraft({ ...draft, softwareNotes: e.target.value })} />
      </div>
      <div style={{ marginTop: 8 }}>
        <label>License status</label>
        <div className="seg">
          {LICENSE_STATES.map((s) => (
            <button key={s || "na"} type="button" aria-pressed={draft.licenseStatus === s} disabled={!canEdit}
              onClick={() => setDraft({ ...draft, licenseStatus: s })}>
              {LICENSE_SHORT[s]}
            </button>
          ))}
        </div>
      </div>
      <div style={{ marginTop: 8 }}>
        <label>Utilities &amp; site needs</label>
        <input className="mono t-small" value={draft.utilities} disabled={!canEdit}
          placeholder="100–240 V · 50/60 Hz · 50 A max · 6-15 plug · no vent required"
          onChange={(e) => setDraft({ ...draft, utilities: e.target.value })} />
      </div>
      {canEdit && (
        <div className="row sp-2" style={{ marginTop: 12 }}>
          <button className="btn primary" onClick={save} disabled={saving}>
            {saving ? "Saving..." : "Save handoff kit"}
          </button>
        </div>
      )}
    </section>
  );
}
