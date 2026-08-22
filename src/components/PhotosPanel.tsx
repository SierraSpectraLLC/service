"use client";

import { useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { upload } from "@vercel/blob/client";
import {
  addCatalogRef, addPhotos, clearCoverPhoto, deleteAttachment, removePhotos, setCoverPhoto, setPhotoFraming,
  type WorkTarget,
} from "@/app/actions";
import Dialog from "@/components/ui/Dialog";
import { toast } from "@/components/ui/Toast";
import { confirmReason } from "@/components/ui/ConfirmDialog";
import { fmtBytes } from "@/lib/storage";
import { coverIsChosen, fileSrc, orderPhotos, photoCount } from "@/lib/photos";
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
 *
 * The catalog's stock photo is deliberately NOT here. It still stands in for the
 * thumbnail at the top of the record, where the job is "which machine is this" -
 * but this section is the evidence somebody gathered about this exact unit, and
 * a picture of the model is not evidence of anything. Listing it here, however
 * carefully labelled, put a photo nobody took in the place people go looking for
 * photos somebody took.
 */
export default function PhotosPanel({
  target, photos, coverId, label, canEdit, storageFull, shared, catalogScopes = [],
}: {
  target: WorkTarget;
  photos: PhotoRow[];
  coverId: number | null;
  /** What this record is, for alt text a screen reader can use. */
  label: string;
  canEdit: boolean;
  storageFull: boolean;
  /** Where a photo may be filed in the catalog - this record's equipment.
      Empty hides the option (nothing to file it against). */
  catalogScopes?: { assetType: string; model: string; label: string }[];
  /** Set when this record pools its photos with the unit/system it is. */
  shared?: string;
}) {
  const router = useRouter();
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [framing, setFraming] = useState<PhotoRow | null>(null);
  // Empty set = not selecting. Clearing fifteen setup shots one confirmation at
  // a time is the thing this replaces, so the whole mode exists to end in one
  // reason and one line of history.
  const [picked, setPicked] = useState<Set<number>>(new Set());
  const [selecting, setSelecting] = useState(false);
  const [pending, startTransition] = useTransition();

  const ordered = orderPhotos(photos, coverId);
  // Filing a photo to the catalog: the picture stays exactly where it is - the
  // reference points at it - so what one engineer learned on this unit shows
  // up on every unit like it without copying a byte or a second storage charge.
  const [filing, setFiling] = useState<null | { id: number; fileName: string }>(null);
  const [fileDraft, setFileDraft] = useState({ scope: 0, title: "", body: "" });
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
      toast({ message: `Added ${done.length} photo${done.length === 1 ? "" : "s"}` });
      router.refresh();
    } catch (e) {
      // Name the file that failed. A silent stop here looks like it worked.
      setError(`${busy || "Upload"}: ${(e as Error).message}`);
    } finally {
      setBusy("");
    }
  };

  const act = (fn: () => Promise<{ error?: string } | void>, message?: string) =>
    startTransition(async () => {
      const err = ((await fn()) as { error?: string })?.error ?? "";
      setError(err);
      if (!err && message) toast({ message });
    });

  const remove = async (p: { id: number; fileName: string }) => {
    const why = await confirmReason({
      title: `Remove "${p.fileName}"?`,
      body: "The file is permanently deleted from storage.",
      action: "Remove", tone: "bad",
    });
    if (!why) return;
    act(() => deleteAttachment(p.id, why), "Removed the photo");
  };

  const toggle = (id: number) => setPicked((s) => {
    const next = new Set(s);
    if (!next.delete(id)) next.add(id);
    return next;
  });

  const stopSelecting = () => { setSelecting(false); setPicked(new Set()); };

  const removePicked = async () => {
    const n = picked.size;
    if (!n) return;
    const why = await confirmReason({
      title: `Remove ${n} photo${n === 1 ? "" : "s"}?`,
      body: `The file${n === 1 ? " is" : "s are"} permanently deleted from storage.`,
      action: `Remove ${n} photo${n === 1 ? "" : "s"}`, tone: "bad",
    });
    if (!why) return;
    const ids = [...picked];
    startTransition(async () => {
      const res = await removePhotos(target, ids, why);
      setError(res?.error ?? "");
      if (!res?.error) { stopSelecting(); toast({ message: `Removed ${n} photo${n === 1 ? "" : "s"}` }); }
    });
  };

  /**
   * One photo. Opens the file normally; while selecting, it is a checkbox
   * instead - the same tile does both jobs, because a separate row of little
   * boxes beside the pictures is a second thing to aim at on a phone.
   */
  const Tile = ({ p, width, height, radius, alt }: {
    p: PhotoRow; width: number; height: number; radius: number; alt: string;
  }) => {
    const on = picked.has(p.id);
    const thumb = <PhotoThumb src={fileSrc(p.id)} framing={p.framing} alt={alt}
      width={width} height={height} radius={radius} />;
    if (!selecting) {
      return (
        <a href={`/api/files/${p.id}`} target="_blank" rel="noreferrer" title={p.fileName}
          style={{ display: "block" }}>{thumb}</a>
      );
    }
    return (
      <button type="button" role="checkbox" aria-checked={on} aria-label={p.fileName}
        onClick={() => toggle(p.id)}
        style={{
          display: "block", padding: 0, border: "none", background: "none", cursor: "pointer",
          position: "relative", lineHeight: 0, borderRadius: radius,
          outline: on ? "3px solid #1D6396" : "3px solid transparent", outlineOffset: 2,
          opacity: on ? 1 : 0.65,
        }}>
        {thumb}
        <span aria-hidden style={{
          position: "absolute", top: 4, left: 4, width: 20, height: 20, borderRadius: 10,
          background: on ? "#1D6396" : "rgba(255,255,255,0.85)",
          color: "#fff", fontSize: 13, lineHeight: "20px", textAlign: "center",
          border: "1px solid #1D6396", fontWeight: 700,
        }}>{on ? "✓" : ""}</span>
      </button>
    );
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
            <span style={{ marginLeft: "auto" }} />
            {ordered.length > 1 && (
              <button className="btn sm" disabled={pending}
                onClick={() => (selecting ? stopSelecting() : setSelecting(true))}>
                {selecting ? "Cancel" : "Select"}
              </button>
            )}
            <button className="btn sm primary"
              disabled={!!busy || storageFull} onClick={() => input.current?.click()}>
              {busy ? "Uploading..." : "+ Add photos"}
            </button>
            <input ref={input} type="file" accept="image/*" multiple style={{ display: "none" }}
              onChange={(e) => { void send(e.target.files); e.target.value = ""; }} />
          </>
        )}
      </div>

      {selecting && (
        <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", marginBottom: 8 }}>
          <span className="mut" style={{ fontSize: 12 }}>
            {picked.size === 0 ? "Tap photos to select" : `${picked.size} selected`}
          </span>
          <button className="btn link" style={{ fontSize: 12 }} disabled={pending}
            onClick={() => setPicked(new Set(ordered.map((p) => p.id)))}>all</button>
          <button className="btn link" style={{ fontSize: 12 }} disabled={pending || picked.size === 0}
            onClick={() => setPicked(new Set())}>none</button>
          <button className="btn sm" style={{ marginLeft: "auto", borderColor: "#E4B4B4", color: "var(--t-bad-fg)" }}
            disabled={pending || picked.size === 0} onClick={removePicked}>
            Remove {picked.size || ""}
          </button>
        </div>
      )}

      {busy && <div className="mut" style={{ fontSize: 12, marginBottom: 6 }}>{busy}</div>}
      {storageFull && canEdit && (
        <div style={{ fontSize: 12, color: "var(--t-bad-fg)", marginBottom: 6 }}>
          Storage is full - remove a file or raise the limit.
        </div>
      )}

      {shared && ordered.length > 0 && (
        <div className="mut" style={{ fontSize: 11, marginBottom: 6 }}>Shared with {shared} - one machine, one set of photos.</div>
      )}

      {ordered.length === 0 ? (
        <div className="mut" style={{ fontSize: 13 }}>No photos yet.</div>
      ) : (
        <div style={{ display: "flex", gap: 12, flexWrap: "wrap", alignItems: "flex-start" }}>
          <div>
            <Tile p={lead} width={240} height={180} radius={10} alt={label} />
            {/* Honest about which picture the rest of the app is showing. An
                unchosen record still displays the catalog's stock photo of the
                model everywhere else, so calling this one "the cover" because
                it happens to be newest would be a lie about the system. */}
            <div className="mut" style={{ fontSize: 11, marginTop: 4, maxWidth: 240, overflowWrap: "anywhere" }}>
              {chosen ? "Cover" : "Newest · no cover chosen"} · {lead.uploadedBy} · {lead.when}
            </div>
            {canEdit && !selecting && (
              <div style={{ display: "flex", gap: 6, marginTop: 4, flexWrap: "wrap" }}>
                {/* Without this the first photo uploaded could never BE the
                    cover: it is the lead, and only the thumbnails carried the
                    button. */}
                {chosen ? (
                  <button className="btn sm" disabled={pending}
                    title="Show the catalog's picture of this model again"
                    onClick={() => act(() => clearCoverPhoto(target), "Cleared the cover photo")}>Use default</button>
                ) : (
                  <button className="btn sm" disabled={pending}
                    onClick={() => act(() => setCoverPhoto(target, lead.id), "Set the cover photo")}>Make cover</button>
                )}
                <button className="btn sm" disabled={pending} onClick={() => setFraming(lead)}>Frame</button>
                {catalogScopes.length > 0 && (
                  <button className="btn sm" disabled={pending}
                    title="File this to the catalog so every unit like this one sees it"
                    onClick={() => { setFileDraft({ scope: 0, title: "", body: "" }); setFiling({ id: lead.id, fileName: lead.fileName }); }}>
                    To catalog
                  </button>
                )}
                <button className="btn sm" disabled={pending} onClick={() => remove(lead)}>Remove</button>
              </div>
            )}
          </div>

          {rest.length > 0 && (
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap", flex: "1 1 200px" }}>
              {rest.map((p) => (
                <div key={p.id} style={{ width: 104 }}>
                  <Tile p={p} width={104} height={78} radius={8} alt={p.fileName} />
                  {canEdit && !selecting && (
                    <div style={{ display: "flex", gap: 4, marginTop: 3, flexWrap: "wrap" }}>
                      <button className="btn link" style={{ fontSize: 11 }} disabled={pending}
                        onClick={() => act(() => setCoverPhoto(target, p.id), "Set the cover photo")}>Cover</button>
                      <button className="btn link" style={{ fontSize: 11 }} disabled={pending}
                        onClick={() => setFraming(p)}>Frame</button>
                      {catalogScopes.length > 0 && (
                        <button className="btn link" style={{ fontSize: 11 }} disabled={pending}
                          title="File this to the catalog so every unit like this one sees it"
                          onClick={() => { setFileDraft({ scope: 0, title: "", body: "" }); setFiling({ id: p.id, fileName: p.fileName }); }}>
                          Catalog
                        </button>
                      )}
                      <button className="btn link" style={{ fontSize: 11, color: "var(--t-bad-fg)" }} disabled={pending}
                        aria-label={`Remove ${p.fileName}`} onClick={() => remove(p)}>×</button>
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {error && <div style={{ fontSize: 12, color: "var(--t-bad-fg)", marginTop: 8 }}>{error}</div>}

      {/* File a photo to the catalog's reference shelf. The note is the point:
          a picture with nothing written on it is a picture nobody can act on. */}
      {filing && (
        <Dialog open onClose={() => setFiling(null)} title="File to the catalog"
          context="The photo stays on this record; the catalog points at it. Everyone working on equipment like this sees it under Reference."
          footer={
            <>
              <span className="dialog-status" />
              <button className="btn" onClick={() => setFiling(null)} disabled={pending}>Cancel</button>
              <button className="btn accent" disabled={pending}
                onClick={() => {
                  const sc = catalogScopes[fileDraft.scope];
                  if (!sc) return;
                  setError("");
                  startTransition(async () => {
                    const res = await addCatalogRef({
                      assetType: sc.assetType, model: sc.model, kind: "note",
                      title: fileDraft.title || filing.fileName,
                      url: fileSrc(filing.id), body: fileDraft.body,
                    });
                    if (res?.error) { setError(res.error); return; }
                    setFiling(null);
                    toast({ message: "Filed the photo to the catalog" });
                    router.refresh();
                  });
                }}>{pending ? "Filing..." : "File it"}</button>
            </>
          }>
            <PhotoThumb src={fileSrc(filing.id)} framing="" alt={filing.fileName}
              width={160} height={110} radius={8} />
            <div style={{ marginTop: 10 }}>
              <label>Filed under</label>
              <select value={fileDraft.scope} aria-label="Filed under"
                onChange={(e) => setFileDraft({ ...fileDraft, scope: parseInt(e.target.value) })}
                style={{ marginBottom: 8 }}>
                {catalogScopes.map((sc, i) => (
                  <option key={`${sc.assetType}|${sc.model}`} value={i}>{sc.label}</option>
                ))}
              </select>
              <label>Title</label>
              <input value={fileDraft.title} placeholder="e.g. H-ESI probe removal"
                onChange={(e) => setFileDraft({ ...fileDraft, title: e.target.value })}
                style={{ marginBottom: 8 }} />
              <label>What the next engineer needs to know</label>
              <textarea value={fileDraft.body} rows={3} style={{ width: "100%", marginBottom: 8 }}
                placeholder="The trick this photo shows"
                onChange={(e) => setFileDraft({ ...fileDraft, body: e.target.value })} />
            </div>
        </Dialog>
      )}

      {framing && (
        <PhotoFramer src={fileSrc(framing.id)} framing={framing.framing} alt={framing.fileName}
          save={(f) => setPhotoFraming(framing.id, f)}
          onDone={() => { setFraming(null); router.refresh(); }} />
      )}
    </div>
  );
}
