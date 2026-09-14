"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { upload } from "@vercel/blob/client";
import { setCatalogPhoto, setCatalogPhotoFraming, setVocabManufacturer } from "@/app/actions";
import { inputDialog } from "@/components/ui/ConfirmDialog";
import { toast } from "@/components/ui/Toast";
import PhotoFramer from "@/components/PhotoFramer";
import PhotoThumb from "@/components/PhotoThumb";
import { stockSrc } from "@/lib/photos";
import { fmtBytes } from "@/lib/storage";

/**
 * The model's stock photo - the same one every unit of the model falls back
 * to - so adding it here is adding it everywhere, exactly like the photos card
 * in Settings does. Identity lives in the RecordHero above; this card only
 * holds the photo and what can be done to it.
 *
 * Framed here as well as uploaded, for the same reason: this is the model's
 * page, and sending somebody to Settings to turn a sideways photo upright is
 * sending them away from the record the photo is of. The tile shows the
 * framing rather than a raw crop, so what is adjusted is what every unit of
 * this model will show (lib/photoFrame).
 */
export default function ModelHeaderCard({ termId, name, hasPhoto, photoFraming = "", manufacturer }: {
  termId: number;
  name: string;
  hasPhoto: boolean;
  /** How the stock photo sits in its tile - "rot,zoom,x,y,aspect". See lib/photoFrame. */
  photoFraming?: string;
  manufacturer: string;
}) {
  const router = useRouter();
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState("");
  const [framing, setFraming] = useState(false);
  const [error, setError] = useState("");

  const send = async (file: File | undefined) => {
    if (!file) return;
    setError("");
    try {
      setBusy(`${file.name} (${fmtBytes(file.size)})`);
      const blob = await upload(file.name, file, { access: "public", handleUploadUrl: "/api/upload" });
      const res = await setCatalogPhoto(termId, { fileName: file.name, url: blob.url, size: file.size });
      if (res?.error) throw new Error(res.error);
      router.refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy("");
    }
  };

  return (
    <div className="card">
      <div className="card-title" style={{ marginBottom: 8 }}>Model</div>
      <div style={{ display: "flex", gap: 16, flexWrap: "wrap", alignItems: "flex-start" }}>
        <div style={{ flexShrink: 0 }}>
          {hasPhoto ? (
            /* Through PhotoThumb, so this tile is the tile: a photo framed
               here looks the same here, on every unit of the model, and in
               the gallery. It used to be a raw cover crop, which showed
               something the framing said it should not. */
            <PhotoThumb src={stockSrc(termId)} framing={photoFraming} alt={name} width={132} height={132} />
          ) : (
            <button onClick={() => input.current?.click()} disabled={!!busy}
              className="t-small"
              style={{
                width: 132, height: 132, borderRadius: 10, border: "1px dashed #C7D2E0", background: "#F7F9FC",
                color: "var(--mut)", cursor: "pointer",
              }}>
              {busy ? "Uploading..." : "+ Add a photo"}
              <span style={{ display: "block", fontSize: 10, marginTop: 4 }}>shows on every unit</span>
            </button>
          )}
          <input ref={input} type="file" accept="image/*" hidden
            onChange={(e) => { void send(e.target.files?.[0]); e.target.value = ""; }} />
        </div>
        <div style={{ flex: 1, minWidth: 220 }}>
          <div className="t-body" style={{ marginBottom: 6 }}>
            Made by <b>{manufacturer || "nobody recorded"}</b>
            <button className="btn link" style={{ marginLeft: 8 }}
              onClick={async () => {
                const next = await inputDialog({
                  title: `Who makes ${name}?`, action: "Save maker", label: "Manufacturer",
                  initial: manufacturer, allowEmpty: true,
                  hint: "Blank files it under Maker not set in the catalog.",
                });
                if (next === null || next === manufacturer) return;
                const res = await setVocabManufacturer(termId, next);
                if (res?.error) { setError(res.error); return; }
                toast({ message: next ? `${name} is made by ${next}` : `Cleared the maker on ${name}` });
                router.refresh();
              }}>{manufacturer ? "change" : "set the maker"}</button>
          </div>
          <div className="mut t-small">
            The catalog&apos;s stock photo for {name}: it shows on every unit that has no photo of its own.
          </div>
          {hasPhoto && (
            <div style={{ display: "flex", gap: 12, flexWrap: "wrap", marginTop: 8 }}>
              <button className="btn link" onClick={() => input.current?.click()} disabled={!!busy}>
                {busy ? "Uploading..." : "replace photo"}
              </button>
              <button className="btn link" onClick={() => setFraming(true)} disabled={!!busy}>
                adjust the frame
              </button>
            </div>
          )}
          {error && <div className="t-small" style={{ color: "var(--t-bad-fg)", marginTop: 6 }}>{error}</div>}
        </div>
      </div>

      {/* The same editor the catalog's photo card opens, saving to the same
          column: turn it upright, zoom, nudge. The file is never rewritten -
          only the four numbers beside it. */}
      {framing && (
        <PhotoFramer src={stockSrc(termId)} framing={photoFraming} alt={name}
          save={(f) => setCatalogPhotoFraming(termId, f)}
          onDone={() => { setFraming(false); router.refresh(); }} />
      )}
    </div>
  );
}
