"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { upload } from "@vercel/blob/client";
import { recordLibraryFiles } from "@/app/actions";
import Dialog, { DialogStatus } from "@/components/ui/Dialog";
import { toast } from "@/components/ui/Toast";
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
 * The button opens a small Dialog that says where files land before any are
 * chosen; a drop anywhere on the page skips the dialog and just uploads.
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
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState("");
  const [done, setDone] = useState(0);
  const [total, setTotal] = useState(0);
  const [error, setError] = useState("");
  const [over, setOver] = useState(false);

  const send = async (list: FileList | File[] | null) => {
    const files = Array.from(list ?? []);
    if (!files.length || full) return;
    setError(""); setDone(0); setTotal(files.length);
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
      toast({ message: `Uploaded ${filed.length} file${filed.length === 1 ? "" : "s"}${folderName ? ` into ${folderName}` : ""}` });
      setOpen(false);
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
      <div className="row" style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
        <button className="btn sm primary" disabled={!!busy || full} onClick={() => { setOpen(true); setError(""); }}>
          {busy ? `Uploading ${done + 1}/${total}...` : "⇧ Upload files"}
        </button>
        <span className="mut" style={{ fontSize: 12 }}>
          or drop them anywhere on this page
          {folderName ? <> · into <b style={{ fontWeight: 700 }}>{folderName}</b></> : ""}
        </span>
        {full && <span className="t-small" style={{ color: "var(--t-bad-fg)" }}>Storage is full - delete something or raise the limit.</span>}
      </div>
      {!open && error && <div className="t-small" style={{ color: "var(--t-bad-fg)", marginTop: 6 }}>{error}</div>}

      <input ref={ref} type="file" multiple style={{ display: "none" }}
        onChange={(e) => { void send(e.target.files); e.target.value = ""; }} />

      {open && (
        <Dialog open size="sm" title="Upload files" onClose={() => { if (!busy) setOpen(false); }}
          context={folderName ? `Into ${folderName}` : "Into your storage"}
          footer={
            <>
              <DialogStatus error={error} problem={full ? "storage is full" : null}
                ok={busy ? `Uploading ${done + 1} of ${total} · ${busy}` : ""} />
              <button className="btn" onClick={() => setOpen(false)} disabled={!!busy}>Cancel</button>
              <button className="btn accent" disabled={!!busy || full} onClick={() => ref.current?.click()}>
                {busy ? "Uploading..." : "Choose files"}
              </button>
            </>
          }>
          <div className="t-body">
            {/* The sentence that unlocked this store for a hesitant client:
                nothing uploaded here touches a system. */}
            Files land in {folderName ? <b>{folderName}</b> : "your storage"} and are attached to no
            system, no unit and no job. Up to {fmtBytes(maxBytes)} each.
          </div>
          <div className="mut t-small" style={{ marginTop: 8 }}>
            You can also drop files anywhere on the page - no dialog needed.
          </div>
        </Dialog>
      )}

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
            <div style={{ fontSize: 16, fontWeight: 800, color: "var(--navy)" }}>Drop to upload</div>
            <div className="mut t-small" style={{ marginTop: 4 }}>
              {folderName ? <>Files land in <b style={{ fontWeight: 700 }}>{folderName}</b>. </> : "Files land in your storage. "}
              Nothing is attached to a system.
            </div>
          </div>
        </div>
      )}
    </>
  );
}
