"use client";

import { confirmReason } from "@/components/ui/ConfirmDialog";
import { useRef, useState, useTransition } from "react";
import { upload } from "@vercel/blob/client";
import { ATTACH_KINDS, ATTACH_META } from "@/lib/stages";
import { daysUntil, expiryLabel } from "@/lib/gxp";
import { recordAttachments, deleteAttachment, updateAttachment, setAttachmentListed, setAttachmentTask, attachLibraryFile, listLibraryFiles, type WorkTarget } from "@/app/actions";
import Dialog from "@/components/ui/Dialog";
import { toast } from "@/components/ui/Toast";
import { uploadWithRetry, UploadStalledError, type UploadMode } from "@/lib/uploadWithRetry";
import PdfCombiner from "@/components/PdfCombiner";
import StorageMeter from "@/components/StorageMeter";
import type { Quota } from "@/lib/storage";
import { fmtWhen } from "@/lib/when";
import { isPhotoFile, photoCount } from "@/lib/photos";

// No `url`: raw blob URLs never reach the client. Every read goes through
// /api/files/[id], which applies the same authorization as the pages.
type Attachment = {
  id: number; fileName: string; kind: string; description: string; size: number;
  expiresOn: string;
  uploadedBy: string; createdAt: string; showOnListing: boolean;
  /** The task this file is evidence for, if any. */
  taskId: number | null;
};

type Staged = {
  key: string;
  file: File;
  kind: string;
  description: string;
  progress: number;        // 0-100 while uploading
  attempt: number;         // 1 = first try; >1 shown as "retry N"
  mode: UploadMode | "relay"; // compat = no progress events; relay = via our server
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

const isImage = (name: string) => /\.(jpe?g|png|gif|webp|heic|heif|avif)(\?|$)/i.test(name);

function fmtSize(bytes: number): string {
  if (!bytes) return "-";
  if (bytes < 1024) return bytes + " B";
  if (bytes < 1024 * 1024) return Math.round(bytes / 1024) + " KB";
  return (bytes / (1024 * 1024)).toFixed(1) + " MB";
}

// AbortSignal.timeout is missing on older Safari - use a manual controller.
function timedSignal(ms: number): AbortSignal {
  const c = new AbortController();
  setTimeout(() => c.abort(), ms);
  return c.signal;
}

// Trace each leg of the upload path from this browser and report which one
// dies. Leg 1: server -> Blob (config). Leg 2: token minting on our own
// domain. Leg 3: a real tiny PUT from this browser to Blob storage.
// Leg 4: a tiny real relay POST (same-origin, raw bytes).
async function traceUploadPath(): Promise<string> {
  const legs: string[] = [];
  const timed = timedSignal;

  try {
    const res = await fetch("/api/upload", { method: "GET", signal: timed(10_000) });
    const data = (await res.json()) as { ok?: boolean; error?: string };
    legs.push(data.ok ? "server->storage: OK" : `server->storage: FAILED (${data.error})`);
    if (!data.ok) return legs.join(" | ") + " - Vercel Blob config issue, not your connection";
  } catch (e) {
    legs.push(`server->storage check unreachable (${(e as Error).name})`);
  }

  let clientToken = "";
  try {
    const res = await fetch("/api/upload", {
      method: "POST",
      headers: { "content-type": "application/json" },
      signal: timed(10_000),
      body: JSON.stringify({
        type: "blob.generate-client-token",
        payload: { pathname: "diagnostics/ping.txt", callbackUrl: new URL("/api/upload", location.href).href, clientPayload: null, multipart: false },
      }),
    });
    const data = (await res.json()) as { clientToken?: string; error?: string };
    clientToken = data.clientToken || "";
    legs.push(clientToken ? "token minting: OK" : `token minting: FAILED (${data.error || `status ${res.status}`})`);
  } catch (e) {
    legs.push(`token minting: HUNG/BLOCKED (${(e as Error).name})`);
  }

  if (clientToken) {
    try {
      const res = await fetch("https://blob.vercel-storage.com/diagnostics/ping.txt", {
        method: "PUT",
        headers: { authorization: `Bearer ${clientToken}`, "x-api-version": "9" },
        body: "ping",
        signal: timed(10_000),
      });
      legs.push(res.ok ? "browser->storage: OK (!)" : `browser->storage: reachable but rejected (status ${res.status})`);
    } catch (e) {
      legs.push(`browser->storage: BLOCKED (${(e as Error).name})`);
    }
  }

  try {
    const res = await fetch(`/api/upload/relay?filename=${encodeURIComponent("diagnostics/relay-ping.txt")}`, {
      method: "POST",
      headers: { "content-type": "application/octet-stream" },
      body: new Uint8Array([112, 105, 110, 103]), // "ping"
      signal: timed(15_000),
    });
    const d = (await res.json().catch(() => ({}))) as { url?: string; error?: string };
    legs.push(res.ok && d.url ? "server relay: OK" : `server relay: FAILED (${d.error || `status ${res.status}`})`);
  } catch (e) {
    legs.push(`server relay: BLOCKED (${(e as Error).name})`);
  }
  return legs.join(" | ");
}

// Last-resort: push the file through our own server (same-origin, so network
// filters that block the storage domain don't apply). 4 MB cap (Vercel limit).
// The file is read into memory FIRST and sent as raw bytes: Safari's fetch is
// unreliable with File bodies ("Load failed"), especially when the picked
// file's handle has gone stale - reading it up front both avoids that fetch
// path and turns a stale handle into a clear, actionable error.
const RELAY_MAX_BYTES = 4 * 1024 * 1024;
async function relayUpload(file: File): Promise<{ url: string }> {
  let bytes: ArrayBuffer;
  try {
    bytes = await file.arrayBuffer();
  } catch {
    throw new Error("the browser can no longer read this file - remove it from the list and pick it again");
  }
  let lastErr = new Error("relay failed");
  for (let attempt = 1; attempt <= 2; attempt++) {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), 120_000);
    try {
      const res = await fetch(`/api/upload/relay?filename=${encodeURIComponent(file.name)}`, {
        method: "POST",
        headers: { "content-type": "application/octet-stream" },
        body: bytes,
        signal: controller.signal,
      });
      clearTimeout(t);
      const data = (await res.json().catch(() => ({}))) as { url?: string; error?: string };
      if (!res.ok || !data.url) throw new Error(data.error || `status ${res.status}`);
      return { url: data.url };
    } catch (e) {
      clearTimeout(t);
      lastErr = e as Error;
      if (attempt === 1) await new Promise((r) => setTimeout(r, 2000));
    }
  }
  throw lastErr;
}

