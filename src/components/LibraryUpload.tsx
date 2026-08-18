"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { upload } from "@vercel/blob/client";
import { recordLibraryFiles } from "@/app/actions";
import { fmtBytes } from "@/lib/storage";
import { isFileDrag } from "@/lib/dropFiles";

/**
 * Putting files in the store.
 *
 * Two things it has to say, because a client read the old version and decided
 * not to upload at all: that a file landing here touches none of their systems,
 * and that dropping one anywhere on the page works. The first was true and
 * unsaid; the second was not true and is now.
 *
 * Uploads go browser-to-Blob; the server only mints the token and records the
 * row. Both ends check the storage quota, and the token mint refuses first so a
 * doomed 90MB transfer is never started.
 */
export default function LibraryUpload({ full, maxBytes, folderId = null, folderName = "" }: {
  full: boolean; maxBytes: number;
  /** Where a drop lands: the folder that is open. Null = the top level. */
  folderId?: number | null;
  folderName?: string;
}) {
  const router = useRouter();
  const ref = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState("");
  const [done, setDone] = useState(0);
  const [total, setTotal] = useState(0);
  const [error, setError] = useState("");
  const [note, setNote] = useState("");
  const [over, setOver] = useState(false);

  const send = async (list: FileList | File[] | null) => {
    const files = Array.from(list ?? []);
    if (!files.length || full) return;
    setError(""); setNote(""); setDone(0); setTotal(files.length);
    // Refused here rather than by the token mint, so the message names the file
    // and the ceiling instead of arriving as a transfer that dies at 99%.
    const big = files.find((f) => f.size > maxBytes);
    if (big) {
      setError(`${big.name} is ${fmtBytes(big.size)} - the limit is ${fmtBytes(maxBytes)} per file.`);
      setTotal(0);
      return;
    }
    const filed: { fileName: string; url: string; size: number; description: string }[] = [];
    try {
      for (const f of files) {
        setBusy(`${f.name} (${fmtBytes(f.size)})`);
        const blob = await upload(f.name, f, { access: "public", handleUploadUrl: "/api/upload" });
        filed.push({ fileName: f.name, url: blob.url, size: f.size, description: "" });
        setDone((n) => n + 1);
      }
      const res = await recordLibraryFiles(filed, folderId);
      if (res?.error) throw new Error(res.error);
      setNote(`${filed.length} file${filed.length === 1 ? "" : "s"} uploaded`);
      router.refresh();
    } catch (e) {
      // Whatever failed, say which file and why - a silent stop here looks like
      // the upload worked.
      setError(`${busy || "Upload"}: ${(e as Error).message}`);
    } finally {
      setBusy(""); setTotal(0);
    }
  };

  // The whole window is the drop target, which is what makes this read as a
  // drive rather than as a form with a file button on it. Guarded on an actual
  // file drag, so dragging text or a link around the page does nothing.
  useEffect(() => {
    if (full) return;
    const enter = (e: DragEvent) => { if (isFileDrag(e.dataTransfer?.types)) { e.preventDefault(); setOver(true); } };
    const leave = (e: DragEvent) => { if (!e.relatedTarget) setOver(false); };
    const drop = (e: DragEvent) => {
      if (!isFileDrag(e.dataTransfer?.types)) return;
      e.preventDefault(); setOver(false);
      void send(e.dataTransfer?.files ?? null);
    };
    window.addEventListener("dragover", enter);
    window.addEventListener("dragleave", leave);
    window.addEventListener("drop", drop);
    return () => {
      window.removeEventListener("dragover", enter);
      window.removeEventListener("dragleave", leave);
      window.removeEventListener("drop", drop);
    };
  });

  return (
    <>
      <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
        <button className="btn sm primary" disabled={!!busy || full} onClick={() => ref.current?.click()}>
          {busy ? `Uploading ${done + 1}/${total}...` : "⇧ Upload files"}
        </button>
        <input ref={ref} type="file" multiple style={{ display: "none" }}
          onChange={(e) => { void send(e.target.files); e.target.value = ""; }} />
        <span className="mut" style={{ fontSize: 11.5 }}>
          {/* Naming the open folder here, not just on the drop overlay: this is
              the line somebody reads BEFORE they drag, and "which folder does
              this land in" is the question they are asking at that moment. */}
          or drop them anywhere on this page
          {folderName ? <> · into <b style={{ fontWeight: 700 }}>{folderName}</b></> : ""}
          {" "}· up to {fmtBytes(maxBytes)} each
        </span>
        {busy && <span className="mut" style={{ fontSize: 12 }}>{busy}</span>}
        {note && <span style={{ fontSize: 12, color: "#2E6B2E", fontWeight: 700 }}>{note} ✓</span>}
        {full && <span style={{ fontSize: 12, color: "#A32D2D" }}>Storage is full - delete something or raise the limit.</span>}
      </div>
      {error && <div style={{ fontSize: 12, color: "#A32D2D", marginTop: 6 }}>{error}</div>}

      {/* Only while something is actually being dragged over the window. */}
      {over && (
        <div style={{
          position: "fixed", inset: 0, zIndex: 60, background: "rgba(15,23,42,.55)",
          display: "flex", alignItems: "center", justifyContent: "center", pointerEvents: "none",
        }}>
          <div style={{
            background: "#fff", borderRadius: 14, padding: "22px 30px", textAlign: "center",
            border: "2px dashed var(--navy)",
          }}>
            <div style={{ fontSize: 15, fontWeight: 800, color: "var(--navy)" }}>Drop to upload</div>
            <div className="mut" style={{ fontSize: 12, marginTop: 4 }}>
              {folderName ? <>Files land in <b style={{ fontWeight: 700 }}>{folderName}</b>. </> : "Files land in your storage. "}
              Nothing is attached to a system.
            </div>
          </div>
        </div>
      )}
    </>
  );
}
