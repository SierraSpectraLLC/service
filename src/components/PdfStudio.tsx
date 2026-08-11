"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { upload } from "@vercel/blob/client";
import { recordAttachments, recordLibraryFiles } from "@/app/actions";
import type { PageRef } from "@/lib/pdfCombine";

// pdfjs renders thumbnails; pdf-lib assembles the result. Both are loaded on
// demand so nobody pays for the studio until they open it.
type PdfJs = typeof import("pdfjs-dist");

type SourceListing = { id: number; fileName: string; kind: string; size: number; home: string };
type Destination = { key: string; label: string };

type StudioDoc = {
  key: string;
  title: string;                 // header-bar title, editable
  from: string;                  // "SS-1042" / "this device" / "Library"
  fileName: string;
  bytes: ArrayBuffer | null;
  pageCount: number;
  state: "loading" | "ready" | "error";
  error?: string;
};

type WorkPage = { uid: number; docKey: string; pageIx: number; rotate: 0 | 90 | 180 | 270 };

const MAX_TOTAL = 120 * 1024 * 1024; // the browser holds every byte; stay honest about it
const THUMB_W = 150;

const fmtSize = (b: number) =>
  !b ? "" : b < 1048576 ? `${Math.round(b / 1024)} KB` : `${(b / 1048576).toFixed(1)} MB`;

const titleFrom = (fileName: string) => fileName.replace(/\.pdf$/i, "").replace(/[-_]+/g, " ").trim();

// Source chips cycle through a small palette so "which document is this page
// from" is answerable at a glance in a 40-page working set.
const DOC_COLORS = ["#1D6396", "#2E6B2E", "#8A5410", "#4F45A3", "#A33A1A", "#085041"];

let uidCounter = 1;

/**
 * The PDF studio: build one document out of many, page by page.
 *
 * Everything heavy happens in this browser tab. Sources stream in through the
 * authorized file proxy (?raw=1, same-origin), pdfjs draws the thumbnails,
 * pdf-lib assembles the result, and the finished packet goes out through the
 * same upload path every attachment uses. The server's only new job was
 * streaming bytes instead of redirecting - there is no studio backend to
 * secure beyond the gates that already exist.
 */
