"use client";

import { useState, useTransition } from "react";
import { upload } from "@vercel/blob/client";
import { confirmSheetDraft, submitSheetScan } from "@/app/actions";
import DocScanner from "@/components/DocScanner";
import { toast } from "@/components/ui/Toast";
import { byUncertainty, combHasInk, readMarks, type Mark } from "@/lib/custody/marks";
import type { SheetLayout, SheetRowSpec } from "@/lib/custody/sheetLayout";

type Row = SheetRowSpec & { checklist: string };
type StepField = { state?: "done" | "skip" | "na"; reading?: string; condition?: string; reason?: string; lot?: string };

/**
 * The sheet comes back: photograph it, the browser flattens it (lib/scanDoc)
 * and reads the tick boxes off the flat page (lib/custody/marks), the photo is
 * stored, and the person who wrote on it confirms - uncertain boxes first,
 * readings typed by hand next to a crop of the comb they wrote in. No model
 * guesses at handwriting; a wrong tick here is a tap, a wrong digit on the
 * chain is forever.
 */
export default function SheetScan({ token, rows, layout, instrumentLabel, status }: {
  token: string; rows: Row[]; layout: SheetLayout; instrumentLabel: string; status: string;
}) {
  const [stage, setStage] = useState<"pick" | "scan" | "reading" | "confirm" | "done">(status === "confirmed" ? "done" : "pick");
  const [file, setFile] = useState<File | undefined>();
  const [marks, setMarks] = useState<Mark[]>([]);
  const [combInk, setCombInk] = useState<Record<string, boolean>>({});
  const [crops, setCrops] = useState<Record<string, string>>({});
  const [draftId, setDraftId] = useState<number | null>(null);
  const [fields, setFields] = useState<Record<string, StepField>>({});
  const [findings, setFindings] = useState("");
  const [privateNotes, setPrivateNotes] = useState("");
  const [technician, setTechnician] = useState("");
  const [error, setError] = useState("");
  const [pending, startTransition] = useTransition();

  const byKey = new Map(rows.map((r) => [r.key, r]));

  /** The flat page as a File from DocScanner: read it, crop it, store it. */
  const onScanned = async (scanned: File) => {
    setStage("reading"); setError("");
    try {
      const img = await fileToImage(scanned);
      const canvas = document.createElement("canvas");
      canvas.width = img.naturalWidth; canvas.height = img.naturalHeight;
      const ctx = canvas.getContext("2d")!;
      ctx.drawImage(img, 0, 0);
      const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
      const read = readMarks(data, canvas.width, canvas.height, layout);
      const ink: Record<string, boolean> = {}, cropUrls: Record<string, string> = {};
      for (const rl of layout.rows) {
        if (!rl.comb.length) continue;
        ink[rl.key] = combHasInk(data, canvas.width, canvas.height, rl.comb);
        const first = rl.comb[0], last = rl.comb[rl.comb.length - 1];
        const x = first.x * canvas.width, y = first.y * canvas.height;
        const w = (last.x + last.w - first.x) * canvas.width, h = first.h * canvas.height;
        const c = document.createElement("canvas"); c.width = Math.round(w); c.height = Math.round(h);
        c.getContext("2d")!.drawImage(canvas, x, y, w, h, 0, 0, c.width, c.height);
        cropUrls[rl.key] = c.toDataURL("image/png");
      }
      setMarks(read); setCombInk(ink); setCrops(cropUrls);
      let stored: { fileName: string; url: string; size: number } | null = null;
      try {
        const blob = await upload(scanned.name, scanned, { access: "public", handleUploadUrl: "/api/upload" });
        stored = { fileName: scanned.name, url: blob.url, size: scanned.size };
      } catch {
        // No storage in this environment: the marks still file, the page does not.
        stored = null;
      }
      const res = await submitSheetScan(token, read, stored);
      if (res.error || !res.draftId) { setError(res.error ?? "Could not save the scan"); setStage("pick"); return; }
      setDraftId(res.draftId);
      setStage("confirm");
    } catch (e) {
      setError((e as Error).message || "Could not read the page"); setStage("pick");
    }
  };

  const setField = (key: string, patch: StepField) => setFields((f) => ({ ...f, [key]: { ...f[key], ...patch } }));
  const stateOf = (m: Mark) => fields[m.key]?.state ?? m.state;
  const problems = [
    ...marks.filter((m) => stateOf(m) === "skip" && !(fields[m.key]?.reason ?? "").trim()).map((m) => `${byKey.get(m.key)?.title ?? m.key}: say why it was skipped`),
    ...(technician.trim().length < 2 ? ["Type the technician's name"] : []),
  ];

  if (stage === "done") {
    return <div className="card"><div className="card-title">Filed</div><div className="mut t-body">This sheet has been filed on {instrumentLabel}&apos;s record. Nothing more to do with it.</div></div>;
  }
  if (stage === "scan" || (stage === "pick" && file)) {
    return <DocScanner file={file} title="Flatten the sheet" onDone={onScanned} onCancel={() => { setFile(undefined); setStage("pick"); }} />;
  }
  if (stage === "reading") return <div className="card mut t-body">Reading the boxes...</div>;

  if (stage === "confirm") {
    const ordered = byUncertainty(marks);
    return (
      <div className="card">
        <div className="card-title">Confirm what the sheet says</div>
        <div className="mut t-small" style={{ marginBottom: 8 }}>
          Uncertain boxes first. The reader ticked what it could; you are the one looking at the paper, so your tap wins. Type readings exactly as written.
        </div>
        {ordered.map((m) => {
          const r = byKey.get(m.key);
          const st = stateOf(m);
          const unsure = m.confidence < 0.5;
          return (
            <div key={m.key} className="field" style={{ borderTop: "1px solid var(--line)", paddingTop: 8 }}>
              <div style={{ display: "flex", gap: 8, alignItems: "baseline", flexWrap: "wrap" }}>
                <b className="t-body">{r?.title ?? m.key}</b>
                {unsure && <span className="pill warn">{m.state ? "check this box" : "no clear mark"}</span>}
                <span className="mut t-meta">{m.key}</span>
              </div>
              <div style={{ display: "flex", gap: 4, marginTop: 4 }}>
                {(["done", "skip", "na"] as const).map((k) => (
                  <button key={k} type="button" className={`btn sm${st === k ? " accent" : ""}`} onClick={() => setField(m.key, { state: k })}>
                    {k === "na" ? "N/A" : k[0].toUpperCase() + k.slice(1)}
                  </button>
                ))}
                {st && <button type="button" className="btn sm" onClick={() => setField(m.key, { state: undefined })} title="Leave this step out">Clear</button>}
              </div>
              {st === "skip" && (
                <input value={fields[m.key]?.reason ?? ""} onChange={(e) => setField(m.key, { reason: e.target.value })}
                  placeholder="Why it was skipped - travels with the machine" className="t-small" style={{ marginTop: 4 }} />
              )}
              {r?.reading && (
                <div style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 4, flexWrap: "wrap" }}>
                  {crops[m.key] && <img src={crops[m.key]} alt="What you wrote" style={{ height: 32, border: "1px solid var(--line)", borderRadius: 4 }} />}
                  <input value={fields[m.key]?.reading ?? ""} onChange={(e) => setField(m.key, { reading: e.target.value })}
                    placeholder={combInk[m.key] ? "Type the reading you wrote" : "Reading (blank on the sheet)"} className="t-small mono" style={{ width: 160 }} />
                  {r.unit && <span className="mut t-meta">{r.unit}</span>}
                </div>
              )}
              {r?.partNumber && (
                <input value={fields[m.key]?.lot ?? ""} onChange={(e) => setField(m.key, { lot: e.target.value })}
                  placeholder={`Lot for ${r.partNumber} (stays private)`} className="t-small" style={{ marginTop: 4, width: 220 }} />
              )}
            </div>
          );
        })}
        <div className="field"><label>Findings <span className="field-opt">(travels)</span></label>
          <textarea value={findings} onChange={(e) => setFindings(e.target.value)} rows={3} placeholder="As written in the Findings box - for whoever holds the machine next." style={{ width: "100%" }} /></div>
        <div className="field"><label>Private notes <span className="field-opt">(stays)</span></label>
          <textarea value={privateNotes} onChange={(e) => setPrivateNotes(e.target.value)} rows={2} style={{ width: "100%" }} /></div>
        <div className="field"><label>Technician *</label>
          <input value={technician} onChange={(e) => setTechnician(e.target.value)} placeholder="As signed on the sheet" style={{ width: 260 }} /></div>
        {(error || problems.length > 0) && <div className="field-err">{error || problems[0]}</div>}
        <button className="btn primary" disabled={pending || problems.length > 0 || draftId === null}
          onClick={() => startTransition(async () => {
            setError("");
            const res = await confirmSheetDraft(draftId!, { steps: fields, findings, privateNotes, technician });
            if (res.error) { setError(res.error); return; }
            toast({ message: "Filed as a procedure run" });
            setStage("done");
          })}>
          {pending ? "Filing..." : "File it"}
        </button>
      </div>
    );
  }

  return (
    <div className="card">
      <div className="card-title">File this sheet</div>
      <div className="mut t-body" style={{ marginBottom: 8 }}>
        {instrumentLabel}. Photograph the filled first page flat and well lit; the corners are found for you.
      </div>
      <input type="file" accept="image/*" capture="environment" onChange={(e) => { const f = e.target.files?.[0]; if (f) { setFile(f); setStage("scan"); } }} />
      <button className="btn" style={{ marginLeft: 8 }} onClick={() => setStage("scan")}>Use the camera</button>
      {error && <div className="field-err">{error}</div>}
    </div>
  );
}

function fileToImage(file: File): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("Not an image")); };
    img.src = url;
  });
}
