"use client";

import { useRef, useState } from "react";
import { upload } from "@vercel/blob/client";
import { fmtBytes } from "@/lib/storage";

const MAX_BYTES = 100 * 1024 * 1024;

/**
 * The uploader on a drop link's public page. No session, no account: the token
 * in the URL is the credential, and the two API calls it makes re-check that
 * token on the server both times.
 *
 * The sender's name is asked for and optional. It is provenance, not auth -
 * "who sent this" written on the file is worth more than an empty box refused.
 */
export default function DropUploader({ token }: { token: string }) {
  const ref = useRef<HTMLInputElement>(null);
  const [sender, setSender] = useState("");
  const [busy, setBusy] = useState("");
  const [sent, setSent] = useState<string[]>([]);
  const [error, setError] = useState("");

  const send = async (list: FileList | null) => {
    const files = Array.from(list ?? []);
    if (!files.length) return;
    setError("");
    const big = files.find((f) => f.size > MAX_BYTES);
    if (big) { setError(`${big.name} is ${fmtBytes(big.size)} - the limit is ${fmtBytes(MAX_BYTES)} per file.`); return; }
    try {
      const done: { fileName: string; url: string; size: number }[] = [];
      for (const f of files) {
        setBusy(`Sending ${f.name} (${fmtBytes(f.size)})...`);
        const blob = await upload(f.name, f, { access: "public", handleUploadUrl: `/api/drop/${token}` });
        done.push({ fileName: f.name, url: blob.url, size: f.size });
      }
      const res = await fetch(`/api/drop/${token}/record`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sender, files: done }),
      });
      if (!res.ok) throw new Error((await res.json().catch(() => null))?.error ?? "Recording failed");
      setSent((s) => [...s, ...done.map((f) => f.fileName)]);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy("");
    }
  };

  return (
    <div>
      <label>Your name <span className="mut" style={{ fontWeight: 400 }}>(optional, shown with the files)</span></label>
      <input value={sender} onChange={(e) => setSender(e.target.value)} maxLength={80}
        placeholder="e.g. Sam at LabZen" style={{ marginBottom: 10 }} />
      <div
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => { e.preventDefault(); void send(e.dataTransfer.files); }}
        style={{
          border: "2px dashed var(--line)", borderRadius: 12, padding: "26px 16px",
          textAlign: "center", marginBottom: 10,
        }}>
        <button className="btn primary" disabled={!!busy} onClick={() => ref.current?.click()}>
          {busy || "Choose files"}
        </button>
        <input ref={ref} type="file" multiple style={{ display: "none" }}
          onChange={(e) => { void send(e.target.files); e.target.value = ""; }} />
        <div className="mut" style={{ fontSize: 12, marginTop: 8 }}>
          or drop them here · up to {fmtBytes(MAX_BYTES)} each
        </div>
      </div>
      {sent.length > 0 && (
        <div style={{ fontSize: 13, color: "#2E6B2E" }}>
          <b style={{ fontWeight: 700 }}>Sent ✓</b>
          <ul style={{ margin: "4px 0 0", paddingLeft: 18 }}>
            {sent.map((n, i) => <li key={i} style={{ fontSize: 12.5 }}>{n}</li>)}
          </ul>
        </div>
      )}
      {error && <div style={{ fontSize: 12.5, color: "#A32D2D" }}>{error}</div>}
    </div>
  );
}
