"use client";

import Link from "next/link";
import { useMemo, useState, useTransition } from "react";
import { promptReason } from "@/lib/reason";
import { deleteAttachment } from "@/app/actions";
import { fmtBytes } from "@/lib/storage";
import type { Place } from "@/lib/storeGroup";

export type StoreFile = {
  url: string;
  size: number;
  fileName: string;
  description: string;
  kind: string;
  uploadedBy: string;
  when: string;
  places: Place[];
  /** For a shelf file, whose shelf. Null = the operator's. */
  shelfOwnerId: number | null;
};

/**
 * One row per STORED file, with every place it appears. A file on four records
 * is one row here and one charge on the meter - listing it four times would make
 * the page total four times what the store actually holds.
 *
 * Removal is deliberately narrow. Clearing the shelf is how an organization gets
 * out from under a quota, so it needs that. Pulling a report off a system is
 * deleting somebody's evidence, so that stays with the house - and the button is
 * simply absent where the server would refuse rather than there and failing.
 */
export default function StoreFileList({ files, canRemoveShelf, canRemoveRecord }: {
  files: StoreFile[];
  canRemoveShelf: boolean;
  canRemoveRecord: boolean;
}) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState("");
  const [filter, setFilter] = useState("");
  const [where, setWhere] = useState<"all" | "shelf" | "records">("all");

  const shown = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    return files.filter((f) => {
      const onShelf = f.places.some((p) => p.kind === "shelf");
      if (where === "shelf" && !onShelf) return false;
      if (where === "records" && !f.places.some((p) => p.kind !== "shelf")) return false;
      if (!needle) return true;
      const hay = `${f.fileName} ${f.description} ${f.kind} ${f.uploadedBy} ${f.places.map((p) => (p.kind === "shelf" ? "shelf" : p.label)).join(" ")}`;
      return hay.toLowerCase().includes(needle);
    });
  }, [files, filter, where]);

  if (!files.length) {
    return (
      <div className="mut" style={{ fontSize: 13 }}>
        Nothing stored yet. Add a file to the shelf above, upload one on a system or unit,
        or save a packet here from the PDF studio.
      </div>
    );
  }

  const removable = (p: Place) => (p.kind === "shelf" ? canRemoveShelf : canRemoveRecord);

  return (
    <>
      {files.length > 6 && (
        <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap", marginBottom: 8 }}>
          <input value={filter} onChange={(e) => setFilter(e.target.value)}
            placeholder="Filter by name, record or who uploaded it"
            style={{ flex: "1 1 200px", fontSize: 12 }} />
          <span className="seg">
            {(["all", "shelf", "records"] as const).map((w) => (
              <button key={w} aria-pressed={where === w} onClick={() => setWhere(w)}>
                {w === "all" ? "All" : w === "shelf" ? "Shelf" : "On records"}
              </button>
            ))}
          </span>
        </div>
      )}

      {shown.map((f) => (
        <div key={f.url} style={{ display: "flex", gap: 8, alignItems: "baseline", padding: "7px 0", borderTop: "1px solid var(--line)", flexWrap: "wrap" }}>
          <div style={{ minWidth: 0, flex: "1 1 240px" }}>
            <a href={`/api/files/${f.places[0].attachmentId}`} target="_blank" rel="noreferrer"
              className="mono" style={{ fontSize: 13, fontWeight: 600, textDecoration: "none", overflowWrap: "anywhere" }}>
              {f.fileName}
            </a>
            {f.description && <div className="mut" style={{ fontSize: 12 }}>{f.description}</div>}
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center", marginTop: 3 }}>
              {f.places.map((p) => (
                <span key={p.attachmentId} className="pill" style={{ background: "#EEF1F5", color: "#475569", display: "inline-flex", gap: 5, alignItems: "center" }}>
                  {p.kind === "shelf" ? "shelf"
                    : p.kind === "system" ? <Link href={`/instruments/${p.id}`} style={{ textDecoration: "none" }}>{p.label}</Link>
                      : <Link href={`/assets/${p.id}`} style={{ textDecoration: "none" }}>{p.label}</Link>}
                  {removable(p) && (
                    <button className="btn link" style={{ fontSize: 10, color: "#A32D2D" }} disabled={pending}
                      aria-label={`Remove ${f.fileName} from ${p.kind === "shelf" ? "the shelf" : p.label}`}
                      onClick={() => {
                        const scope = f.places.length > 1
                          ? ` It stays on the ${f.places.length - 1} other place${f.places.length === 2 ? "" : "s"} it is filed.`
                          : " The file is permanently deleted from storage.";
                        const why = promptReason(`Remove "${f.fileName}" from ${p.kind === "shelf" ? "the shelf" : p.label}?${scope}`);
                        if (!why) return;
                        startTransition(async () => {
                          const res = await deleteAttachment(p.attachmentId, why);
                          setError(res?.error ?? "");
                        });
                      }}>×</button>
                  )}
                </span>
              ))}
            </div>
          </div>
          <span className="mut" style={{ fontSize: 12, flexShrink: 0 }}>{fmtBytes(f.size)}</span>
          <span className="mut" style={{ fontSize: 11, marginLeft: "auto", flexShrink: 0 }}>{f.uploadedBy} · {f.when}</span>
        </div>
      ))}

      {shown.length === 0 && (
        <div className="mut" style={{ fontSize: 12, paddingTop: 8 }}>No stored file matches.</div>
      )}
      {error && <div style={{ fontSize: 12, color: "#A32D2D", marginTop: 6 }}>{error}</div>}
    </>
  );
}
