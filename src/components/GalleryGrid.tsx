"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import PhotoThumb from "./PhotoThumb";
import { fileSrc } from "@/lib/photos";
import type { Place } from "@/lib/storeGroup";

export type GalleryPhoto = {
  /** The attachment to open and to frame by. */
  attachmentId: number;
  url: string;
  fileName: string;
  description: string;
  framing: string;
  uploadedBy: string;
  when: string;
  places: Place[];
  /** True where this photo is the one representing its record. */
  isCover: boolean;
};

/**
 * Every photo in a store, as photographs rather than as filenames.
 *
 * The document library answers "what paperwork do we hold"; a list of
 * `IMG_4021.HEIC` rows answers nothing at all. So this is a wall of pictures,
 * each one linked to the record it belongs to - which is how somebody actually
 * finds the photo they half-remember taking of a pump in March.
 *
 * One stored file appears once even when it is filed on several records, for the
 * same reason it does on the documents page: it was uploaded once and is charged
 * once, and showing it four times would suggest four photos.
 */
export default function GalleryGrid({ photos }: { photos: GalleryPhoto[] }) {
  const [filter, setFilter] = useState("");
  const [only, setOnly] = useState<"all" | "covers">("all");

  const shown = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    return photos.filter((p) => {
      if (only === "covers" && !p.isCover) return false;
      if (!needle) return true;
      const hay = `${p.fileName} ${p.description} ${p.uploadedBy} ${p.places.map((q) => (q.kind === "shelf" ? "shelf" : q.label)).join(" ")}`;
      return hay.toLowerCase().includes(needle);
    });
  }, [photos, filter, only]);

  if (!photos.length) {
    return (
      <div className="mut" style={{ fontSize: 13 }}>
        No photos yet. Add them on a system or a unit and they appear here.
      </div>
    );
  }

  return (
    <>
      {photos.length > 6 && (
        <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap", marginBottom: 10 }}>
          <input value={filter} onChange={(e) => setFilter(e.target.value)}
            placeholder="Filter by name, record or who took it"
            style={{ flex: "1 1 200px", fontSize: 12 }} />
          <span className="seg">
            {(["all", "covers"] as const).map((w) => (
              <button key={w} aria-pressed={only === w} onClick={() => setOnly(w)}>
                {w === "all" ? "All" : "Covers only"}
              </button>
            ))}
          </span>
        </div>
      )}

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(160px, 1fr))", gap: 12 }}>
        {shown.map((p) => (
          <div key={p.url} style={{ minWidth: 0 }}>
            <a href={`/api/files/${p.attachmentId}`} target="_blank" rel="noreferrer"
              title={p.fileName} style={{ display: "block" }}>
              {/* The column is fluid, so the tile keeps its shape rather than
                  its height - and the framing is told that shape, or a sideways
                  photo would sit in a wide box with bars down both sides. */}
              <PhotoThumb src={fileSrc(p.attachmentId)} framing={p.framing} alt={p.description || p.fileName}
                width="100%" aspect={4 / 3} />
            </a>
            <div style={{ display: "flex", gap: 4, flexWrap: "wrap", alignItems: "center", marginTop: 4 }}>
              {p.isCover && <span className="pill" style={{ background: "#E7F2FA", color: "#1D6396" }}>cover</span>}
              {p.places.map((q) => (
                <span key={q.attachmentId} className="pill" style={{ background: "#EEF1F5", color: "#475569" }}>
                  {q.kind === "shelf" ? "shelf"
                    : q.kind === "system" ? <Link href={`/instruments/${q.id}`} style={{ textDecoration: "none" }}>{q.label}</Link>
                      : <Link href={`/assets/${q.id}`} style={{ textDecoration: "none" }}>{q.label}</Link>}
                </span>
              ))}
            </div>
            <div className="mut" style={{ fontSize: 11, marginTop: 2, overflowWrap: "anywhere" }}>
              {p.description || p.fileName}
            </div>
            <div className="mut" style={{ fontSize: 11 }}>{p.uploadedBy} · {p.when}</div>
          </div>
        ))}
      </div>

      {shown.length === 0 && (
        <div className="mut" style={{ fontSize: 12, paddingTop: 8 }}>No photo matches.</div>
      )}
    </>
  );
}
