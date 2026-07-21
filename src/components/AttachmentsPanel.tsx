"use client";

import { useRef, useState, useTransition } from "react";
import { upload } from "@vercel/blob/client";
import { ATTACH_KINDS, ATTACH_META } from "@/lib/stages";
import { recordAttachments, deleteAttachment } from "@/app/actions";
import { uploadWithRetry } from "@/lib/uploadWithRetry";

type Attachment = {
  id: number; fileName: string; kind: string; description: string; url: string; size: number;
  uploadedBy: string; createdAt: string;
};

type Staged = {
  key: string;
  file: File;
  kind: string;
  description: string;
  progress: number;        // 0-100 while uploading
  attempt: number;         // 1 = first try; >1 shown as "retry N"
  state: "staged" | "uploading" | "done" | "failed";
  error?: string;
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
  const [staged, setStaged] = useState<Staged[]>([]);
  const [uploading, setUploading] = useState(false);
  const [, startTransition] = useTransition();

  const addFiles = (list: FileList | null) => {
    if (!list) return;
    const next = Array.from(list).map((file) => ({
      key: `${file.name}-${file.size}-${file.lastModified}`,
      file, kind: guessKind(file.name), description: "", progress: 0, attempt: 1, state: "staged" as const,
    }));
    setStaged((s) => {
      const have = new Set(s.map((x) => x.key));
      return [...s, ...next.filter((x) => !have.has(x.key))];
    });
    if (fileRef.current) fileRef.current.value = "";
  };

  const patch = (key: string, p: Partial<Staged>) =>
    setStaged((s) => s.map((x) => (x.key === key ? { ...x, ...p } : x)));

  const uploadAll = async () => {
    setUploading(true);
    const done: { fileName: string; kind: string; url: string; size: number; description: string }[] = [];
    // Sequential: predictable on mobile bandwidth, and per-file progress stays honest.
    for (const s of staged) {
      if (s.state === "done") continue;
      patch(s.key, { state: "uploading", progress: 0, attempt: 1, error: undefined });
      try {
        const blob = await uploadWithRetry({
          // Retry the whole file on a stall/error with a fresh connection.
          onProgress: (pct) => patch(s.key, { progress: pct }),
          onAttempt: (attempt) => patch(s.key, { attempt, progress: 0 }),
          uploadFn: (signal, onProgress) =>
            upload(s.file.name, s.file, {
              access: "public",
              handleUploadUrl: "/api/upload",
              // Multipart retries individual parts and is far more resilient on
              // flaky mobile connections; use it for anything non-trivial.
              multipart: s.file.size > 4 * 1024 * 1024,
              abortSignal: signal,
              onUploadProgress: ({ percentage }) => onProgress(Math.round(percentage)),
            }),
        });
        patch(s.key, { state: "done", progress: 100 });
        done.push({ fileName: s.file.name, kind: s.kind, url: blob.url, size: s.file.size, description: s.description });
      } catch (e) {
        const msg = (e as Error).message || "Upload failed";
        patch(s.key, { state: "failed", error: /stall/i.test(msg) ? "Connection stalled after several tries - check signal and retry" : msg });
      }
    }
    if (done.length) {
      const doneNames = new Set(done.map((d) => d.fileName));
      startTransition(async () => {
        await recordAttachments(instrumentId, done);
        // Keep only failed rows staged so they can be retried.
        setStaged((s) => s.filter((x) => !(x.state === "done" && doneNames.has(x.file.name))));
        setUploading(false);
      });
    } else {
      setUploading(false);
    }
  };

  const pendingCount = staged.filter((s) => s.state !== "done").length;

  return (
    <div className="card">
      <div style={{ display: "flex", alignItems: "center", marginBottom: 6, gap: 8, flexWrap: "wrap" }}>
        <div className="card-title">Attachments</div>
        {canEdit && (
          <div style={{ marginLeft: "auto" }}>
            <button className="btn sm primary" onClick={() => fileRef.current?.click()} disabled={uploading}>
              + Add files
            </button>
            <input ref={fileRef} type="file" multiple style={{ display: "none" }} onChange={(e) => addFiles(e.target.files)} />
          </div>
        )}
      </div>
      <div className="mut" style={{ fontSize: 11, marginBottom: 10 }}>
        Tune files, test data, reports, source photos. Stored permanently and attributed.
      </div>

      {staged.length > 0 && (
        <div className="dash-form" style={{ marginBottom: 12 }}>
          <div style={{ fontSize: 12, fontWeight: 700, color: "var(--navy)", marginBottom: 8 }}>
            Ready to upload ({staged.length})
          </div>
          {staged.map((s) => (
            <div key={s.key} style={{ marginBottom: 10, borderBottom: "1px solid var(--line)", paddingBottom: 8 }}>
              <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                <span className="mono" style={{ fontSize: 12, fontWeight: 700, flex: "1 1 160px", minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {s.file.name}
                </span>
                <span className="mut" style={{ fontSize: 11 }}>{fmtSize(s.file.size)}</span>
                <select value={s.kind} disabled={uploading} onChange={(e) => patch(s.key, { kind: e.target.value })} style={{ width: "auto", fontSize: 12 }}>
                  {ATTACH_KINDS.map((k) => <option key={k}>{k}</option>)}
                </select>
                {!uploading && (
                  <button className="btn link" style={{ color: "#A32D2D", fontSize: 11 }}
                    onClick={() => setStaged((x) => x.filter((y) => y.key !== s.key))}>remove</button>
                )}
              </div>
              <input value={s.description} disabled={uploading}
                onChange={(e) => patch(s.key, { description: e.target.value })}
                placeholder='Description... e.g. "post-repair tune, passed at 101% of spec"'
                style={{ marginTop: 6, fontSize: 12, padding: "5px 9px" }} />
              {s.state === "uploading" && (
                <div style={{ marginTop: 6, height: 6, borderRadius: 999, background: "var(--line)", overflow: "hidden" }}>
                  <div style={{ height: "100%", width: `${s.progress}%`, background: "var(--sky)", transition: "width 200ms" }} />
                </div>
              )}
              {s.state === "uploading" && (
                <div className="mut" style={{ fontSize: 11, marginTop: 3 }}>
                  {s.progress}%{s.attempt > 1 ? ` · retry ${s.attempt}` : ""}
                </div>
              )}
              {s.state === "done" && <div style={{ fontSize: 11, marginTop: 3, color: "#2E6B2E" }}>Uploaded ✓</div>}
              {s.state === "failed" && <div style={{ fontSize: 11, marginTop: 3, color: "#A32D2D" }}>Failed: {s.error}</div>}
            </div>
          ))}
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <button className="btn sm accent" onClick={uploadAll} disabled={uploading || pendingCount === 0}>
              {uploading ? "Uploading..." : `Upload ${pendingCount} file${pendingCount === 1 ? "" : "s"}`}
            </button>
            {!uploading && (
              <button className="btn sm" onClick={() => setStaged([])}>Clear</button>
            )}
          </div>
        </div>
      )}

      {attachments.length === 0 && staged.length === 0 && <div className="mut" style={{ fontSize: 13 }}>No files attached to this system yet.</div>}
      {attachments.map((a) => {
        const m = ATTACH_META[a.kind] || ATTACH_META.Other;
        return (
          <div key={a.id} style={{ display: "flex", alignItems: "center", gap: 10, border: "1px solid var(--line)", borderRadius: 10, padding: "9px 12px", marginBottom: 8, background: "#FAFBFD" }}>
            <div style={{ width: 32, height: 32, borderRadius: 8, background: m.bg, color: m.fg, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 16, flexShrink: 0 }}>{m.glyph}</div>
            <div style={{ minWidth: 0, flex: 1 }}>
              <div className="mono" style={{ fontSize: 13, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{a.fileName}</div>
              {a.description && <div style={{ fontSize: 12, marginTop: 2 }}>{a.description}</div>}
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
