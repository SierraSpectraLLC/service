"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { upload } from "@vercel/blob/client";
import { setCatalogPhoto } from "@/app/actions";
import { stockSrc } from "@/lib/photos";
import { fmtBytes } from "@/lib/storage";

/**
 * The model's stock photo - the same one every unit of the model falls back
 * to - so adding it here is adding it everywhere, exactly like the photos card
 * in Settings does. Identity lives in the RecordHero above; this card only
 * holds the photo and its upload affordance.
 */
export default function ModelHeaderCard({ termId, name, hasPhoto }: {
  termId: number;
  name: string;
  hasPhoto: boolean;
}) {
  const router = useRouter();
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState("");
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
      <div className="card-title" style={{ marginBottom: 8 }}>Photo</div>
      <div style={{ display: "flex", gap: 16, flexWrap: "wrap", alignItems: "flex-start" }}>
        <div style={{ flexShrink: 0 }}>
          {hasPhoto ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={stockSrc(termId)} alt={name}
              style={{ width: 132, height: 132, objectFit: "cover", borderRadius: 10, border: "1px solid var(--line)", background: "#F7F9FC" }} />
          ) : (
            <button onClick={() => input.current?.click()} disabled={!!busy}
              style={{
                width: 132, height: 132, borderRadius: 10, border: "1px dashed #C7D2E0", background: "#F7F9FC",
                color: "var(--mut)", fontSize: 12, cursor: "pointer",
              }}>
              {busy ? "Uploading..." : "+ Add a photo"}
              <span style={{ display: "block", fontSize: 10, marginTop: 4 }}>shows on every unit</span>
            </button>
          )}
          <input ref={input} type="file" accept="image/*" hidden
            onChange={(e) => { void send(e.target.files?.[0]); e.target.value = ""; }} />
        </div>
        <div style={{ flex: 1, minWidth: 220 }}>
          <div className="mut" style={{ fontSize: 12 }}>
            The catalog&apos;s stock photo for {name}: it shows on every unit that has no photo of its own.
          </div>
          {hasPhoto && (
            <button className="btn link" style={{ fontSize: 11, marginTop: 8 }} onClick={() => input.current?.click()} disabled={!!busy}>
              {busy ? "Uploading..." : "replace photo"}
            </button>
          )}
          {error && <div style={{ fontSize: 12, color: "#A32D2D", marginTop: 6 }}>{error}</div>}
        </div>
      </div>
    </div>
  );
}