export default function AttachmentsPanel({ target, attachments, canEdit, isStaff, listingCuration = false, evidenceTasks = [], combineTitle = "", combineLines = [], storage, today = "" }: {
  target: WorkTarget; attachments: Attachment[]; canEdit: boolean; isStaff: boolean;
  /** Shop-day for the expiry chips; "" hides them (public/legacy mounts). */
  today?: string;
  /** The store these files land in - the record owner's. Surfaced when tight. */
  storage?: Quota & { storeName: string };
  /** Prefills for the PDF combiner's cover page. */
  combineTitle?: string; combineLines?: string[];
  // Tasks a file can be filed against as its report. A mandatory test needs one
  // before anything can be signed off, so the picker highlights those.
  evidenceTasks?: { id: number; title: string; required: boolean }[];
  // True when the system is for sale AND the viewer may curate its listing
  // (staff or the owning org's editors): each file gets a show-on-listing toggle.
  listingCuration?: boolean;
}) {
  // Photos live in the Photos section and are listed only there. They are still
  // ordinary attachments underneath - one row, one charge against the quota -
  // but a system with fifteen setup photos buried its four documents, and
  // removing one from here cost an activity entry for a picture nobody meant to
  // file. The section that shows photos is the section that manages them.
  const docs = attachments.filter((a) => !isPhotoFile(a));
  const photos = attachments.length - docs.length;

  const fileRef = useRef<HTMLInputElement>(null);
  const [staged, setStaged] = useState<Staged[]>([]);
  const [uploading, setUploading] = useState(false);
  const [editing, setEditing] = useState<number | null>(null);
  const [editDraft, setEditDraft] = useState({ fileName: "", kind: "Other", description: "", expiresOn: "" });
  // null = picker closed. "loading" while the library is being fetched - it is
  // pulled on demand rather than shipped with every record page.
  type LibFile = { id: number; fileName: string; kind: string; description: string; size: number };
  const [library, setLibrary] = useState<"loading" | LibFile[] | null>(null);
  const [libraryError, setLibraryError] = useState("");
  const [pending, startTransition] = useTransition();

  const openLibrary = () => {
    setLibrary("loading"); setLibraryError("");
    startTransition(async () => {
      try { setLibrary((await listLibraryFiles()).files); }
      catch (e) { setLibrary([]); setLibraryError((e as Error).message || "Couldn't load the library"); }
    });
  };

  const addFiles = (list: FileList | null) => {
    if (!list) return;
    const next = Array.from(list).map((file) => ({
      key: `${file.name}-${file.size}-${file.lastModified}`,
      file, kind: guessKind(file.name), description: "", progress: 0, attempt: 1, mode: "progress" as const, state: "staged" as const,
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
      patch(s.key, { state: "uploading", progress: 0, attempt: 1, mode: "progress", error: undefined });
      // Small files get ONE direct attempt then fall through to the server
      // relay fast - no point burning minutes on compat retries when the
      // same-origin relay is the reliable path on blocked networks. Large
      // files can't relay (4 MB request cap), so they walk the full ladder
      // (progress -> compat) with a size-aware timeout.
      const canRelay = s.file.size <= RELAY_MAX_BYTES;
      try {
        const blob = await uploadWithRetry({
          // Retry the whole file on a stall/error with a fresh connection. If
          // the first attempt never starts, later attempts run in "compat"
          // mode: no progress reporting, which makes the SDK send a plain
          // non-streaming body that survives HTTP/1.1 network paths
          // (VPNs, TLS-inspecting middleboxes) where streaming uploads die.
          maxAttempts: canRelay ? 1 : 3,
          compatTimeoutMs: Math.min(8 * 60_000, Math.max(90_000, (s.file.size / (20 * 1024)) * 1000)),
          onProgress: (pct) => patch(s.key, { progress: pct }),
          onAttempt: (attempt, mode) => patch(s.key, { attempt, mode, progress: 0 }),
          uploadFn: (signal, onProgress, mode) =>
            upload(s.file.name, s.file, {
              access: "public",
              handleUploadUrl: "/api/upload",
              // Multipart (parts uploaded in parallel, each retried) only helps
              // above the SDK's 8MB part size; below that a plain PUT is simpler
              // and has less to go wrong.
              multipart: s.file.size > 8 * 1024 * 1024,
              abortSignal: signal,
              // Requesting progress forces the streaming transport - omit it
              // entirely in compat mode.
              ...(mode === "progress"
                ? { onUploadProgress: ({ percentage }: { percentage: number }) => onProgress(Math.round(percentage)) }
                : {}),
            }),
        });
        patch(s.key, { state: "done", progress: 100 });
        done.push({ fileName: s.file.name, kind: s.kind, url: blob.url, size: s.file.size, description: s.description });
      } catch (e) {
        // Direct upload exhausted its retries. Before failing, try the server
        // relay - it uses only same-origin requests, so it works on networks
        // that block the storage domain from the browser.
        if (canRelay) {
          try {
            patch(s.key, { mode: "relay", attempt: 1, progress: 0 });
            const blob = await relayUpload(s.file);
            patch(s.key, { state: "done", progress: 100 });
            done.push({ fileName: s.file.name, kind: s.kind, url: blob.url, size: s.file.size, description: s.description });
            continue;
          } catch (relayErr) {
            patch(s.key, {
              state: "failed",
              error: `Direct upload and server relay both failed. Relay: ${(relayErr as Error).name}: ${(relayErr as Error).message}. Trace: ${await traceUploadPath()}. If this happens on every network, the cause is on this device/browser - a content blocker, iCloud Private Relay, or a security app; try once in a different browser to confirm.`,
            });
            continue;
          }
        }
        let error: string;
        if (e instanceof UploadStalledError) {
          const head = e.gotProgress ? "Upload stalled mid-transfer after 3 tries" : "Upload could not get through after 3 tries";
          error = `${head}, and the file is too large for the 4 MB server relay. Trace: ${await traceUploadPath()}`;
        } else {
          // Real SDK error, e.g. token/config problems ("Failed to retrieve the client token").
          error = (e as Error).message || "Upload failed";
        }
        patch(s.key, { state: "failed", error });
      }
    }
    if (done.length) {
      const doneNames = new Set(done.map((d) => d.fileName));
      startTransition(async () => {
        await recordAttachments(target, done);
        toast({ message: `Uploaded ${done.length} file${done.length === 1 ? "" : "s"}` });
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
          <div style={{ marginLeft: "auto", display: "flex", gap: 6, alignItems: "center" }}>
            {isStaff && (
              <button className="btn sm" onClick={openLibrary} disabled={uploading}>
                From library
              </button>
            )}
            <button className="btn sm primary" onClick={() => fileRef.current?.click()} disabled={uploading}>
              + Add files
            </button>
            <input ref={fileRef} type="file" multiple style={{ display: "none" }} onChange={(e) => addFiles(e.target.files)} />
          </div>
        )}
      </div>

      {/* Whose storage these land in, and how much is left. Shown here because
          this is where the bytes arrive - a meter only on the library page would
          be a bill with no itemization. */}
      {storage && (storage.state === "warn" || storage.state === "full") && (
        <div style={{ marginBottom: 10 }}>
          <StorageMeter quota={storage} name={storage.storeName} />
        </div>
      )}

      {library !== null && (
        <Dialog open onClose={() => setLibrary(null)} title="Document library"
          context="Files on the shop's shelf; filing one here leaves the library's copy in place."
          footer={
            <>
              <span className={`dialog-status${libraryError ? " err" : ""}`}>{libraryError}</span>
              <button className="btn" onClick={() => setLibrary(null)}>Close</button>
            </>
          }>
          {library === "loading" && <div className="mut t-small">Loading…</div>}
          {Array.isArray(library) && library.length === 0 && (
            <div className="mut t-small">
              The library is empty. Files land there from the PDF studio, or from an upload with no record.
            </div>
          )}
          {Array.isArray(library) && library.map((f) => (
            <div key={f.id} style={{ display: "flex", gap: 8, alignItems: "baseline", padding: "5px 0", borderTop: "1px solid var(--line)" }}>
              <button className="btn link" style={{ fontSize: 12, fontWeight: 700, flexShrink: 0 }} disabled={pending}
                onClick={() => startTransition(async () => {
                  const res = await attachLibraryFile(target, f.id);
                  setLibraryError(res?.error ?? "");
                  if (!res?.error) { setLibrary(null); toast({ message: `Filed ${f.fileName}` }); }
                })}>+ file it here</button>
              <span className="mono t-small" style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
                title={f.description || f.fileName}>{f.fileName}</span>
              <span className="mut t-meta" style={{ marginLeft: "auto", flexShrink: 0 }}>{fmtSize(f.size)}</span>
            </div>
          ))}
        </Dialog>
      )}

      {staged.length > 0 && (
        <div className="dash-form" style={{ marginBottom: 12 }}>
          <div className="panel-head" style={{ marginBottom: 8 }}>
            <span className="card-title" style={{ fontSize: 14 }}>Ready to upload</span>
            <span className="pill neutral">{staged.length}</span>
          </div>
          {staged.map((s) => (
            <div key={s.key} style={{ marginBottom: 10, borderBottom: "1px solid var(--line)", paddingBottom: 8 }}>
              <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                <span className="mono t-small" style={{ fontWeight: 700, flex: "1 1 160px", minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {s.file.name}
                </span>
                <span className="mut t-meta">{fmtSize(s.file.size)}</span>
                <select value={s.kind} disabled={uploading} onChange={(e) => patch(s.key, { kind: e.target.value })} className="t-small" style={{ width: "auto" }}>
                  {ATTACH_KINDS.map((k) => <option key={k}>{k}</option>)}
                </select>
                {!uploading && (
                  <button className="btn link" style={{ color: "var(--t-bad-fg)" }}
                    onClick={() => setStaged((x) => x.filter((y) => y.key !== s.key))}>remove</button>
                )}
              </div>
              <input value={s.description} disabled={uploading}
                onChange={(e) => patch(s.key, { description: e.target.value })}
                placeholder='Description... e.g. "post-repair tune, passed at 101% of spec"'
                className="t-small" style={{ marginTop: 6, padding: "5px 9px" }} />
              {s.state === "uploading" && (
                <div style={{ marginTop: 6, height: 6, borderRadius: 999, background: "var(--line)", overflow: "hidden" }}>
                  {s.mode === "progress"
                    ? <div style={{ height: "100%", width: `${s.progress}%`, background: "var(--sky)", transition: "width 200ms" }} />
                    : <div className="skeleton" style={{ height: "100%", width: "100%", borderRadius: 999 }} />}
                </div>
              )}
              {s.state === "uploading" && (
                <div className="mut t-meta" style={{ marginTop: 3 }}>
                  {s.mode === "relay"
                    ? "direct upload blocked - sending through the server instead..."
                    : s.mode === "compat"
                      ? `uploading in compatibility mode (no progress on this network)${s.attempt > 1 ? ` · retry ${s.attempt}` : ""}`
                      : `${s.progress}%${s.attempt > 1 ? ` · retry ${s.attempt}` : ""}`}
                </div>
              )}
              {s.state === "done" && <div className="t-meta" style={{ marginTop: 3, color: "var(--t-good-fg)" }}>Uploaded ✓</div>}
              {s.state === "failed" && <div className="t-meta" style={{ marginTop: 3, color: "var(--t-bad-fg)" }}>Failed: {s.error}</div>}
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

      {docs.length === 0 && staged.length === 0 && (
        <div className="mut t-body">No files attached to this system yet.</div>
      )}
      {photos > 0 && (
        <div className="mut t-meta" style={{ marginBottom: 8 }}>
          {photoCount(photos)} in the Photos section.
        </div>
      )}
      {docs.map((a) => {
        const m = ATTACH_META[a.kind] || ATTACH_META.Other;
        if (editing === a.id) {
          return (
            <div key={a.id} style={{ border: "1px solid var(--line)", borderRadius: 10, padding: "9px 12px", marginBottom: 8, background: "#FAFBFD" }}>
              <div style={{ display: "flex", gap: 6, marginBottom: 6, flexWrap: "wrap" }}>
                <input className="mono t-body" value={editDraft.fileName}
                  onChange={(e) => setEditDraft({ ...editDraft, fileName: e.target.value })}
                  style={{ flex: "2 1 180px" }} />
                <select value={editDraft.kind} onChange={(e) => setEditDraft({ ...editDraft, kind: e.target.value })}
                  className="t-small" style={{ width: "auto" }}>
                  {ATTACH_KINDS.map((k) => <option key={k}>{k}</option>)}
                </select>
              </div>
              <input value={editDraft.description}
                onChange={(e) => setEditDraft({ ...editDraft, description: e.target.value })}
                placeholder='Description... e.g. "post-repair tune, passed at 101% of spec"'
                className="t-small" style={{ padding: "5px 9px", marginBottom: 8 }} />
              {/* Validity, for paper that goes stale - a calibration cert, a
                  qualification report. Dated files feed the expiry attention. */}
              <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 8, flexWrap: "wrap" }}>
                <span className="mut t-meta">Valid until</span>
                <input type="date" value={editDraft.expiresOn}
                  onChange={(e) => setEditDraft({ ...editDraft, expiresOn: e.target.value })}
                  className="t-small" style={{ width: "auto", padding: "3px 6px" }} />
                {editDraft.expiresOn && (
                  <button className="btn link" onClick={() => setEditDraft({ ...editDraft, expiresOn: "" })}>never expires</button>
                )}
              </div>
              <div style={{ display: "flex", gap: 8 }}>
                <button className="btn sm accent" disabled={!editDraft.fileName.trim()}
                  onClick={() => startTransition(async () => { await updateAttachment(a.id, editDraft); setEditing(null); toast({ message: "Saved the attachment" }); })}>
                  Save
                </button>
                <button className="btn sm" onClick={() => setEditing(null)}>Cancel</button>
              </div>
            </div>
          );
        }
        return (
          // Wraps rather than crushes: this panel sits in a column that can be
          // 340px wide, and the controls on the right have real minimum widths.
          <div key={a.id} style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", border: "1px solid var(--line)", borderRadius: 10, padding: "9px 12px", marginBottom: 8, background: "#FAFBFD" }}>
            {isImage(a.fileName) ? (
              <a href={`/api/files/${a.id}`} target="_blank" rel="noreferrer" style={{ flexShrink: 0, lineHeight: 0 }}>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={`/api/files/${a.id}`} alt={a.description || a.fileName} loading="lazy"
                  style={{ width: 52, height: 52, objectFit: "cover", borderRadius: 8, border: "1px solid var(--line)", background: "#fff" }} />
              </a>
            ) : (
              <div className="t-title" style={{ width: 32, height: 32, borderRadius: 8, background: `var(--t-${m.tone}-bg)`, color: `var(--t-${m.tone}-fg)`, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>{m.glyph}</div>
            )}
            <div style={{ minWidth: 0, flex: "1 1 190px" }}>
              <div className="mono t-body" style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{a.fileName}</div>
              {a.description && <div className="t-small" style={{ marginTop: 2, overflowWrap: "anywhere" }}>{a.description}</div>}
              <div className="mut t-meta" style={{ marginTop: 2 }}>
                <span className={`pill ${m.tone}`}>{a.kind}</span>
                {a.expiresOn && today && (() => {
                  const days = daysUntil(a.expiresOn, today);
                  const late = days < 0, soon = days >= 0 && days <= 60;
                  return (
                    <span className={`pill ${late ? "bad" : soon ? "warn" : "neutral"}`}
                      title={`Valid until ${a.expiresOn}`} style={{ marginLeft: 4 }}>
                      {expiryLabel(a.expiresOn, today)}</span>
                  );
                })()}
                <span style={{ marginLeft: 6 }}>
                  {fmtSize(a.size)} · {a.uploadedBy} · {fmtWhen(a.createdAt)}
                </span>
              </div>
            </div>
            {canEdit && evidenceTasks.length > 0 && (
              <select value={a.taskId ?? ""} aria-label={`Evidence for, ${a.fileName}`}
                onChange={(e) => {
                  const v = e.target.value ? parseInt(e.target.value) : null;
                  startTransition(async () => { await setAttachmentTask(a.id, v); toast({ message: v ? "Filed as evidence" : "Unlinked from the task" }); });
                }}
                className="t-meta" style={{ width: "auto", minWidth: 0, maxWidth: 150, padding: "1px 4px", flexShrink: 0 }}>
                <option value="">not evidence</option>
                {evidenceTasks.map((t) => (
                  <option key={t.id} value={t.id}>{t.required ? "★ " : ""}{t.title}</option>
                ))}
              </select>
            )}
            {listingCuration && (
              <label className="t-meta" style={{ display: "flex", alignItems: "center", gap: 4, margin: 0, fontWeight: 400, color: a.showOnListing ? "#2E6B2E" : "var(--mut)", flexShrink: 0, textTransform: "none", letterSpacing: 0 }}
                title="Public buyers see this file on the listing page">
                <input type="checkbox" checked={a.showOnListing} style={{ width: 14, height: 14 }}
                  onChange={(e) => { const on = e.target.checked; startTransition(async () => { await setAttachmentListed(a.id, on); toast({ message: on ? "Added to the listing" : "Removed from the listing" }); }); }} />
                on listing
              </label>
            )}
            <a href={`/api/files/${a.id}`} target="_blank" rel="noreferrer" className="t-small" style={{ textDecoration: "none", flexShrink: 0 }}>download</a>
            {canEdit && (
              <button className="btn link" style={{ fontSize: 12, flexShrink: 0 }}
                onClick={() => { setEditDraft({ fileName: a.fileName, kind: a.kind, description: a.description, expiresOn: a.expiresOn }); setEditing(a.id); }}
              >edit</button>
            )}
            {isStaff && (
              <button
                className="btn link" style={{ color: "var(--t-bad-fg)", fontSize: 12, flexShrink: 0 }}
                onClick={async () => {
                  const reason = await confirmReason({
                    title: `Remove "${a.fileName}"?`,
                    body: "The file is permanently deleted from storage.",
                    action: "Remove", tone: "bad",
                  });
                  if (!reason) return;
                  startTransition(async () => { await deleteAttachment(a.id, reason); toast({ message: `Removed ${a.fileName}` }); });
                }}
              >remove</button>
            )}
          </div>
        );
      })}
      {canEdit && (
        <PdfCombiner
          target={target}
          pdfs={attachments.filter((a) => /\.pdf$/i.test(a.fileName)).map((a) => ({ id: a.id, fileName: a.fileName, kind: a.kind }))}
          defaultCover={combineTitle}
          coverLines={combineLines}
        />
      )}
    </div>
  );
}
