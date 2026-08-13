"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { upload } from "@vercel/blob/client";
import { recordAttachments, recordLibraryFiles } from "@/app/actions";
import type { PageRef } from "@/lib/pdfCombine";
import { isFileDrag, rejectedMessage, splitDropped } from "@/lib/dropFiles";

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

type WorkPage = {
  uid: number; docKey: string; pageIx: number; rotate: 0 | 90 | 180 | 270;
  /** Header for this page alone. "" inherits the source document's title. */
  title: string;
};

const MAX_TOTAL = 120 * 1024 * 1024; // the browser holds every byte; stay honest about it
// Raster width for a thumbnail. The grid decides how wide a card is drawn, so
// this only sets sharpness - a little bigger than the widest card keeps a phone
// (fewer, wider columns) from showing an upscaled blur.
const THUMB_W = 200;

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
export default function PdfStudio({ sources, destinations, canUseLibrary, libraryLabel = "Document library" }: {
  sources: SourceListing[];
  destinations: Destination[];
  canUseLibrary: boolean;
  /** What this person's own shelf is called - the house's is "the library". */
  libraryLabel?: string;
}) {
  const [docs, setDocs] = useState<StudioDoc[]>([]);
  const [pages, setPages] = useState<WorkPage[]>([]);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [thumbVersion, setThumbVersion] = useState(0);
  const [drag, setDrag] = useState<number | null>(null);
  const [over, setOver] = useState<number | "end" | null>(null);
  const [filter, setFilter] = useState("");
  // A drag from outside the page. Counted rather than flagged: dragenter and
  // dragleave both fire for every child element the pointer crosses, so a plain
  // boolean flickers off the moment the cursor moves over a card inside.
  const [fileOver, setFileOver] = useState(false);
  const dragDepth = useRef(0);
  const [dropNote, setDropNote] = useState("");
  const [cover, setCover] = useState("");
  const [numbers, setNumbers] = useState(true);
  const [headers, setHeaders] = useState(true);
  const [bulkTitle, setBulkTitle] = useState("");
  const [moveTo, setMoveTo] = useState("");
  const [dest, setDest] = useState("download");
  const [fileName, setFileName] = useState("packet.pdf");
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [saved, setSaved] = useState("");

  const pdfjsRef = useRef<PdfJs | null>(null);
  const thumbs = useRef(new Map<string, string>());
  // The queue carries its own bytes. Reading them back off `docs` through a ref
  // was a race nobody could see: setDocs is asynchronous, so a page queued in
  // the same tick found no bytes yet, got skipped, and - already shifted off -
  // never came back. That is the "rendering…" that never finishes.
  const renderQueue = useRef<{ docKey: string; pageIx: number; bytes: ArrayBuffer }[]>([]);
  const rendering = useRef(false);
  const dropped = useRef(new Set<string>()); // doc keys removed mid-render

  const totalBytes = docs.reduce((n, d) => n + (d.bytes?.byteLength ?? 0), 0);

  const pdfjs = useCallback(async (): Promise<PdfJs> => {
    if (pdfjsRef.current) return pdfjsRef.current;
    const mod = await import("pdfjs-dist");
    mod.GlobalWorkerOptions.workerSrc = new URL("pdfjs-dist/build/pdf.worker.min.mjs", import.meta.url).toString();
    pdfjsRef.current = mod;
    return mod;
  }, []);

  /**
   * Sequential thumbnail renderer - one page at a time keeps memory flat.
   *
   * Only one pump runs at a time; a second caller is turned away by the guard
   * and its pages are drained by the pass already running, because the loop
   * re-reads the shared queue on every iteration.
   */
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
          if (thumbs.current.has(cacheKey) || dropped.current.has(next.docKey)) continue;
          try {
            let pdf = open.get(next.docKey);
            if (!pdf) {
              // slice(0) every time: pdfjs takes ownership of the buffer it is
              // handed and detaches it, so the original must never be passed.
              pdf = await lib.getDocument({ data: next.bytes.slice(0) }).promise;
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
      setPages((ps) => [...ps, ...Array.from({ length: count }, (_, i) => ({ uid: uidCounter++, docKey: key, pageIx: i, rotate: 0 as const, title: "" }))]);
      renderQueue.current.push(...Array.from({ length: count }, (_, i) => ({ docKey: key, pageIx: i, bytes })));
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

  const addLocal = (files: FileList | null, from = "this device") => {
    const { pdfs, rejected } = splitDropped(Array.from(files ?? []));
    for (const f of pdfs) {
      void ingest(`local-${uidCounter++}`, titleFrom(f.name), from, f.name, () => f.arrayBuffer());
    }
    // Said out loud rather than swallowed: a packet quietly missing the pages
    // somebody thought they added is worse than a line of text.
    setDropNote(rejectedMessage(rejected));
  };

  /**
   * Files dragged straight in from a folder window.
   *
   * The point of this is the file that is not on the machine yet. A PDF sitting
   * in OneDrive, SharePoint or any other synced folder appears in Explorer like
   * any other file, and dragging it here makes the OS fetch it on the spot - so
   * the "download it first, then upload it" round trip disappears without this
   * app knowing anything about anybody's cloud storage.
   */
  const onFileDrop = (e: React.DragEvent) => {
    if (!isFileDrag(e.dataTransfer?.types)) return;   // a page tile being reordered
    e.preventDefault();
    dragDepth.current = 0;
    setFileOver(false);
    addLocal(e.dataTransfer.files, "dropped in");
  };

  const removeDoc = (key: string) => {
    // Tell an in-flight pump to stop drawing pages nobody will look at.
    dropped.current.add(key);
    renderQueue.current = renderQueue.current.filter((q) => q.docKey !== key);
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

  /**
   * One step left or right. Dragging is nicer with a mouse and impossible with
   * a finger - touch fires no drag events at all - so nudging is the reorder
   * that always works. It's also the keyboard one.
   */
  const nudge = (uid: number, dir: -1 | 1) =>
    setPages((ps) => {
      const ix = ps.findIndex((p) => p.uid === uid);
      const j = ix + dir;
      if (ix < 0 || j < 0 || j >= ps.length) return ps;
      const next = [...ps];
      [next[ix], next[j]] = [next[j], next[ix]];
      return next;
    });

  /**
   * Send every selected page to a position, in their current relative order.
   * Nudging page 30 to the front is thirty taps; this is one. 1-based, because
   * that's what the badges on the thumbnails say.
   */
  const moveSelectedTo = (position: number) =>
    setPages((ps) => {
      const moving = ps.filter((p) => selected.has(p.uid));
      if (!moving.length) return ps;
      const rest = ps.filter((p) => !selected.has(p.uid));
      const at = Math.min(Math.max(position - 1, 0), rest.length);
      return [...rest.slice(0, at), ...moving, ...rest.slice(at)];
    });

  const setTitles = (uids: Set<number>, title: string) =>
    setPages((ps) => ps.map((p) => (uids.has(p.uid) ? { ...p, title } : p)));

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
      // A blank page title means "inherit the document's" - lib/pdfCombine
      // resolves that, so send it through as-is rather than pre-flattening it.
      const refs: PageRef[] = pages.map((p) => ({
        docIx: docIx.get(p.docKey)!, pageIx: p.pageIx, rotate: p.rotate, title: p.title,
      }));
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
          setSaved(`${cleanName} filed on ${libraryLabel.toLowerCase()}`);
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
    <div className="pdf-studio"
      onDragEnter={(e) => {
        if (!isFileDrag(e.dataTransfer?.types)) return;
        dragDepth.current += 1;
        setFileOver(true);
      }}
      onDragOver={(e) => { if (isFileDrag(e.dataTransfer?.types)) e.preventDefault(); }}
      onDragLeave={(e) => {
        if (!isFileDrag(e.dataTransfer?.types)) return;
        dragDepth.current = Math.max(0, dragDepth.current - 1);
        if (dragDepth.current === 0) setFileOver(false);
      }}
      onDrop={onFileDrop}
      style={fileOver ? { outline: "2px dashed var(--sky)", outlineOffset: 6, borderRadius: 10 } : undefined}>
      {/* ── Sources ── */}
      <div>
        <div className="card">
          <div className="card-title" style={{ marginBottom: 6 }}>Sources</div>
          <label className="btn sm" style={{ display: "inline-block", cursor: "pointer", marginBottom: 4 }}>
            + From this device
            <input type="file" accept="application/pdf,.pdf" multiple style={{ display: "none" }}
              onChange={(e) => { addLocal(e.target.files); e.target.value = ""; }} />
          </label>
          <div className="mut" style={{ fontSize: 11, marginBottom: 8 }}>
            {fileOver ? "Drop to add" : "or drag PDFs in from a folder — OneDrive included"}
          </div>
          {dropNote && (
            <div style={{ fontSize: 11, color: "#8A5410", marginBottom: 8 }}>
              {dropNote} <button className="btn link" style={{ fontSize: 11 }} onClick={() => setDropNote("")}>dismiss</button>
            </div>
          )}
          {sources.length > 6 && (
            <input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Filter by name or record"
              style={{ fontSize: 12, marginBottom: 8 }} />
          )}
          <div className="pdf-srclist">
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
            <div className="card-title" style={{ marginBottom: 2 }}>In this packet</div>
            <div className="mut" style={{ fontSize: 11, marginBottom: 6 }}>
              Each title is the default header for that document&apos;s pages. Any page can override it.
            </div>
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
              {pages.length
                ? <>{pages.length} page{pages.length === 1 ? "" : "s"} · tap a page to select<span className="pdf-drag-hint">, drag or use ‹ › to reorder</span></>
                : "Add a source to begin"}
            </span>
          </div>
          {pages.length > 0 && (
            <div className="mut" style={{ fontSize: 11, marginBottom: 8 }}>
              The box under each page is its header title. Leave it blank and the page takes its
              document&apos;s title from the left; type in it and that page alone says something different.
            </div>
          )}

          {/* Bulk operations. Wraps to its own rows on a narrow screen rather
              than squeezing into the title line. */}
          {selected.size > 0 && (
            <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap", marginBottom: 10,
              background: "#F4F6F9", border: "1px solid var(--line)", borderRadius: 8, padding: "6px 8px" }}>
              <b style={{ fontSize: 12 }}>{selected.size} selected</b>
              <button className="btn sm" onClick={() => rotateUids(selected, -1)}>⟲</button>
              <button className="btn sm" onClick={() => rotateUids(selected, 1)}>⟳</button>
              <button className="btn sm" style={{ color: "#A32D2D" }} onClick={() => removeUids(selected)}>Remove</button>
              <span style={{ display: "flex", gap: 4, alignItems: "center" }}>
                <input value={bulkTitle} onChange={(e) => setBulkTitle(e.target.value)}
                  aria-label="Header title for the selected pages" placeholder="header for these pages"
                  style={{ fontSize: 12, width: 150 }} />
                <button className="btn sm" onClick={() => setTitles(selected, bulkTitle.trim())}>Set</button>
              </span>
              <span style={{ display: "flex", gap: 4, alignItems: "center" }}>
                <label className="mut" style={{ fontSize: 12 }} htmlFor="pdf-moveto">to page</label>
                <input id="pdf-moveto" value={moveTo} onChange={(e) => setMoveTo(e.target.value.replace(/\D/g, ""))}
                  inputMode="numeric" style={{ fontSize: 12, width: 52 }} />
                <button className="btn sm" disabled={!moveTo} onClick={() => moveSelectedTo(parseInt(moveTo) || 1)}>Move</button>
              </span>
              <button className="btn link" style={{ fontSize: 12 }} onClick={() => setSelected(new Set())}>clear</button>
            </div>
          )}

          <div className="pdf-pages">
            {pages.map((p, ix) => {
              const key = `${p.docKey}:${p.pageIx}`;
              const src = thumbs.current.get(key);
              const isSel = selected.has(p.uid);
              const docTitle = docs.find((d) => d.key === p.docKey)?.title ?? "";
              return (
                <div key={p.uid} className="pdf-page"
                  onDragOver={(e) => { if (drag !== null) { e.preventDefault(); setOver(p.uid); } }}
                  onDrop={(e) => { if (drag !== null) { e.preventDefault(); dropAt(drag, p.uid); setDrag(null); setOver(null); } }}
                  style={{
                    opacity: drag === p.uid ? 0.4 : 1,
                    outline: isSel ? "3px solid var(--navy)" : over === p.uid && drag !== null ? "2px dashed var(--navy)" : "1px solid var(--line)",
                    outlineOffset: 2,
                  }}
                >
                  {/* Only the thumbnail is draggable: an input inside a
                      draggable element can't be selected in every browser. */}
                  <div className="pdf-thumb"
                    draggable
                    onDragStart={() => setDrag(p.uid)}
                    onDragEnd={() => { setDrag(null); setOver(null); }}
                    onClick={() => toggleSelect(p.uid)}
                  >
                    {src ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={src} alt={`Page ${ix + 1}`} draggable={false}
                        style={{ width: "100%", display: "block", borderRadius: 4, transform: p.rotate ? `rotate(${p.rotate}deg)` : undefined }} />
                    ) : (
                      <div style={{ width: "100%", aspectRatio: "17 / 22", display: "grid", placeItems: "center", background: "#F4F6F9", borderRadius: 4 }}>
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
                  </div>
                  <input value={p.title} placeholder={docTitle || "no header"}
                    aria-label={`Header title for page ${ix + 1}`}
                    onChange={(e) => setTitles(new Set([p.uid]), e.target.value)} />
                  <span className="pdf-acts">
                    <button className="btn sm" disabled={ix === 0} aria-label={`Move page ${ix + 1} earlier`}
                      onClick={() => nudge(p.uid, -1)}>‹</button>
                    <button className="btn sm" aria-label={`Rotate page ${ix + 1}`}
                      onClick={() => rotateUids(new Set([p.uid]), 1)}>⟳</button>
                    <button className="btn sm" style={{ color: "#A32D2D" }} aria-label={`Remove page ${ix + 1}`}
                      onClick={() => removeUids(new Set([p.uid]))}>×</button>
                    <button className="btn sm" disabled={ix === pages.length - 1} aria-label={`Move page ${ix + 1} later`}
                      onClick={() => nudge(p.uid, 1)}>›</button>
                  </span>
                </div>
              );
            })}
            {pages.length > 0 && drag !== null && (
              <div
                onDragOver={(e) => { e.preventDefault(); setOver("end"); }}
                onDrop={(e) => { e.preventDefault(); dropAt(drag, "end"); setDrag(null); setOver(null); }}
                style={{
                  minHeight: 120, borderRadius: 4, display: "grid", placeItems: "center",
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
                {canUseLibrary && <option value="library">{libraryLabel}</option>}
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
              Header bar on each page
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
