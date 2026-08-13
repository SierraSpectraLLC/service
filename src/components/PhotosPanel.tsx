"use client";

import { useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { upload } from "@vercel/blob/client";
import { addPhotos, deleteAttachment, setCoverPhoto, type WorkTarget } from "@/app/actions";
import { promptReason } from "@/lib/reason";
import { fmtBytes } from "@/lib/storage";
import { coverIsChosen, orderPhotos, photoCount } from "@/lib/photos";
import PhotoThumb from "./PhotoThumb";
import PhotoFramer from "./PhotoFramer";

export type PhotoRow = {
  id: number;
  fileName: string;
  kind: string;
  framing: string;
  uploadedBy: string;
  when: string;
  createdAt: string;
};

/**
 * What the thing looks like - all of it, not one picture of it.
 *
 * A system's photos are the whole bench and the details somebody went back for:
 * the inlet before it was cleaned, the label on the back, the leak stain under
 * the pump. A unit's are that module. Between them they answer the questions a
 * record full of model numbers cannot - is this the one in the corner with the
 * old autosampler, and is what arrived what was described.
 *
 * One of them leads. The COVER is a pointer on the record rather than a copy of
 * the file, so changing which photo represents a system moves a pointer and
 * touches no storage. Delete the cover and the newest photo takes over: the
 * pointer is a preference, and losing it should cost the preference, not leave
 * the record with no picture at all.
 *
 * These are ordinary attachments and appear under Files too. That is the point -
 * one file, one row, one charge against the quota, one authorized way to read it.
 */
export default function PhotosPanel({ target, photos, coverId, label, canEdit, storageFull }: {
  target: WorkTarget;
  photos: PhotoRow[];
  coverId: number | null;
  /** What this record is, for alt text a screen reader can use. */
  label: string;
  canEdit: boolean;
  storageFull: boolean;
}) {
  const router = useRouter();
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [framing, setFraming] = useState<PhotoRow | null>(null);
  const [pending, startTransition] = useTransition();

  const ordered = orderPhotos(photos, coverId);
  const [lead, ...rest] = ordered;
  const chosen = coverIsChosen(photos, coverId);

  if (!canEdit && ordered.length === 0) return null;

  const send = async (list: FileList | null) => {
    const files = Array.from(list ?? []);
    if (!files.length) return;
    setError("");
    const done: { fileName: string; url: string; size: number }[] = [];
    try {
      for (const f of files) {
        setBusy(`${f.name} (${fmtBytes(f.size)})`);
        const blob = await upload(f.name, f, { access: "public", handleUploadUrl: "/api/upload" });
        done.push({ fileName: f.name, url: blob.url, size: f.size });
      }
      const res = await addPhotos(target, done);
      if (res?.error) throw new Error(res.error);
      router.refresh();
    } catch (e) {
      // Name the file that failed. A silent stop here looks like it worked.
      setError(`${busy || "Upload"}: ${(e as Error).message}`);
    } finally {
      setBusy("");
    }
  };

  const act = (fn: () => Promise<{ error?: string } | void>) =>
    startTransition(async () => { setError(((await fn()) as { error?: string })?.error ?? ""); });

  const remove = (p: { id: number; fileName: string }) => {
    const why = promptReason(`Remove "${p.fileName}"? The file is permanently deleted from storage.`);
    if (!why) return;
    act(() => deleteAttachment(p.id, why));
  };

  return (
    <div className="card">
      <div style={{ display: "flex", alignItems: "baseline", gap: 8, flexWrap: "wrap", marginBottom: 8 }}>
        <div className="card-title" style={{ marginBottom: 0 }}>Photos</div>
        <span className="mut" style={{ fontSize: 12 }}>
          {ordered.length === 0 ? "none yet" : photoCount(ordered.length)}
        </span>
        {canEdit && (
          <>
            <button className="btn sm primary" style={{ marginLeft: "auto" }}
              disabled={!!busy || storageFull} onClick={() => input.current?.click()}>
              {busy ? "Uploading..." : "+ Add photos"}
            </button>
            <input ref={input} type="file" accept="image/*" multiple style={{ display: "none" }}
              onChange={(e) => { void send(e.target.files); e.target.value = ""; }} />
          </>
        )}
      </div>

      {busy && <div className="mut" style={{ fontSize: 12, marginBottom: 6 }}>{busy}</div>}
      {storageFull && canEdit && (
        <div style={{ fontSize: 12, color: "#A32D2D", marginBottom: 6 }}>
          Storage is full - remove a file or raise the limit.
        </div>
      )}

      {ordered.length === 0 ? (
        <div className="mut" style={{ fontSize: 13 }}>
          No photos yet. Phone photos are fine - they can be turned upright and zoomed here.
        </div>
      ) : (
        <div style={{ display: "flex", gap: 12, flexWrap: "wrap", alignItems: "flex-start" }}>
          <div>
            <a href={`/api/files/${lead.id}`} target="_blank" rel="noreferrer" style={{ display: "block" }}>
              <PhotoThumb attachmentId={lead.id} framing={lead.framing} alt={label} width={240} height={180} />
            </a>
            <div className="mut" style={{ fontSize: 11, marginTop: 4, maxWidth: 240, overflowWrap: "anywhere" }}>
              {chosen ? "Cover" : "Cover (newest, not chosen)"} · {lead.uploadedBy} · {lead.when}
            </div>
            {canEdit && (
              <div style={{ display: "flex", gap: 6, marginTop: 4 }}>
                <button className="btn sm" disabled={pending} onClick={() => setFraming(lead)}>Frame</button>
                <button className="btn sm" disabled={pending} onClick={() => remove(lead)}>Remove</button>
              </div>
            )}
          </div>

          {rest.length > 0 && (
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap", flex: "1 1 200px" }}>
              {rest.map((p) => (
                <div key={p.id} style={{ width: 104 }}>
                  <a href={`/api/files/${p.id}`} target="_blank" rel="noreferrer" title={p.fileName}
                    style={{ display: "block" }}>
                    <PhotoThumb attachmentId={p.id} framing={p.framing} alt={p.fileName}
                      width={104} height={78} radius={8} />
                  </a>
                  {canEdit && (
                    <div style={{ display: "flex", gap: 4, marginTop: 3, flexWrap: "wrap" }}>
                      <button className="btn link" style={{ fontSize: 11 }} disabled={pending}
                        onClick={() => act(() => setCoverPhoto(target, p.id))}>Cover</button>
                      <button className="btn link" style={{ fontSize: 11 }} disabled={pending}
                        onClick={() => setFraming(p)}>Frame</button>
                      <button className="btn link" style={{ fontSize: 11, color: "#A32D2D" }} disabled={pending}
                        aria-label={`Remove ${p.fileName}`} onClick={() => remove(p)}>×</button>
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {error && <div style={{ fontSize: 12, color: "#A32D2D", marginTop: 8 }}>{error}</div>}

      {framing && (
        <PhotoFramer attachmentId={framing.id} framing={framing.framing} alt={framing.fileName}
          onDone={() => { setFraming(null); router.refresh(); }} />
      )}
    </div>
  );
}
