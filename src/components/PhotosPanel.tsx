"use client";

import { useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { upload } from "@vercel/blob/client";
import {
  addPhotos, deleteAttachment, removePhotos, setPhotoAlbum, setPhotoFraming, type WorkTarget,
} from "@/app/actions";
import Dialog from "@/components/ui/Dialog";
import { toast } from "@/components/ui/Toast";
import { confirmReason, inputDialog } from "@/components/ui/ConfirmDialog";
import { fmtBytes } from "@/lib/storage";
import { ALBUM_SUGGESTIONS, coverIsChosen, fileSrc, groupByAlbum, normalizeAlbum, photoCount } from "@/lib/photos";
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
  /** Blank = in no album. See lib/photos groupByAlbum. */
  album?: string;
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
 * They come in sets - the setup shots, the unit as it arrived - so a photo can
 * sit in an ALBUM, a label on the file that sections this panel. Photos in no
 * album come first, where a fresh upload lands.
 *
 * The COVER is marked here but chosen by tapping the picture at the top of the
 * record (CoverPicker): that is where "which machine is this" is asked, and a
 * Cover button under every tile crowded out the photos on a phone.
 *
 * These are ordinary attachments and appear under Files too. That is the point -
 * one file, one row, one charge against the quota, one authorized way to read it.
 *
 * The catalog's stock photo is deliberately NOT here. It still stands in for the
 * thumbnail at the top of the record, where the job is "which machine is this" -
 * but this section is the evidence somebody gathered about this exact unit, and
 * a picture of the model is not evidence of anything. Filing a photo TO the
 * catalog is done from the Reference section, which is where the catalog lives.
 */
export default function PhotosPanel({
  target, photos, coverId, label, canEdit, storageFull, shared,
}: {
  target: WorkTarget;
  photos: PhotoRow[];
  coverId: number | null;
  /** What this record is, for alt text a screen reader can use. */
  label: string;
  canEdit: boolean;
  storageFull: boolean;
  /** Set when this record pools its photos with the unit/system it is. */
  shared?: string;
}) {
  const router = useRouter();
  const input = useRef<HTMLInputElement>(null);
  // Which album the next upload goes into - set by the button that opened the
  // file picker, so "+ Add" inside an album files straight into it.
  const uploadAlbum = useRef("");
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [framing, setFraming] = useState<PhotoRow | null>(null);
  // Empty set = not selecting. Clearing fifteen setup shots one confirmation at
  // a time is the thing this replaces, so the whole mode exists to end in one
  // reason and one line of history.
  const [picked, setPicked] = useState<Set<number>>(new Set());
  const [selecting, setSelecting] = useState(false);
  // The "put these in an album" dialog: null = closed, else the name typed.
  const [albumDraft, setAlbumDraft] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const sections = groupByAlbum(photos, coverId);
  const albums = sections.map((sec) => sec.album).filter(Boolean);
  const hasCover = coverIsChosen(photos, coverId);

  if (!canEdit && photos.length === 0) return null;

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
      const res = await addPhotos(target, done, uploadAlbum.current);
      if (res?.error) throw new Error(res.error);
      toast({ message: `Added ${done.length} photo${done.length === 1 ? "" : "s"}${uploadAlbum.current ? ` to ${uploadAlbum.current}` : ""}` });
      router.refresh();
    } catch (e) {
      // Name the file that failed. A silent stop here looks like it worked.
      setError(`${busy || "Upload"}: ${(e as Error).message}`);
    } finally {
      setBusy("");
    }
  };

  const pickFiles = (album: string) => { uploadAlbum.current = album; input.current?.click(); };

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

  const stopSelecting = () => { setSelecting(false); setPicked(new Set()); setAlbumDraft(null); };

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

  /** File the picked photos into an album - blank takes them out of one. */
  const movePicked = (album: string) => {
    const ids = [...picked];
    const name = normalizeAlbum(album);
    startTransition(async () => {
      const res = await setPhotoAlbum(target, ids, name);
      setError(res?.error ?? "");
      if (!res?.error) {
        const n = res.moved ?? ids.length;
        stopSelecting();
        toast({ message: name ? `Moved ${photoCount(n)} to ${name}` : `Took ${photoCount(n)} out of their album` });
        router.refresh();
      }
    });
  };

  /** Rename an album: every photo in it, moved to the new name in one act. */
  const renameAlbum = async (from: string, ids: number[]) => {
    const to = normalizeAlbum(await inputDialog({
      title: `Rename "${from}"`, action: "Rename", tone: "primary",
      label: "Album name", initial: from,
    }) ?? "");
    if (!to || to === from) return;
    startTransition(async () => {
      const res = await setPhotoAlbum(target, ids, to);
      setError(res?.error ?? "");
      if (!res?.error) { toast({ message: `Renamed ${from} to ${to}` }); router.refresh(); }
    });
  };

  /**
   * One photo. Opens the file normally; while selecting, it is a checkbox
   * instead - the same tile does both jobs, because a separate row of little
   * boxes beside the pictures is a second thing to aim at on a phone.
   */
  const Tile = ({ p }: { p: PhotoRow }) => {
    const on = picked.has(p.id);
    const isCover = hasCover && p.id === coverId;
    const thumb = (
      <span style={{ display: "block", position: "relative" }}>
        <PhotoThumb src={fileSrc(p.id)} framing={p.framing} alt={isCover ? label : p.fileName}
          width={104} height={78} radius={8} />
        {isCover && <span className="pill info" style={{ position: "absolute", left: 4, bottom: 4, lineHeight: 1.4 }}>Cover</span>}
      </span>
    );
    if (!selecting) {
      return (
        <a href={`/api/files/${p.id}`} target="_blank" rel="noreferrer"
          title={`${p.fileName} · ${p.uploadedBy} · ${p.when}`}
          style={{ display: "block", lineHeight: 0 }}>{thumb}</a>
      );
    }
    return (
      <button type="button" role="checkbox" aria-checked={on} aria-label={p.fileName}
        onClick={() => toggle(p.id)}
        style={{
          display: "block", padding: 0, border: "none", background: "none", cursor: "pointer",
          position: "relative", lineHeight: 0, borderRadius: 8,
          outline: on ? "3px solid #1D6396" : "3px solid transparent", outlineOffset: 2,
          opacity: on ? 1 : 0.65,
        }}>
        {thumb}
        <span aria-hidden className="t-body" style={{
          position: "absolute", top: 4, left: 4, width: 20, height: 20, borderRadius: 10,
          background: on ? "#1D6396" : "rgba(255,255,255,0.85)",
          color: "#fff", lineHeight: "20px", textAlign: "center",
          border: "1px solid #1D6396", fontWeight: 700,
        }}>{on ? "✓" : ""}</span>
      </button>
    );
  };

  const Grid = ({ list }: { list: PhotoRow[] }) => (
    <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
      {list.map((p) => (
        <div key={p.id} style={{ width: 104 }}>
          <Tile p={p} />
          {canEdit && !selecting && (
            <div style={{ display: "flex", gap: 4, marginTop: 3, alignItems: "center" }}>
              <button className="btn link" disabled={pending}
                onClick={() => setFraming(p)}>Frame</button>
              <button className="btn link" style={{ marginLeft: "auto", color: "var(--t-bad-fg)" }} disabled={pending}
                aria-label={`Remove ${p.fileName}`} onClick={() => remove(p)}>×</button>
            </div>
          )}
        </div>
      ))}
    </div>
  );

  const suggestions = [...new Set([...albums, ...ALBUM_SUGGESTIONS])];

  return (
    <div className="card">
      <div style={{ display: "flex", alignItems: "baseline", gap: 8, flexWrap: "wrap", marginBottom: 8 }}>
        <div className="card-title" style={{ marginBottom: 0 }}>Photos</div>
        <span className="mut t-small">
          {photos.length === 0 ? "none yet" : photoCount(photos.length)}
        </span>
        {canEdit && (
          <>
            <span style={{ marginLeft: "auto" }} />
            {photos.length > 0 && (
              <button className="btn sm" disabled={pending}
                onClick={() => (selecting ? stopSelecting() : setSelecting(true))}>
                {selecting ? "Cancel" : "Select"}
              </button>
            )}
            <button className="btn sm primary"
              disabled={!!busy || storageFull} onClick={() => pickFiles("")}>
              {busy ? "Uploading..." : "+ Add photos"}
            </button>
            <input ref={input} type="file" accept="image/*" multiple style={{ display: "none" }}
              onChange={(e) => { void send(e.target.files); e.target.value = ""; }} />
          </>
        )}
      </div>

      {selecting && (
        <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", marginBottom: 8 }}>
          <span className="mut t-small">
            {picked.size === 0 ? "Tap photos to select" : `${picked.size} selected`}
          </span>
          <button className="btn link" disabled={pending}
            onClick={() => setPicked(new Set(photos.map((p) => p.id)))}>all</button>
          <button className="btn link" disabled={pending || picked.size === 0}
            onClick={() => setPicked(new Set())}>none</button>
          <span style={{ marginLeft: "auto" }} />
          <button className="btn sm" disabled={pending || picked.size === 0}
            onClick={() => setAlbumDraft("")}>
            Album…
          </button>
          <button className="btn sm" style={{ borderColor: "#E4B4B4", color: "var(--t-bad-fg)" }}
            disabled={pending || picked.size === 0} onClick={removePicked}>
            Remove {picked.size || ""}
          </button>
        </div>
      )}

      {busy && <div className="mut t-small" style={{ marginBottom: 6 }}>{busy}</div>}
      {storageFull && canEdit && (
        <div className="t-small" style={{ color: "var(--t-bad-fg)", marginBottom: 6 }}>
          Storage is full - remove a file or raise the limit.
        </div>
      )}

      {shared && photos.length > 0 && (
        <div className="mut t-meta" style={{ marginBottom: 6 }}>Shared with {shared} - one machine, one set of photos.</div>
      )}

      {photos.length === 0 ? (
        <div className="mut t-body">No photos yet.</div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          {sections.map((sec) => (
            <section key={sec.album || "(none)"} aria-label={sec.album || "Photos in no album"}>
              {/* A heading only where it separates something: a record with no
                  albums at all reads exactly as it did before albums existed. */}
              {(sec.album || albums.length > 0) && (
                <div style={{ display: "flex", alignItems: "baseline", gap: 8, flexWrap: "wrap", marginBottom: 4 }}>
                  <span className="t-small" style={{ fontWeight: 700 }}>{sec.album || "Not in an album"}</span>
                  <span className="mut t-meta">{photoCount(sec.photos.length)}</span>
                  {selecting && (
                    <button className="btn link" disabled={pending}
                      onClick={() => setPicked((s) => new Set([...s, ...sec.photos.map((p) => p.id)]))}>
                      select these
                    </button>
                  )}
                  {canEdit && !selecting && sec.album && (
                    <>
                      <span style={{ marginLeft: "auto" }} />
                      <button className="btn link" disabled={pending}
                        onClick={() => renameAlbum(sec.album, sec.photos.map((p) => p.id))}>Rename</button>
                      <button className="btn link" disabled={!!busy || storageFull}
                        onClick={() => pickFiles(sec.album)}>+ Add</button>
                    </>
                  )}
                </div>
              )}
              <Grid list={sec.photos} />
            </section>
          ))}
        </div>
      )}

      {error && <div className="t-small" style={{ color: "var(--t-bad-fg)", marginTop: 8 }}>{error}</div>}

      {/* Put the selected photos in an album. Typing a name that does not
          exist yet makes it - an album is only its photos, so there is no
          separate "create album" step to forget. */}
      {albumDraft !== null && (
        <Dialog open onClose={() => setAlbumDraft(null)} title={`Move ${photoCount(picked.size)} to an album`}
          context="Pick an album or type a new name."
          footer={
            <>
              <button className="btn" disabled={pending} onClick={() => setAlbumDraft(null)}>Cancel</button>
              {albums.length > 0 && (
                <button className="btn" disabled={pending} onClick={() => movePicked("")}>
                  Take out of album
                </button>
              )}
              <button className="btn primary" disabled={pending || !normalizeAlbum(albumDraft)}
                onClick={() => movePicked(albumDraft)}>
                {pending ? "Moving..." : `Move to ${normalizeAlbum(albumDraft) || "album"}`}
              </button>
            </>
          }>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 12 }}>
            {suggestions.map((name) => (
              <button key={name} type="button" className="btn sm" disabled={pending}
                aria-pressed={normalizeAlbum(albumDraft).toLowerCase() === name.toLowerCase()}
                onClick={() => setAlbumDraft(name)}>{name}</button>
            ))}
          </div>
          <label>Album name</label>
          <input value={albumDraft} placeholder="e.g. System setup" maxLength={60}
            onChange={(e) => setAlbumDraft(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter" && normalizeAlbum(albumDraft)) movePicked(albumDraft); }} />
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
