"use client";

import { useRef, useState, useTransition } from "react";
import { upload } from "@vercel/blob/client";
import { ATTACH_KINDS, ATTACH_META } from "@/lib/stages";
import { recordAttachment, deleteAttachment } from "@/app/actions";

type Attachment = {
  id: number; fileName: string; kind: string; url: string; size: number;
  uploadedBy: string; createdAt: string;
};

function guessKind(name: string): string {
  const n = name.toLowerCase();
  const ext = (n.split(".").pop() || "");
  if (/lcm|qgd|tune/.test(n)) return "Tune report";
  if (ext === "pdf") return "Report";
  if (/^(csv|txt|xls|xlsx|dat)$/.test(ext)) return "Test data";
  if (/^(jpg|jpeg|png|heic|gif|webp)$/.test(ext)) return "Photo";
  return "Other";
}

function fmtSize(bytes: number): string {
  if (!bytes) return "-";
  if (bytes < 1024) return bytes + " B";
  if (bytes < 1024 * 1024) return Math.round(bytes / 1024) + " KB";
  return (bytes / (1024 * 1024)).toFixed(1) + " MB";
}

export default function AttachmentsPanel({ instrumentId, attachments, canEdit, isStaff }: {
  instrumentId: number; attachments: Attachment[]; canEdit: boolean; isStaff: boolean;
}) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [kind, setKind] = useState<string>("");
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState("");
  const [, startTransition] = useTransition();

  const onPick = async (file: File | undefined) => {
    if (!file) return;
    setError("");
    setUploading(true);
    try {
      const blob = await upload(file.name, file, {
        access: "public",
        handleUploadUrl: "/api/upload",
      });
      const k = kind || guessKind(file.name);
      startTransition(() => recordAttachment(instrumentId, { fileName: file.name, kind: k, url: blob.url, size: file.size }));
    } catch (e) {
      setError((e as Error).message || "Upload failed");
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = "";
      setKind("");
    }
  };

  return (
    <div className="card">
      <div style={{ display: "flex", alignItems: "center", marginBottom: 6, gap: 8, flexWrap: "wrap" }}>
        <div className="card-title">Attachments</div>
        {canEdit && (
          <div style={{ marginLeft: "auto", display: "flex", gap: 8, alignItems: "center" }}>
            <select value={kind} onChange={(e) => setKind(e.target.value)} style={{ width: "auto", fontSize: 12 }}>
              <option value="">Auto-detect type</option>
              {ATTACH_KINDS.map((k) => <option key={k}>{k}</option>)}
            </select>
            <button className="btn sm primary" onClick={() => fileRef.current?.click()} disabled={uploading}>
              {uploading ? "Uploading..." : "⬆ Upload file"}
            </button>
            <input ref={fileRef} type="file" style={{ display: "none" }} onChange={(e) => onPick(e.target.files?.[0])} />
          </div>
        )}
      </div>
      <div className="mut" style={{ fontSize: 11, marginBottom: 10 }}>
        Tune files, test data, reports, source photos. Stored permanently and attributed.
      </div>
      {error && <div style={{ fontSize: 12, color: "#A32D2D", marginBottom: 8 }}>{error}</div>}

      {attachments.length === 0 && <div className="mut" style={{ fontSize: 13 }}>No files attached to this system yet.</div>}
      {attachments.map((a) => {
        const m = ATTACH_META[a.kind] || ATTACH_META.Other;
        return (
          <div key={a.id} style={{ display: "flex", alignItems: "center", gap: 10, border: "1px solid var(--line)", borderRadius: 10, padding: "9px 12px", marginBottom: 8, background: "#FAFBFD" }}>
            <div style={{ width: 32, height: 32, borderRadius: 8, background: m.bg, color: m.fg, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 16, flexShrink: 0 }}>{m.glyph}</div>
            <div style={{ minWidth: 0, flex: 1 }}>
              <div className="mono" style={{ fontSize: 13, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{a.fileName}</div>
              <div className="mut" style={{ fontSize: 11, marginTop: 2 }}>
                <span className="pill" style={{ background: m.bg, color: m.fg }}>{a.kind}</span>
                <span style={{ marginLeft: 6 }}>
                  {fmtSize(a.size)} · {a.uploadedBy} · {new Date(a.createdAt).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}
                </span>
              </div>
            </div>
            <a href={a.url} target="_blank" rel="noreferrer" style={{ fontSize: 12, textDecoration: "none", flexShrink: 0 }}>download</a>
            {isStaff && (
              <button
                className="btn link" style={{ color: "#A32D2D", fontSize: 12, flexShrink: 0 }}
                onClick={() => startTransition(() => deleteAttachment(a.id))}
              >remove</button>
            )}
          </div>
        );
      })}
    </div>
  );
}