export default function PdfStudio({ sources, destinations, canUseLibrary }: {
  sources: SourceListing[];
  destinations: Destination[];
  canUseLibrary: boolean;
}) {
  const [docs, setDocs] = useState<StudioDoc[]>([]);
  const [pages, setPages] = useState<WorkPage[]>([]);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [thumbVersion, setThumbVersion] = useState(0);
  const [drag, setDrag] = useState<number | null>(null);
  const [over, setOver] = useState<number | "end" | null>(null);
  const [filter, setFilter] = useState("");
  const [cover, setCover] = useState("");
  const [numbers, setNumbers] = useState(true);
  const [headers, setHeaders] = useState(true);
  const [dest, setDest] = useState("download");
  const [fileName, setFileName] = useState("packet.pdf");
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [saved, setSaved] = useState("");

  const pdfjsRef = useRef<PdfJs | null>(null);
  const thumbs = useRef(new Map<string, string>());
  const renderQueue = useRef<{ docKey: string; pageIx: number }[]>([]);
  const rendering = useRef(false);
  const docsRef = useRef(docs);
  docsRef.current = docs;

  const totalBytes = docs.reduce((n, d) => n + (d.bytes?.byteLength ?? 0), 0);

  const pdfjs = useCallback(async (): Promise<PdfJs> => {
    if (pdfjsRef.current) return pdfjsRef.current;
    const mod = await import("pdfjs-dist");
    mod.GlobalWorkerOptions.workerSrc = new URL("pdfjs-dist/build/pdf.worker.min.mjs", import.meta.url).toString();
    pdfjsRef.current = mod;
    return mod;
  }, []);

  /** Sequential thumbnail renderer - one page at a time keeps memory flat. */
  const pumpThumbs = useCallback(async () => {
    if (rendering.current) return;
    rendering.current = true;
    try {
      const lib = await pdfjs();
      // One parsed document per source for the whole pump, not per page - a
      // thirty-page report is one load, not thirty.
      const open = new Map<string, Awaited<ReturnType<PdfJs["getDocument"]>["promise"]>>();
      try {
        for (;;) {
          const next = renderQueue.current.shift();
          if (!next) break;
          const cacheKey = `${next.docKey}:${next.pageIx}`;
          if (thumbs.current.has(cacheKey)) continue;
          const doc = docsRef.current.find((d) => d.key === next.docKey);
          if (!doc?.bytes) continue;
          try {
            let pdf = open.get(next.docKey);
            if (!pdf) {
              pdf = await lib.getDocument({ data: doc.bytes.slice(0) }).promise;
              open.set(next.docKey, pdf);
            }
            const page = await pdf.getPage(next.pageIx + 1);
            const base = page.getViewport({ scale: 1 });
            const viewport = page.getViewport({ scale: THUMB_W / base.width });
            const canvas = document.createElement("canvas");
            canvas.width = Math.ceil(viewport.width);
            canvas.height = Math.ceil(viewport.height);
            await page.render({ canvas, canvasContext: canvas.getContext("2d")!, viewport }).promise;
            thumbs.current.set(cacheKey, canvas.toDataURL("image/jpeg", 0.72));
            setThumbVersion((v) => v + 1);
          } catch {
            thumbs.current.set(cacheKey, ""); // unrenderable page: placeholder, keep going
            setThumbVersion((v) => v + 1);
          }
        }
      } finally {
        for (const pdf of open.values()) void pdf.cleanup();
      }
    } finally {
      rendering.current = false;
    }
  }, [pdfjs]);

  const ingest = useCallback(async (key: string, title: string, from: string, fileName: string, fetchBytes: () => Promise<ArrayBuffer>) => {
    setDocs((ds) => [...ds, { key, title, from, fileName, bytes: null, pageCount: 0, state: "loading" }]);
    try {
      const bytes = await fetchBytes();
      if (totalBytes + bytes.byteLength > MAX_TOTAL) throw new Error("That would take the working set past 120MB in this tab");
      const lib = await pdfjs();
      const pdf = await lib.getDocument({ data: bytes.slice(0) }).promise;
      const count = pdf.numPages;
      void pdf.cleanup();
      setDocs((ds) => ds.map((d) => (d.key === key ? { ...d, bytes, pageCount: count, state: "ready" } : d)));
      // Every page joins the working set; unwanted ones are one click to drop.
      setPages((ps) => [...ps, ...Array.from({ length: count }, (_, i) => ({ uid: uidCounter++, docKey: key, pageIx: i, rotate: 0 as const }))]);
      renderQueue.current.push(...Array.from({ length: count }, (_, i) => ({ docKey: key, pageIx: i })));
      void pumpThumbs();
    } catch (e) {
      setDocs((ds) => ds.map((d) => (d.key === key ? { ...d, state: "error", error: (e as Error).message } : d)));
    }
  }, [pdfjs, pumpThumbs, totalBytes]);

  const addAttachment = (s: SourceListing) =>
    void ingest(`att-${s.id}-${uidCounter++}`, titleFrom(s.fileName), s.home, s.fileName, async () => {
      const res = await fetch(`/api/files/${s.id}?raw=1`);
      if (!res.ok) throw new Error(`Couldn't fetch ${s.fileName} (${res.status})`);
      return res.arrayBuffer();
    });

  const addLocal = (files: FileList | null) => {
    for (const f of Array.from(files ?? [])) {
      void ingest(`local-${uidCounter++}`, titleFrom(f.name), "this device", f.name, () => f.arrayBuffer());
    }
  };

  const removeDoc = (key: string) => {
    setDocs((ds) => ds.filter((d) => d.key !== key));
    setPages((ps) => ps.filter((p) => p.docKey !== key));
    setSelected(new Set());
  };

  // ---- page operations --------------------------------------------------

  const rotateUids = (uids: Set<number>, dir: 1 | -1) =>
    setPages((ps) => ps.map((p) => (uids.has(p.uid)
      ? { ...p, rotate: (((p.rotate + dir * 90) % 360 + 360) % 360) as WorkPage["rotate"] }
      : p)));

  const removeUids = (uids: Set<number>) => {
    setPages((ps) => ps.filter((p) => !uids.has(p.uid)));
    setSelected(new Set());
  };

  const toggleSelect = (uid: number) =>
    setSelected((cur) => {
      const next = new Set(cur);
      if (next.has(uid)) next.delete(uid); else next.add(uid);
      return next;
    });

  const dropAt = (uid: number, before: number | "end") => {
    setPages((ps) => {
      const moving = ps.find((p) => p.uid === uid);
      if (!moving) return ps;
      const rest = ps.filter((p) => p.uid !== uid);
      if (before === "end") return [...rest, moving];
      const ix = rest.findIndex((p) => p.uid === before);
      if (ix < 0) return ps;
      return [...rest.slice(0, ix), moving, ...rest.slice(ix)];
    });
  };

  // ---- save ---------------------------------------------------------------

  const save = async (mode: "download" | "store") => {
    if (!pages.length) { setError("The working set is empty - add a PDF"); return; }
    const notReady = docs.filter((d) => d.state === "loading" && pages.some((p) => p.docKey === d.key));
    if (notReady.length) { setError("Still loading a source - a moment"); return; }
    setBusy(mode); setError(""); setSaved("");
    try {
      const usedKeys = [...new Set(pages.map((p) => p.docKey))];
      const usedDocs = usedKeys.map((k) => docs.find((d) => d.key === k)!).filter((d) => d.bytes);
      const docIx = new Map(usedDocs.map((d, i) => [d.key, i]));
      const refs: PageRef[] = pages.map((p) => ({ docIx: docIx.get(p.docKey)!, pageIx: p.pageIx, rotate: p.rotate }));
      const { assemblePdf } = await import("@/lib/pdfCombine");
      const bytes = await assemblePdf(
        usedDocs.map((d) => ({ bytes: d.bytes!, title: d.title })),
        refs,
        { coverTitle: cover.trim(), coverLines: [], pageNumbers: numbers, headers },
      );
      const cleanName = (fileName.trim().replace(/[^\w.\- ]/g, "") || "packet.pdf").replace(/(\.pdf)?$/i, ".pdf");

      if (mode === "download" || dest === "download") {
        const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: "application/pdf" }));
        const a = document.createElement("a");
        a.href = url; a.download = cleanName; a.click();
        URL.revokeObjectURL(url);
        setSaved(`${cleanName} downloaded`);
      } else {
        const blob = await upload(cleanName, new Blob([bytes as BlobPart], { type: "application/pdf" }), {
          access: "public", handleUploadUrl: "/api/upload",
        });
        const meta = {
          fileName: cleanName, url: blob.url, size: bytes.byteLength,
          description: `Assembled in the PDF studio from ${usedDocs.length} document${usedDocs.length === 1 ? "" : "s"}`,
        };
        if (dest === "library") {
          const res = await recordLibraryFiles([meta]);
          if (res?.error) throw new Error(res.error);
          setSaved(`${cleanName} filed in the document library`);
        } else {
          const [kind, idStr] = dest.split(":");
          const target = kind === "i"
            ? { instrumentId: parseInt(idStr), assetId: null }
            : { instrumentId: null, assetId: parseInt(idStr) };
          const res = await recordAttachments(target, [{ ...meta, kind: "Report" }]);
          if (res?.error) throw new Error(res.error);
          setSaved(`${cleanName} filed on ${destinations.find((d) => d.key === dest)?.label ?? "the record"}`);
        }
      }
    } catch (e) {
      setError((e as Error).message || "Assembly failed");
    } finally {
      setBusy("");
    }
  };

  // Warn before the tab discards an unsaved working set.
  useEffect(() => {
    const guard = (e: BeforeUnloadEvent) => { if (pages.length && !saved) e.preventDefault(); };
    window.addEventListener("beforeunload", guard);
    return () => window.removeEventListener("beforeunload", guard);
  }, [pages.length, saved]);

  const needle = filter.trim().toLowerCase();
  const shownSources = needle
    ? sources.filter((s) => `${s.fileName} ${s.home}`.toLowerCase().includes(needle))
    : sources;
  const docColor = (key: string) => DOC_COLORS[docs.findIndex((d) => d.key === key) % DOC_COLORS.length];
  const canStore = dest !== "download";

  return (
    <div style={{ display: "grid", gridTemplateColumns: "minmax(240px, 300px) 1fr", gap: 14, alignItems: "start" }}>
      {/* ── Sources ── */}
      <div>
        <div className="card">
          <div className="card-title" style={{ marginBottom: 6 }}>Sources</div>
          <div className="mut" style={{ fontSize: 12, marginBottom: 8 }}>
            Any PDF you can read, from any record - or drop files from this device.
            Adding one puts all its pages in the working set.
          </div>
          <label className="btn sm" style={{ display: "inline-block", cursor: "pointer", marginBottom: 8 }}>
            + From this device
            <input type="file" accept="application/pdf,.pdf" multiple style={{ display: "none" }}
              onChange={(e) => { addLocal(e.target.files); e.target.value = ""; }} />
          </label>
          {sources.length > 6 && (
            <input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Filter by name or record"
              style={{ fontSize: 12, marginBottom: 8 }} />
          )}
          <div style={{ maxHeight: 420, overflowY: "auto" }}>
            {shownSources.map((s) => (
              <div key={s.id} style={{ display: "flex", gap: 6, alignItems: "baseline", padding: "5px 0", borderTop: "1px solid var(--line)" }}>
                <button className="btn link" style={{ fontSize: 12, fontWeight: 700, flexShrink: 0 }} onClick={() => addAttachment(s)}>+ add</button>
                <span style={{ fontSize: 12, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={s.fileName}>
                  {s.fileName}
                </span>
                <span className="mut" style={{ fontSize: 10, marginLeft: "auto", flexShrink: 0 }}>{s.home}</span>
              </div>
            ))}
            {shownSources.length === 0 && <div className="mut" style={{ fontSize: 12 }}>No PDFs match.</div>}
          </div>
        </div>

        {docs.length > 0 && (
          <div className="card">
            <div className="card-title" style={{ marginBottom: 6 }}>In this packet</div>
            {docs.map((d) => (
              <div key={d.key} style={{ padding: "6px 0", borderTop: "1px solid var(--line)" }}>
                <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                  <span aria-hidden style={{ width: 9, height: 9, borderRadius: 2, background: docColor(d.key), flexShrink: 0 }} />
                  <input value={d.title} aria-label={`Header title for ${d.fileName}`}
                    onChange={(e) => setDocs((ds) => ds.map((x) => (x.key === d.key ? { ...x, title: e.target.value } : x)))}
                    style={{ fontSize: 12, flex: 1 }} />
                  <button className="btn link" style={{ color: "#A32D2D", fontSize: 12 }} aria-label={`Remove ${d.fileName}`}
                    onClick={() => removeDoc(d.key)}>×</button>
                </div>
                <div className="mut" style={{ fontSize: 10, marginTop: 2 }}>
                  {d.state === "loading" ? "loading…"
                    : d.state === "error" ? <span style={{ color: "#A32D2D" }}>{d.error}</span>
                    : `${d.pageCount} page${d.pageCount === 1 ? "" : "s"} · ${d.from}${d.bytes ? ` · ${fmtSize(d.bytes.byteLength)}` : ""}`}
                </div>
              </div>
            ))}
            <div className="mut" style={{ fontSize: 10, marginTop: 6 }}>{fmtSize(totalBytes)} loaded in this tab</div>
          </div>
        )}
      </div>

      {/* ── Working set + output ── */}
      <div>
        <div className="card">
          <div style={{ display: "flex", alignItems: "baseline", gap: 8, flexWrap: "wrap", marginBottom: 4 }}>
            <div className="card-title">Pages</div>
            <span className="mut" style={{ fontSize: 12 }}>
              {pages.length ? `${pages.length} page${pages.length === 1 ? "" : "s"} - drag to reorder, click to select` : "Add a source to begin"}
            </span>
            {selected.size > 0 && (
              <span style={{ marginLeft: "auto", display: "flex", gap: 6, alignItems: "center" }}>
                <b style={{ fontSize: 12 }}>{selected.size} selected</b>
                <button className="btn sm" onClick={() => rotateUids(selected, -1)}>⟲ rotate</button>
                <button className="btn sm" onClick={() => rotateUids(selected, 1)}>⟳ rotate</button>
                <button className="btn sm" style={{ color: "#A32D2D" }} onClick={() => removeUids(selected)}>Remove</button>
                <button className="btn link" style={{ fontSize: 12 }} onClick={() => setSelected(new Set())}>clear</button>
              </span>
            )}
          </div>

          <div style={{ display: "flex", flexWrap: "wrap", gap: 10, minHeight: 120 }}>
            {pages.map((p, ix) => {
              const key = `${p.docKey}:${p.pageIx}`;
              const src = thumbs.current.get(key);
              const isSel = selected.has(p.uid);
              return (
                <div key={p.uid}
                  draggable
                  onDragStart={() => setDrag(p.uid)}
                  onDragEnd={() => { setDrag(null); setOver(null); }}
                  onDragOver={(e) => { if (drag !== null) { e.preventDefault(); setOver(p.uid); } }}
                  onDrop={(e) => { if (drag !== null) { e.preventDefault(); dropAt(drag, p.uid); setDrag(null); setOver(null); } }}
                  style={{
                    width: THUMB_W, cursor: "grab", position: "relative",
                    opacity: drag === p.uid ? 0.4 : 1,
                    outline: isSel ? "3px solid var(--navy)" : over === p.uid && drag !== null ? "2px dashed var(--navy)" : "1px solid var(--line)",
                    outlineOffset: 2, borderRadius: 4,
                  }}
                  onClick={() => toggleSelect(p.uid)}
                >
                  {src ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={src} alt={`Page ${ix + 1}`} draggable={false}
                      style={{ width: "100%", display: "block", borderRadius: 4, transform: p.rotate ? `rotate(${p.rotate}deg)` : undefined }} />
                  ) : (
                    <div style={{ width: "100%", height: 190, display: "grid", placeItems: "center", background: "#F4F6F9", borderRadius: 4 }}>
                      <span className="mut" style={{ fontSize: 11 }}>{src === "" ? "no preview" : "rendering…"}</span>
                    </div>
                  )}
                  <span style={{
                    position: "absolute", top: 4, left: 4, fontSize: 10, fontWeight: 700, color: "#fff",
                    background: docColor(p.docKey), borderRadius: 4, padding: "1px 5px",
                  }}>{ix + 1}</span>
                  {p.rotate !== 0 && (
                    <span className="mut" style={{ position: "absolute", top: 4, right: 4, fontSize: 9, background: "#fff", borderRadius: 4, padding: "0 3px" }}>
                      {p.rotate}°
                    </span>
                  )}
                  <span style={{ position: "absolute", bottom: 4, right: 4, display: "flex", gap: 2 }}
                    onClick={(e) => e.stopPropagation()}>
                    <button className="btn sm" style={{ padding: "1px 6px", fontSize: 11 }} aria-label={`Rotate page ${ix + 1}`}
                      onClick={() => rotateUids(new Set([p.uid]), 1)}>⟳</button>
                    <button className="btn sm" style={{ padding: "1px 6px", fontSize: 11, color: "#A32D2D" }} aria-label={`Remove page ${ix + 1}`}
                      onClick={() => removeUids(new Set([p.uid]))}>×</button>
                  </span>
                </div>
              );
            })}
            {pages.length > 0 && drag !== null && (
              <div
                onDragOver={(e) => { e.preventDefault(); setOver("end"); }}
                onDrop={(e) => { e.preventDefault(); dropAt(drag, "end"); setDrag(null); setOver(null); }}
                style={{
                  width: THUMB_W, minHeight: 120, borderRadius: 4, display: "grid", placeItems: "center",
                  border: `2px dashed ${over === "end" ? "var(--navy)" : "var(--line)"}`,
                }}
              ><span className="mut" style={{ fontSize: 11 }}>to the end</span></div>
            )}
          </div>
        </div>

        <div className="card">
          <div className="card-title" style={{ marginBottom: 8 }}>Output</div>
          <div className="pf2" style={{ marginBottom: 8 }}>
            <div>
              <label>File name</label>
              <input value={fileName} onChange={(e) => setFileName(e.target.value)} />
            </div>
            <div>
              <label>Destination</label>
              <select value={dest} onChange={(e) => setDest(e.target.value)}>
                <option value="download">Download only</option>
                {canUseLibrary && <option value="library">Document library</option>}
                {destinations.map((d) => <option key={d.key} value={d.key}>{d.label}</option>)}
              </select>
            </div>
            <div>
              <label>Cover page title (blank = none)</label>
              <input value={cover} onChange={(e) => setCover(e.target.value)} placeholder="SS-1042 validation packet" />
            </div>
          </div>
          <div style={{ display: "flex", gap: 14, flexWrap: "wrap", marginBottom: 10, fontSize: 12 }}>
            <label style={{ display: "flex", gap: 6, alignItems: "center", cursor: "pointer" }}>
              <input type="checkbox" checked={numbers} onChange={(e) => setNumbers(e.target.checked)} style={{ width: 15, height: 15 }} />
              Page numbers
            </label>
            <label style={{ display: "flex", gap: 6, alignItems: "center", cursor: "pointer" }}>
              <input type="checkbox" checked={headers} onChange={(e) => setHeaders(e.target.checked)} style={{ width: 15, height: 15 }} />
              Header bar per source document
            </label>
          </div>
          <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
            {canStore && (
              <button className="btn sm accent" disabled={!!busy || !pages.length} onClick={() => save("store")}>
                {busy === "store" ? "Building..." : `Save to ${destinations.find((d) => d.key === dest)?.label ?? "library"}`}
              </button>
            )}
            <button className="btn sm" disabled={!!busy || !pages.length} onClick={() => save("download")}>
              {busy === "download" ? "Building..." : "Download"}
            </button>
            {saved && <span style={{ fontSize: 12, color: "#2E6B2E", fontWeight: 700 }}>{saved} ✓</span>}
          </div>
          {error && <div style={{ fontSize: 12, color: "#A32D2D", marginTop: 8 }}>{error}</div>}
        </div>
      </div>
    </div>
  );
}
