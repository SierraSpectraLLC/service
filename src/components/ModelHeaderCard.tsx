"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { upload } from "@vercel/blob/client";
import { setCatalogPhoto } from "@/app/actions";
import { stockSrc } from "@/lib/photos";
import { fmtBytes } from "@/lib/storage";

/**
 * The top of a model's page: what it is and what it looks like. The photo is
 * the catalog's stock photo - the same one every unit of the model falls back
 * to - so adding it here is adding it everywhere, exactly like the photos card
 * in Settings does.
 */
export default function ModelHeaderCard({ termId, name, assetType, manufacturer, categories, gases, hasPhoto, unitCount }: {
  termId: number;
  name: string;
  assetType: string;
  manufacturer: string;
  categories: string[];
  gases: string[];
  hasPhoto: boolean;
  unitCount: number;
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
          <div className="eyebrow">{assetType}</div>
          <h1 style={{ margin: "2px 0 2px", fontSize: 24 }}>{name}</h1>
          <div className="mut" style={{ fontSize: 13, marginBottom: 8 }}>
            {manufacturer || "Maker not recorded"}
            {` · ${unitCount} unit${unitCount === 1 ? "" : "s"} in the fleet`}
          </div>
          <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
            {(categories.length ? categories : ["Any system type"]).map((c) => (
              <span key={c} className="pill" style={{ background: "#E7F2FA", color: "#1D6396" }}>{c}</span>
            ))}
            {gases.map((g) => (
              <span key={g} className="pill" style={{ background: "#FAF0DC", color: "#8A5410" }} title="Gas requirement from the catalog">{g}</span>
            ))}
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
