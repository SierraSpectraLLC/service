"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import type { WorkTarget } from "@/app/actions";

type PdfFile = { id: number; fileName: string; kind: string };

type Row = { id: number; fileName: string; title: string; included: boolean };

const titleFrom = (fileName: string) => fileName.replace(/\.pdf$/i, "").replace(/[-_]+/g, " ").trim();

/**
 * Combine this record's PDF reports into one packet: pick, order, retitle,
 * then download it or file it back as an attachment. Validation evidence
 * usually leaves here as a binder, not as nine loose files - this makes the
 * binder without a trip through desktop Acrobat.
 */
export default function PdfCombiner({ target, pdfs, defaultCover, coverLines }: {
  target: WorkTarget;
  pdfs: PdfFile[];
  /** Prefill for the cover headline, e.g. "SS-1042 validation packet". */
  defaultCover: string;
  coverLines: string[];
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [rows, setRows] = useState<Row[]>([]);
  const [cover, setCover] = useState(defaultCover);
  const [withCover, setWithCover] = useState(true);
  const [numbers, setNumbers] = useState(true);
  const [headers, setHeaders] = useState(true);
  const [busy, setBusy] = useState<"" | "download" | "save">("");
  const [error, setError] = useState("");
  const [savedName, setSavedName] = useState("");

  const openIt = () => {
    setRows(pdfs.map((p) => ({ id: p.id, fileName: p.fileName, title: titleFrom(p.fileName), included: true })));
    setError(""); setSavedName(""); setOpen(true);
  };

  const included = rows.filter((r) => r.included);

  const move = (ix: number, dir: -1 | 1) =>
    setRows((rs) => {
      const next = [...rs];
      const j = ix + dir;
      if (j < 0 || j >= next.length) return rs;
      [next[ix], next[j]] = [next[j], next[ix]];
      return next;
    });

  const run = async (mode: "download" | "save") => {
    if (!included.length) { setError("Tick at least one PDF"); return; }
    setBusy(mode); setError(""); setSavedName("");
    try {
      const payload = {
        items: included.map((r) => ({ attachmentId: r.id, title: r.title })),
        coverTitle: withCover ? cover : "",
        coverLines,
        pageNumbers: numbers,
        headers,
        saveAs: mode === "save"
          ? { fileName: `${(cover || "combined").replace(/[^\w\- ]/g, "").slice(0, 60) || "combined"}.pdf`, ...target }
          : null,
      };
      const res = await fetch("/api/pdf/combine", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => null);
        throw new Error(j?.error ?? `Combine failed (${res.status})`);
      }
      if (mode === "save") {
        const j = await res.json();
        setSavedName(payload.saveAs!.fileName);
        if (j.saved) router.refresh(); // the new attachment appears in Files
      } else {
        // Stream the packet straight to a download.
        const blob = await res.blob();
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = (res.headers.get("Content-Disposition")?.match(/filename="([^"]+)"/)?.[1]) ?? "packet.pdf";
        a.click();
        URL.revokeObjectURL(url);
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy("");
    }
  };

  if (pdfs.length < 2 && !open) return null;

  return (
    <div style={{ marginTop: 10, borderTop: "1px solid var(--line)", paddingTop: 8 }}>
      {!open ? (
        <span className="row-3">
          <button className="btn link t-small" onClick={openIt}>
            Combine {pdfs.length} PDFs into one packet…
          </button>
          <a className="btn link t-small" href="/pdf">
            page-level editing in the PDF studio →
          </a>
        </span>
      ) : (
        <div className="dash-form">
          <div className="panel-head">
            <span className="card-title" style={{ fontSize: 14 }}>Combine into one packet</span>
            <span className="sp" />
            <button className="btn link t-small" onClick={() => setOpen(false)}>close</button>
          </div>
          <div className="panel-hint">order with the arrows; titles go in each document&apos;s header bar</div>

          {rows.map((r, ix) => (
            <div key={r.id} className="row-2" style={{ padding: "3px 0" }}>
              <input type="checkbox" className="check" checked={r.included}
                onChange={() => setRows((rs) => rs.map((x) => (x.id === r.id ? { ...x, included: !x.included } : x)))} />
              <span className="mut t-meta" style={{ width: 18, textAlign: "right" }}>
                {r.included ? included.indexOf(r) + 1 : "-"}
              </span>
              <button className="btn link t-body" style={{ padding: "0 3px" }} aria-label={`Move ${r.fileName} up`}
                onClick={() => move(ix, -1)}>↑</button>
              <button className="btn link t-body" style={{ padding: "0 3px" }} aria-label={`Move ${r.fileName} down`}
                onClick={() => move(ix, 1)}>↓</button>
              <input value={r.title} aria-label={`Header title for ${r.fileName}`}
                onChange={(e) => setRows((rs) => rs.map((x) => (x.id === r.id ? { ...x, title: e.target.value } : x)))}
                className="t-small" style={{ flex: "1 1 200px" }} />
              <span className="mut mono t-meta" style={{ maxWidth: 220, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {r.fileName}
              </span>
            </div>
          ))}

          <div className="row-3 t-small" style={{ margin: "10px 0" }}>
            <label style={{ display: "flex", gap: 6, alignItems: "center", cursor: "pointer" }}>
              <input type="checkbox" className="check" checked={withCover} onChange={(e) => setWithCover(e.target.checked)} />
              Cover page
            </label>
            <label style={{ display: "flex", gap: 6, alignItems: "center", cursor: "pointer" }}>
              <input type="checkbox" className="check" checked={numbers} onChange={(e) => setNumbers(e.target.checked)} />
              Page numbers
            </label>
            <label style={{ display: "flex", gap: 6, alignItems: "center", cursor: "pointer" }}>
              <input type="checkbox" className="check" checked={headers} onChange={(e) => setHeaders(e.target.checked)} />
              Header bar per document
            </label>
          </div>
          {withCover && (
            <input value={cover} onChange={(e) => setCover(e.target.value)} placeholder="Packet title for the cover"
              className="t-body" style={{ marginBottom: 10 }} />
          )}

          <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
            <button className="btn sm accent" disabled={!!busy || !included.length} onClick={() => run("save")}>
              {busy === "save" ? "Building..." : `Save packet to Files (${included.length})`}
            </button>
            <button className="btn sm" disabled={!!busy || !included.length} onClick={() => run("download")}>
              {busy === "download" ? "Building..." : "Download"}
            </button>
            {savedName && <span className="t-small" style={{ color: "var(--t-good-fg)", fontWeight: 700 }}>{savedName} filed ✓</span>}
          </div>
          {error && <div className="t-small" style={{ color: "var(--t-bad-fg)", marginTop: 8 }}>{error}</div>}
        </div>
      )}
    </div>
  );
}
