"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { upload } from "@vercel/blob/client";
import { recordLibraryFiles } from "@/app/actions";
import { fmtBytes } from "@/lib/storage";

/**
 * Put a file straight on the shelf, without a system or a unit to hang it on.
 * The PDF studio could already file its output here; this is the plain "I have
 * a document" path - an SOP, a purchase order, a supplier certificate.
 *
 * Uploads go browser-to-Blob; the server only mints the token and records the
 * row. Both ends check the storage quota, and the token mint refuses first so a
 * doomed 90MB transfer is never started.
 */
export default function LibraryUpload({ full }: { full: boolean }) {
  const router = useRouter();
  const ref = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [note, setNote] = useState("");

  const send = async (list: FileList | null) => {
    const files = Array.from(list ?? []);
    if (!files.length) return;
    setError(""); setNote("");
    const done: { fileName: string; url: string; size: number; description: string }[] = [];
    try {
      for (const f of files) {
        setBusy(`${f.name} (${fmtBytes(f.size)})`);
        const blob = await upload(f.name, f, { access: "public", handleUploadUrl: "/api/upload" });
        done.push({ fileName: f.name, url: blob.url, size: f.size, description: "" });
      }
      const res = await recordLibraryFiles(done);
      if (res?.error) throw new Error(res.error);
      setNote(`${done.length} file${done.length === 1 ? "" : "s"} filed ✓`);
      router.refresh();
    } catch (e) {
      // Whatever failed, say which file and why - a silent stop here looks like
      // the upload worked.
      setError(`${busy || "Upload"}: ${(e as Error).message}`);
    } finally {
      setBusy("");
    }
  };

  return (
    <div style={{ marginBottom: 10 }}>
      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
        <button className="btn sm primary" disabled={!!busy || full} onClick={() => ref.current?.click()}>
          {busy ? "Uploading..." : "+ Add files to the shelf"}
        </button>
        <input ref={ref} type="file" multiple style={{ display: "none" }}
          onChange={(e) => { void send(e.target.files); e.target.value = ""; }} />
        {busy && <span className="mut" style={{ fontSize: 12 }}>{busy}</span>}
        {note && <span style={{ fontSize: 12, color: "#2E6B2E", fontWeight: 700 }}>{note}</span>}
        {full && <span style={{ fontSize: 12, color: "#A32D2D" }}>Storage is full - remove a file or raise the limit.</span>}
      </div>
      {error && <div style={{ fontSize: 12, color: "#A32D2D", marginTop: 6 }}>{error}</div>}
    </div>
  );
}
