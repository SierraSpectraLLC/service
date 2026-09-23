"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { clearCoverPhoto, setCoverPhoto, setPhotoFraming, type WorkTarget } from "@/app/actions";
import Dialog from "@/components/ui/Dialog";
import { toast } from "@/components/ui/Toast";
import { fileSrc, orderPhotos } from "@/lib/photos";
import PhotoThumb from "./PhotoThumb";
import PhotoFramer from "./PhotoFramer";

export type CoverChoice = { id: number; fileName: string; framing: string; createdAt: string };

/**
 * The picture at the top of a record, and the one place its cover is chosen
 * and framed.
 *
 * The cover is the answer to "which machine is this", so it is set where that
 * question is asked rather than by a button under every tile in Photos, where
 * it competed with the photos themselves for room on a phone. Framing lives
 * here too: the cover is the photo that gets cropped into tiles across the app.
 *
 * Hovering the picture offers Replace and Frame; without a hover (a phone) the
 * first tap shows them. Frame only appears on a photo somebody took - the
 * catalog's stand-in is framed in the catalog.
 *
 * Read-only viewers, and records with nothing photographed yet, get the plain
 * picture: there is nothing to choose between. Rendered in RecordHero's image
 * slot, so it wears the hero's own image class.
 */
export default function CoverPicker({
  target, src, framing, alt, photos, coverId, canEdit,
}: {
  target: WorkTarget;
  /** What shows now: the cover, the catalog's stand-in, or blank for neither. */
  src: string;
  /** How that picture sits in its box. See lib/photoFrame. */
  framing: string;
  alt: string;
  photos: CoverChoice[];
  coverId: number | null;
  canEdit: boolean;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [acts, setActs] = useState(false);
  const [framingOpen, setFramingOpen] = useState(false);
  const [error, setError] = useState("");
  const [pending, startTransition] = useTransition();
  const picking = canEdit && photos.length > 0;
  const cover = coverId !== null ? photos.find((p) => p.id === coverId) ?? null : null;

  if (!src && !picking) return null;

  const picture = src
    ? (
      <span className="rhero-img" style={{ display: "block", overflow: "hidden" }}>
        <PhotoThumb src={src} framing={framing} alt={alt} width="100%" aspect={1} radius={0}
          style={{ border: "none", height: "100%" }} />
      </span>
    )
    : <span className="rhero-img empty">Choose cover</span>;
  if (!picking) return picture;

  const replace = () => { setActs(false); setError(""); setOpen(true); };

  const run = (fn: () => Promise<{ error?: string }>, message: string) =>
    startTransition(async () => {
      const err = (await fn())?.error ?? "";
      setError(err);
      if (!err) { setOpen(false); toast({ message }); }
    });

  return (
    <>
      <span className={`rhero-cover${acts ? " open" : ""}`}
        onMouseLeave={() => setActs(false)}>
        {/* Nothing to frame yet: the picture goes straight to the chooser. */}
        <button type="button" className="rhero-pick" aria-label={`Cover photo of ${alt}`}
          aria-expanded={cover ? acts : undefined}
          onClick={() => (cover ? setActs((v) => !v) : replace())}>
          {picture}
        </button>
        {cover && (
          <span className="rhero-cover-acts">
            <button type="button" onClick={replace}>Replace</button>
            <button type="button" onClick={() => { setActs(false); setFramingOpen(true); }}>Frame</button>
          </span>
        )}
      </span>

      {framingOpen && cover && (
        <PhotoFramer src={fileSrc(cover.id)} framing={cover.framing} alt={cover.fileName}
          save={(f) => setPhotoFraming(cover.id, f)}
          onDone={() => { setFramingOpen(false); router.refresh(); }} />
      )}

      {open && (
        <Dialog open onClose={() => setOpen(false)} title="Cover photo"
          context="The picture that represents this record everywhere it is listed."
          footer={
            <>
              {error && <span className="t-small" style={{ color: "var(--t-bad-fg)", marginRight: "auto" }}>{error}</span>}
              {coverId !== null && (
                <button className="btn" disabled={pending}
                  title="Show the catalog's picture of this model again"
                  onClick={() => run(() => clearCoverPhoto(target), "Cleared the cover photo")}>
                  Use catalog photo
                </button>
              )}
              <button className="btn" disabled={pending} onClick={() => setOpen(false)}>Cancel</button>
            </>
          }>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            {orderPhotos(photos.map((p) => ({ ...p, kind: "Photo" })), coverId).map((p) => {
              const on = p.id === coverId;
              return (
                <button key={p.id} type="button" disabled={pending || on} title={p.fileName}
                  aria-pressed={on} aria-label={on ? `${p.fileName} (current cover)` : `Make ${p.fileName} the cover`}
                  onClick={() => run(() => setCoverPhoto(target, p.id), "Set the cover photo")}
                  style={{
                    display: "block", padding: 0, border: "none", background: "none", cursor: on ? "default" : "pointer",
                    position: "relative", lineHeight: 0, borderRadius: 8,
                    outline: on ? "3px solid var(--link)" : "3px solid transparent", outlineOffset: 2,
                  }}>
                  <PhotoThumb src={fileSrc(p.id)} framing={p.framing} alt={p.fileName} width={104} height={78} radius={8} />
                  {on && <span className="pill info" style={{ position: "absolute", left: 4, bottom: 4, lineHeight: 1.4 }}>Cover</span>}
                </button>
              );
            })}
          </div>
        </Dialog>
      )}
    </>
  );
}
