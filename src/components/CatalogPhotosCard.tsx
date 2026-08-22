"use client";

import { useMemo, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { upload } from "@vercel/blob/client";
import { clearCatalogPhoto, setCatalogPhoto, setCatalogPhotoFraming } from "@/app/actions";
import { confirmDialog } from "@/components/ui/ConfirmDialog";
import { toast } from "@/components/ui/Toast";
import { stockSrc } from "@/lib/photos";
import { fmtBytes } from "@/lib/storage";
import PhotoThumb from "./PhotoThumb";
import PhotoFramer from "./PhotoFramer";
import { matchesQuery } from "@/lib/search";

export type CatalogEntry = {
  id: number;
  kind: string;          // 'category' | 'asset_type' | 'model'
  assetType: string;
  name: string;
  manufacturer: string;
  hasPhoto: boolean;
  photoFraming: string;
};

const SECTIONS: { kind: string; title: string; blurb: string }[] = [
  { kind: "model", title: "Models", blurb: "The most useful ones: a photo of an SPD-20A tells somebody which box that is." },
  { kind: "asset_type", title: "Module types", blurb: "Stands in for any unit of this type whose model has no photo." },
  { kind: "category", title: "System types", blurb: "Shown on a system nobody has photographed, unless it is a single unit with a photo of its own." },
];

/**
 * What each thing in the catalog looks like.
 *
 * One photo of a Shimadzu SPD-20A is a photo of every SPD-20A anybody will ever
 * file, so it belongs to the catalog rather than to a record. Add it once and it
 * appears on every unit of that model that nobody has photographed - and on none
 * of their file lists, none of their galleries, and nobody's storage bill,
 * because it is not a file on any of those records.
 *
 * A real photo of the actual machine always wins. This is what fills the gap
 * until somebody takes one, and it says so wherever it appears.
 */
export default function CatalogPhotosCard({ entries }: { entries: CatalogEntry[] }) {
  const router = useRouter();
  const input = useRef<HTMLInputElement>(null);
  const target = useRef<number | null>(null);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [filter, setFilter] = useState("");
  const [only, setOnly] = useState<"all" | "missing">("all");
  const [framing, setFraming] = useState<CatalogEntry | null>(null);
  const [pending, startTransition] = useTransition();

  const withPhoto = entries.filter((e) => e.hasPhoto).length;

  const shown = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    return entries.filter((e) => {
      if (only === "missing" && e.hasPhoto) return false;
      if (!needle) return true;
      return matchesQuery(filter, [e.name, e.assetType, e.manufacturer]);
    });
  }, [entries, filter, only]);

  const pick = (id: number) => { target.current = id; input.current?.click(); };

  const send = async (file: File | undefined) => {
    const id = target.current;
    if (!file || id === null) return;
    setError("");
    try {
      setBusy(`${file.name} (${fmtBytes(file.size)})`);
      const blob = await upload(file.name, file, { access: "public", handleUploadUrl: "/api/upload" });
      const res = await setCatalogPhoto(id, { fileName: file.name, url: blob.url, size: file.size });
      if (res?.error) throw new Error(res.error);
      router.refresh();
    } catch (e) {
      setError(`${file.name}: ${(e as Error).message}`);
    } finally {
      setBusy("");
      target.current = null;
    }
  };

  const label = (e: CatalogEntry) =>
    e.kind === "model" ? `${e.manufacturer ? `${e.manufacturer} ` : ""}${e.name}` : e.name;

  return (
    <div className="card">
      <div style={{ display: "flex", alignItems: "baseline", gap: 8, flexWrap: "wrap", marginBottom: 4 }}>
        <div className="card-title" style={{ marginBottom: 0 }}>Catalog photos</div>
        <span className="mut" style={{ fontSize: 12 }}>
          {withPhoto} of {entries.length} {entries.length === 1 ? "entry has" : "entries have"} one
        </span>
      </div>
      <div className="mut" style={{ fontSize: 12, marginBottom: 10 }}>
        A stock photo of the kit itself. It shows on any system or unit of that kind that has no photo of its
        own, and it is not a file on those records - it never reaches their files, their gallery or their storage.
      </div>

      {entries.length > 8 && (
        <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap", marginBottom: 10 }}>
          <input value={filter} onChange={(e) => setFilter(e.target.value)}
            placeholder="Filter by model, type or maker" style={{ flex: "1 1 180px", fontSize: 12 }} />
          <span className="seg">
            {(["all", "missing"] as const).map((w) => (
              <button key={w} aria-pressed={only === w} onClick={() => setOnly(w)}>
                {w === "all" ? "All" : "Without a photo"}
              </button>
            ))}
          </span>
        </div>
      )}

      {busy && <div className="mut" style={{ fontSize: 12, marginBottom: 6 }}>Uploading {busy}</div>}
      {error && <div style={{ fontSize: 12, color: "#A32D2D", marginBottom: 6 }}>{error}</div>}

      <input ref={input} type="file" accept="image/*" style={{ display: "none" }}
        onChange={(e) => { void send(e.target.files?.[0]); e.target.value = ""; }} />

      {SECTIONS.map((s) => {
        const mine = shown.filter((e) => e.kind === s.kind);
        if (!mine.length) return null;
        return (
          <div key={s.kind} style={{ borderTop: "1px solid var(--line)", paddingTop: 10, marginTop: 10 }}>
            <div style={{ fontSize: 13, fontWeight: 700 }}>{s.title}</div>
            <div className="mut" style={{ fontSize: 11, marginBottom: 8 }}>{s.blurb}</div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(124px, 1fr))", gap: 10 }}>
              {mine.map((e) => (
                <div key={e.id} style={{ minWidth: 0 }}>
                  {e.hasPhoto ? (
                    <PhotoThumb src={stockSrc(e.id)} framing={e.photoFraming} alt={label(e)}
                      width="100%" aspect={4 / 3} radius={8} />
                  ) : (
                    <button onClick={() => pick(e.id)} disabled={!!busy || pending}
                      style={{
                        width: "100%", aspectRatio: "4 / 3", border: "1px dashed var(--line)", borderRadius: 8,
                        background: "#F7F9FB", color: "var(--mut)", fontSize: 11, cursor: "pointer",
                      }}>+ photo</button>
                  )}
                  <div style={{ fontSize: 12, fontWeight: 700, marginTop: 4, overflowWrap: "anywhere" }}>{e.name}</div>
                  <div className="mut" style={{ fontSize: 11 }}>
                    {[e.kind === "model" ? e.assetType : "", e.manufacturer].filter(Boolean).join(" · ") || " "}
                  </div>
                  {e.hasPhoto && (
                    <div style={{ display: "flex", gap: 4, flexWrap: "wrap", marginTop: 2 }}>
                      <button className="btn link" style={{ fontSize: 11 }} disabled={!!busy || pending}
                        onClick={() => pick(e.id)}>Replace</button>
                      <button className="btn link" style={{ fontSize: 11 }} disabled={pending}
                        onClick={() => setFraming(e)}>Frame</button>
                      <button className="btn link" style={{ fontSize: 11, color: "#A32D2D" }} disabled={pending}
                        aria-label={`Remove the catalog photo for ${label(e)}`}
                        onClick={async () => {
                          if (!(await confirmDialog({
                            title: `Remove the catalog photo for "${label(e)}"?`,
                            body: "Units of this kind fall back to having no picture.",
                            action: "Remove photo", tone: "bad",
                          }))) return;
                          startTransition(async () => {
                            const res = await clearCatalogPhoto(e.id);
                            setError(res?.error ?? "");
                            if (!res?.error) toast({ message: `Removed the photo for ${label(e)}` });
                          });
                        }}>×</button>
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>
        );
      })}

      {shown.length === 0 && (
        <div className="mut" style={{ fontSize: 12, paddingTop: 8 }}>
          {entries.length === 0 ? "Nothing in the catalog yet." : "Nothing matches."}
        </div>
      )}

      {framing && (
        <PhotoFramer src={stockSrc(framing.id)} framing={framing.photoFraming} alt={label(framing)}
          save={(f) => setCatalogPhotoFraming(framing.id, f)}
          onDone={() => { setFraming(null); router.refresh(); }} />
      )}
    </div>
  );
}
