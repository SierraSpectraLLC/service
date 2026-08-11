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
        <span style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
          <button className="btn link" style={{ fontSize: 12 }} onClick={openIt}>
            Combine {pdfs.length} PDFs into one packet…
          </button>
          <a className="btn link" style={{ fontSize: 12 }} href="/pdf">
            page-level editing in the PDF studio →
          </a>
        </span>
      ) : (
        <div className="dash-form">
          <div style={{ display: "flex", alignItems: "baseline", gap: 8, marginBottom: 8 }}>
            <b style={{ fontSize: 13, color: "var(--navy)" }}>Combine into one packet</b>
            <span className="mut" style={{ fontSize: 11 }}>
              order with the arrows; titles go in each document&apos;s header bar
            </span>
            <button className="btn link" style={{ marginLeft: "auto", fontSize: 12 }} onClick={() => setOpen(false)}>close</button>
          </div>

          {rows.map((r, ix) => (
            <div key={r.id} style={{ display: "flex", gap: 6, alignItems: "center", padding: "3px 0", flexWrap: "wrap" }}>
              <input type="checkbox" checked={r.included} style={{ width: 15, height: 15 }}
                onChange={() => setRows((rs) => rs.map((x) => (x.id === r.id ? { ...x, included: !x.included } : x)))} />
              <span className="mut" style={{ fontSize: 11, width: 18, textAlign: "right" }}>
                {r.included ? included.indexOf(r) + 1 : "—"}
              </span>
              <button className="btn link" style={{ fontSize: 13, padding: "0 3px" }} aria-label={`Move ${r.fileName} up`}
                onClick={() => move(ix, -1)}>↑</button>
              <button className="btn link" style={{ fontSize: 13, padding: "0 3px" }} aria-label={`Move ${r.fileName} down`}
                onClick={() => move(ix, 1)}>↓</button>
              <input value={r.title} aria-label={`Header title for ${r.fileName}`}
                onChange={(e) => setRows((rs) => rs.map((x) => (x.id === r.id ? { ...x, title: e.target.value } : x)))}
                style={{ flex: "1 1 200px", fontSize: 12 }} />
              <span className="mut mono" style={{ fontSize: 11, maxWidth: 220, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {r.fileName}
              </span>
            </div>
          ))}

          <div style={{ display: "flex", gap: 14, flexWrap: "wrap", margin: "10px 0", fontSize: 12 }}>
            <label style={{ display: "flex", gap: 6, alignItems: "center", cursor: "pointer" }}>
              <input type="checkbox" checked={withCover} onChange={(e) => setWithCover(e.target.checked)} style={{ width: 15, height: 15 }} />
              Cover page
            </label>
            <label style={{ display: "flex", gap: 6, alignItems: "center", cursor: "pointer" }}>
              <input type="checkbox" checked={numbers} onChange={(e) => setNumbers(e.target.checked)} style={{ width: 15, height: 15 }} />
              Page numbers
            </label>
            <label style={{ display: "flex", gap: 6, alignItems: "center", cursor: "pointer" }}>
              <input type="checkbox" checked={headers} onChange={(e) => setHeaders(e.target.checked)} style={{ width: 15, height: 15 }} />
              Header bar per document
            </label>
          </div>
          {withCover && (
            <input value={cover} onChange={(e) => setCover(e.target.value)} placeholder="Packet title for the cover"
              style={{ fontSize: 13, marginBottom: 10 }} />
          )}

          <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
            <button className="btn sm accent" disabled={!!busy || !included.length} onClick={() => run("save")}>
              {busy === "save" ? "Building..." : `Save packet to Files (${included.length})`}
            </button>
            <button className="btn sm" disabled={!!busy || !included.length} onClick={() => run("download")}>
              {busy === "download" ? "Building..." : "Download"}
            </button>
            {savedName && <span style={{ fontSize: 12, color: "#2E6B2E", fontWeight: 700 }}>{savedName} filed ✓</span>}
          </div>
          {error && <div style={{ fontSize: 12, color: "#A32D2D", marginTop: 8 }}>{error}</div>}
        </div>
      )}
    </div>
  );
}
