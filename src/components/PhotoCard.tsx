"use client";

import { useRef, useState, useTransition } from "react";
import { upload } from "@vercel/blob/client";
import { clearPhoto, setPhoto, type WorkTarget } from "@/app/actions";

/**
 * What the thing looks like.
 *
 * A system's photo is the whole bench - the LC and the MS standing next to each
 * other - and a unit's is that module on its own. Between them they answer the
 * questions a record full of model numbers cannot: is this the one in the corner
 * with the old autosampler, and is what arrived what was described.
 *
 * The picture is served through /api/files/<id> like every other file, so it
 * carries the same authorization: a photo of a client's lab is not public
 * because it happens to be an image.
 */
export default function PhotoCard({ target, photoId, alt, canEdit }: {
  target: WorkTarget;
  /** The attachment the photo lives in, or null for none yet. */
  photoId: number | null;
  alt: string;
  canEdit: boolean;
}) {
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const input = useRef<HTMLInputElement>(null);
  const [pending, startTransition] = useTransition();

  if (!photoId && !canEdit) return null;

  const pick = (file: File | undefined) => {
    if (!file) return;
    setError("");
    startTransition(async () => {
      try {
        setBusy("Uploading...");
        const blob = await upload(file.name, file, { access: "public", handleUploadUrl: "/api/upload" });
        const res = await setPhoto(target, { fileName: file.name, url: blob.url, size: file.size });
        if (res?.error) setError(res.error);
      } catch (e) {
        setError((e as Error).message || "Couldn't upload that.");
      } finally {
        setBusy("");
        if (input.current) input.current.value = "";
      }
    });
  };

  return (
    <div style={{ marginBottom: 10 }}>
      {photoId ? (
        <a href={`/api/files/${photoId}`} target="_blank" rel="noreferrer" style={{ display: "block", lineHeight: 0 }}>
          <img src={`/api/files/${photoId}`} alt={alt} loading="lazy"
            style={{
              display: "block", width: "100%", maxHeight: 260, objectFit: "cover",
              borderRadius: 10, border: "1px solid var(--line)", background: "#EEF1F5",
            }} />
        </a>
      ) : (
        <div className="mut" style={{
          fontSize: 12, textAlign: "center", padding: "18px 10px",
          border: "1px dashed var(--line)", borderRadius: 10,
        }}>No photo yet</div>
      )}

      {canEdit && (
        <div style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 6, flexWrap: "wrap" }}>
          {/* The file input is hidden behind a button: on a phone this opens the
              camera, which is where most of these will actually come from. */}
          <input ref={input} type="file" accept="image/*" capture="environment" style={{ display: "none" }}
            onChange={(e) => pick(e.target.files?.[0])} />
          <button className="btn sm" disabled={pending} onClick={() => input.current?.click()}>
            {busy || (photoId ? "Replace photo" : "Add photo")}
          </button>
          {photoId && (
            <button className="btn link" style={{ fontSize: 11 }} disabled={pending}
              onClick={() => startTransition(async () => { await clearPhoto(target); })}>
              remove
            </button>
          )}
          {photoId && <span className="mut" style={{ fontSize: 11 }}>kept in Files either way</span>}
        </div>
      )}
      {error && <div style={{ fontSize: 12, color: "#A32D2D", marginTop: 6 }}>{error}</div>}
    </div>
  );
}
