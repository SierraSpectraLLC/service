"use client";

import Link from "next/link";
import { useMemo, useState, useTransition } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { promptReason } from "@/lib/reason";
import {
  createFolder, deleteAttachment, deleteFolder, moveFilesToFolder, renameFolder,
} from "@/app/actions";
import { childrenOf, folderPath, type FolderLike } from "@/lib/folders";
import { fmtBytes } from "@/lib/storage";
import { isPhotoFile } from "@/lib/photos";
import { ATTACH_META } from "@/lib/stages";
import type { Place } from "@/lib/storeGroup";

export type StoreFile = {
  url: string;
  size: number;
  fileName: string;
  description: string;
  kind: string;
  uploadedBy: string;
  when: string;
  /** Sortable form of `when`; the display string is not orderable. */
  at: number;
  places: Place[];
  /** For a shelf file, whose shelf. Null = the operator's. */
  shelfOwnerId: number | null;
  /** Which folder holds it, for a loose file. Null = the root. */
  folderId: number | null;
};

export type StoreFolder = FolderLike;

type SortKey = "name" | "size" | "when" | "where";

const onShelf = (f: StoreFile) => f.places.some((p) => p.kind === "shelf");
const glyph = (f: StoreFile) => ATTACH_META[f.kind] ?? ATTACH_META.Other;

/**
 * A file store, read the way people read a drive.
 *
 * This used to be a list of rows each led by the RECORDS it was filed on, which
 * quietly answered a question nobody asked and hid the one they did. A client
 * declined to upload anything here at all - not because they could not, but
 * because the page looked like filing something would clutter their systems.
 * That is a reasonable reading of what was on screen, and it cost real files.
 *
 * So: name first, then where it is, sorted and selectable, with "not on any
 * system" said in words rather than left as the absence of a chip. Everything
 * that made it read as a report - the record chips leading each row, the
 * jargon word "shelf" - is either gone or demoted behind the file itself.
 *
 * One row per STORED file, still: a file on four records is one row and one
 * charge on the meter, because listing it four times would make the page total
 * four times what the store actually holds.
 */
export default function StoreFileList({
  files, folders = [], storeOrgId = null, openFolderId = null, canOrganise = false,
  canRemoveShelf, canRemoveRecord, emptyNote,
}: {
  files: StoreFile[];
  /** The store's folders. Empty means this list is browsed flat. */
  folders?: StoreFolder[];
  /** Whose store, for creating folders in it. */
  storeOrgId?: number | null;
  /** The folder the URL says is open. Null = the top level. */
  openFolderId?: number | null;
  canOrganise?: boolean;
  canRemoveShelf: boolean;
  canRemoveRecord: boolean;
  emptyNote?: string;
}) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState("");
  const [filter, setFilter] = useState("");
  const [where, setWhere] = useState<"all" | "shelf" | "records">("all");
  const [view, setView] = useState<"list" | "grid">("list");
  const [sort, setSort] = useState<{ key: SortKey; desc: boolean }>({ key: "when", desc: true });
  const [picked, setPicked] = useState<Set<string>>(new Set());
  // Which folder is open lives in the URL rather than in state: it makes a
  // folder a place you can link somebody to and the back button work, and it
  // is how the upload button - which sits outside this component - knows where
  // a drop should land.
  const router = useRouter();
  const params = useSearchParams();
  const at = openFolderId;
  const setAt = (id: number | null) => {
    const q = new URLSearchParams(params.toString());
    if (id === null) q.delete("folder"); else q.set("folder", String(id));
    router.push(q.size ? `/documents?${q}` : "/documents", { scroll: false });
  };
  const [naming, setNaming] = useState(false);
  const [newName, setNewName] = useState("");
  const [moveOpen, setMoveOpen] = useState(false);

  const here = childrenOf(folders, at);
  const trail = folderPath(folders, at);
  // Searching looks through the whole store rather than the open folder: not
  // finding a file you know you have, because you were standing in the wrong
  // folder, is the thing search exists to prevent.
  const searching = filter.trim().length > 0;

  const shown = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    const hit = files.filter((f) => {
      // In a folder, show that folder. Searching, show the store.
      if (!searching && folders.length > 0 && (f.folderId ?? null) !== at) return false;
      if (where === "shelf" && !onShelf(f)) return false;
      if (where === "records" && !f.places.some((p) => p.kind !== "shelf")) return false;
      if (!needle) return true;
      const hay = `${f.fileName} ${f.description} ${f.kind} ${f.uploadedBy} ${f.places.map((p) => (p.kind === "shelf" ? "" : p.label)).join(" ")}`;
      return hay.toLowerCase().includes(needle);
    });
    const dir = sort.desc ? -1 : 1;
    return [...hit].sort((a, b) => {
      switch (sort.key) {
        case "name": return dir * a.fileName.localeCompare(b.fileName, undefined, { sensitivity: "base" });
        case "size": return dir * (a.size - b.size);
        case "where": return dir * (Number(onShelf(a)) - Number(onShelf(b)));
        default: return dir * (a.at - b.at);
      }
    });
  }, [files, filter, where, sort, at, folders, searching]);

  if (!files.length) {
    return (
      <div className="mut" style={{ fontSize: 13, padding: "18px 0", textAlign: "center" }}>
        {emptyNote ?? "No files yet. Drop one anywhere on this page, or use Upload above."}
      </div>
    );
  }

  const removable = (p: Place) => (p.kind === "shelf" ? canRemoveShelf : canRemoveRecord);
  const toggle = (url: string) =>
    setPicked((s) => { const n = new Set(s); if (n.has(url)) n.delete(url); else n.add(url); return n; });

  // Bulk removal is deliberately only your own copies. A report on somebody's
  // system is their evidence, and sweeping a dozen of those away behind one
  // confirmation is not a thing this page should make easy - so the count says
  // exactly how many of the selection will actually go.
  const sweepable = shown.filter((f) => picked.has(f.url) && canRemoveShelf && onShelf(f));

  const head = (key: SortKey, label: string, extra: React.CSSProperties = {}) => (
    <button className="btn link" style={{ fontSize: 11, fontWeight: 700, color: "var(--mut)", padding: 0, ...extra }}
      onClick={() => setSort((s) => ({ key, desc: s.key === key ? !s.desc : key !== "name" }))}>
      {label}{sort.key === key ? (sort.desc ? " ↓" : " ↑") : ""}
    </button>
  );

  return (
    <>
      {folders.length > 0 || canOrganise ? (
        <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap", marginBottom: 8 }}>
          <button className="btn link" style={{ fontSize: 12.5, fontWeight: trail.length ? 400 : 700 }}
            onClick={() => setAt(null)}>All files</button>
          {trail.map((f, i) => (
            <span key={f.id} style={{ display: "inline-flex", gap: 6, alignItems: "center" }}>
              <span className="mut" style={{ fontSize: 12 }}>/</span>
              <button className="btn link" style={{ fontSize: 12.5, fontWeight: i === trail.length - 1 ? 700 : 400 }}
                onClick={() => setAt(f.id)}>{f.name}</button>
            </span>
          ))}
          {canOrganise && (
            <button className="btn sm" style={{ marginLeft: "auto" }} disabled={pending}
              onClick={() => { setNaming((v) => !v); setNewName(""); setError(""); }}>
              {naming ? "Cancel" : "＋ New folder"}
            </button>
          )}
        </div>
      ) : null}

      {naming && (
        <div style={{ display: "flex", gap: 6, marginBottom: 8 }}>
          <input value={newName} autoFocus placeholder="Folder name" aria-label="Folder name"
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") e.currentTarget.form?.requestSubmit?.(); }}
            style={{ flex: "1 1 200px", fontSize: 12 }} />
          <button className="btn sm accent" disabled={pending || !newName.trim()}
            onClick={() => startTransition(async () => {
              const res = await createFolder(storeOrgId, at, newName);
              if (res?.error) { setError(res.error); return; }
              setNaming(false); setNewName(""); setError("");
            })}>Create</button>
        </div>
      )}

      <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap", marginBottom: 8 }}>
        <input value={filter} onChange={(e) => setFilter(e.target.value)}
          placeholder={searching || folders.length === 0 ? "Search files" : "Search all files"}
          aria-label="Search files"
          style={{ flex: "1 1 200px", fontSize: 12 }} />
        <span className="seg">
          {(["all", "shelf", "records"] as const).map((w) => (
            <button key={w} aria-pressed={where === w} onClick={() => setWhere(w)}>
              {w === "all" ? "All" : w === "shelf" ? "Loose" : "On a system"}
            </button>
          ))}
        </span>
        <span className="seg">
          {(["list", "grid"] as const).map((v) => (
            <button key={v} aria-pressed={view === v} onClick={() => setView(v)} aria-label={`${v} view`}>
              {v === "list" ? "☰" : "▦"}
            </button>
          ))}
        </span>
      </div>

      {picked.size > 0 && (
        <div style={{
          display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", marginBottom: 8,
          padding: "6px 10px", background: "#EEF4FB", border: "1px solid var(--line)", borderRadius: 8,
        }}>
          <span style={{ fontSize: 12, fontWeight: 700 }}>{picked.size} selected</span>
          <span className="mut" style={{ fontSize: 11 }}>
            {fmtBytes(shown.filter((f) => picked.has(f.url)).reduce((n, f) => n + f.size, 0))}
          </span>
          <button className="btn link" style={{ fontSize: 11 }} onClick={() => setPicked(new Set())}>clear</button>
          {canOrganise && (
            <span style={{ position: "relative" }}>
              <button className="btn sm" disabled={pending} onClick={() => setMoveOpen((v) => !v)}>
                Move to...
              </button>
              {moveOpen && (
                <span style={{
                  position: "absolute", zIndex: 30, top: "calc(100% + 4px)", left: 0, minWidth: 190,
                  background: "#fff", border: "1px solid var(--line)", borderRadius: 8,
                  boxShadow: "0 8px 24px rgba(15,23,42,.12)", maxHeight: 220, overflowY: "auto", display: "block",
                }}>
                  {[{ id: null as number | null, name: "All files (top level)" },
                    ...folders.map((f) => ({ id: f.id as number | null, name: folderPath(folders, f.id).map((x) => x.name).join(" / ") }))]
                    .filter((o) => o.id !== at)
                    .map((o) => (
                      <button key={o.id ?? "root"} className="btn link"
                        style={{ display: "block", width: "100%", textAlign: "left", padding: "5px 9px", fontSize: 12 }}
                        disabled={pending}
                        onClick={() => startTransition(async () => {
                          const ids = shown.filter((f) => picked.has(f.url))
                            .flatMap((f) => { const p = f.places.find((x) => x.kind === "shelf"); return p ? [p.attachmentId] : []; });
                          const res = await moveFilesToFolder(ids, o.id);
                          if (res?.error) { setError(res.error); return; }
                          setMoveOpen(false); setPicked(new Set()); setError("");
                        })}>{o.name}</button>
                    ))}
                </span>
              )}
            </span>
          )}
          {sweepable.length > 0 && (
            <button className="btn sm" disabled={pending} style={{ marginLeft: "auto", color: "#A32D2D" }}
              onClick={() => {
                const why = promptReason(
                  `Delete ${sweepable.length} file${sweepable.length === 1 ? "" : "s"} from your files?`
                  + (sweepable.length < picked.size
                    ? ` The other ${picked.size - sweepable.length} are filed on records and stay.` : ""),
                );
                if (!why) return;
                startTransition(async () => {
                  for (const f of sweepable) {
                    const shelf = f.places.find((p) => p.kind === "shelf");
                    if (!shelf) continue;
                    const res = await deleteAttachment(shelf.attachmentId, why);
                    if (res?.error) { setError(res.error); return; }
                  }
                  setPicked(new Set());
                });
              }}>
              Delete {sweepable.length}
            </button>
          )}
        </div>
      )}

      {view === "list" && (
        <div style={{ display: "flex", gap: 8, alignItems: "center", padding: "0 4px 6px", borderBottom: "1px solid var(--line)" }}>
          <input type="checkbox" aria-label="Select all"
            checked={shown.length > 0 && shown.every((f) => picked.has(f.url))}
            onChange={(e) => setPicked(e.target.checked ? new Set(shown.map((f) => f.url)) : new Set())}
            style={{ width: 15, height: 15, flexShrink: 0 }} />
          <span style={{ flex: "1 1 200px" }}>{head("name", "Name")}</span>
          <span style={{ width: 190, flexShrink: 0 }}>{head("where", "Where")}</span>
          <span style={{ width: 72, flexShrink: 0, textAlign: "right" }}>{head("size", "Size")}</span>
          <span style={{ width: 150, flexShrink: 0, textAlign: "right" }}>{head("when", "Modified")}</span>
        </div>
      )}

      {/* Folders first, the way every file list has done it since 1984. Hidden
          while searching, because a search is about files. */}
      {view === "list" && !searching && here.map((d) => (
        <div key={`d${d.id}`} className="row-hover file-row"
          style={{ display: "flex", gap: 8, alignItems: "center", padding: "7px 4px", borderBottom: "1px solid var(--line)" }}>
          <span style={{ width: 15, flexShrink: 0 }} />
          <button className="btn link" onClick={() => { setAt(d.id); setPicked(new Set()); }}
            style={{ flex: "1 1 200px", textAlign: "left", display: "flex", gap: 7, alignItems: "baseline", minWidth: 0 }}>
            <span aria-hidden style={{ color: "#8A5410", flexShrink: 0 }}>▮</span>
            <span style={{ fontSize: 13, fontWeight: 700, overflowWrap: "anywhere" }}>{d.name}</span>
          </button>
          <span style={{ width: 190, flexShrink: 0 }}>
            {(() => {
              const n = files.filter((f) => (f.folderId ?? null) === d.id).length
                + childrenOf(folders, d.id).length;
              return <span className="mut" style={{ fontSize: 11 }}>{n === 0 ? "empty" : `${n} item${n === 1 ? "" : "s"}`}</span>;
            })()}
          </span>
          <span style={{ width: 72, flexShrink: 0 }} />
          <span style={{ width: 150, flexShrink: 0, textAlign: "right" }}>
            {canOrganise && (
              <>
                <button className="btn link row-act" style={{ fontSize: 10.5 }} disabled={pending}
                  onClick={() => {
                    const next = window.prompt(`Rename "${d.name}" to?`, d.name);
                    if (next === null) return;
                    startTransition(async () => {
                      const res = await renameFolder(d.id, next);
                      setError(res?.error ?? "");
                    });
                  }}>rename</button>
                <button className="btn link row-act" style={{ fontSize: 10.5, color: "#A32D2D", marginLeft: 6 }} disabled={pending}
                  onClick={() => startTransition(async () => {
                    const res = await deleteFolder(d.id);
                    setError(res?.error ?? "");
                  })}>delete</button>
              </>
            )}
          </span>
        </div>
      ))}

      {view === "list" && shown.map((f) => (
        <div key={f.url} className="row-hover file-row"
          style={{ display: "flex", gap: 8, alignItems: "center", padding: "7px 4px", borderBottom: "1px solid var(--line)" }}>
          <input type="checkbox" checked={picked.has(f.url)} onChange={() => toggle(f.url)}
            aria-label={`Select ${f.fileName}`} style={{ width: 15, height: 15, flexShrink: 0 }} />
          <span style={{ flex: "1 1 200px", minWidth: 0, display: "flex", gap: 7, alignItems: "baseline" }}>
            <span aria-hidden style={{ color: glyph(f).fg, flexShrink: 0 }}>{glyph(f).glyph}</span>
            <span style={{ minWidth: 0 }}>
              <a href={`/api/files/${f.places[0].attachmentId}`} target="_blank" rel="noreferrer"
                style={{ fontSize: 13, fontWeight: 600, textDecoration: "none", overflowWrap: "anywhere" }}>
                {f.fileName}
              </a>
              {f.description && <div className="mut" style={{ fontSize: 11.5 }}>{f.description}</div>}
            </span>
          </span>
          <span style={{ width: 190, flexShrink: 0, display: "flex", gap: 4, flexWrap: "wrap" }}>
            <WhereChips file={f} removable={removable} pending={pending}
              onRemoved={(err) => setError(err)} startTransition={startTransition} />
          </span>
          <span className="mut" style={{ width: 72, flexShrink: 0, fontSize: 12, textAlign: "right" }}>{fmtBytes(f.size)}</span>
          {/* Two lines rather than one truncated one: who put a file there is
              worth as much as when, and an ellipsis was eating both. */}
          <span style={{ width: 150, flexShrink: 0, textAlign: "right", minWidth: 0 }}>
            <span className="mut" style={{ fontSize: 11, display: "block" }}>{f.when}</span>
            <span className="mut" style={{ fontSize: 10.5, display: "block", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {f.uploadedBy}
            </span>
          </span>
        </div>
      ))}

      {view === "grid" && (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(150px, 1fr))", gap: 10 }}>
          {shown.map((f) => (
            <div key={f.url} style={{
              border: picked.has(f.url) ? "2px solid var(--navy)" : "1px solid var(--line)",
              borderRadius: 10, padding: 8, position: "relative", minWidth: 0,
            }}>
              <input type="checkbox" checked={picked.has(f.url)} onChange={() => toggle(f.url)}
                aria-label={`Select ${f.fileName}`}
                style={{ position: "absolute", top: 6, left: 6, width: 15, height: 15, zIndex: 1 }} />
              <a href={`/api/files/${f.places[0].attachmentId}`} target="_blank" rel="noreferrer"
                style={{ textDecoration: "none", color: "inherit" }}>
                <div style={{
                  height: 92, borderRadius: 6, background: "#F4F6F9", marginBottom: 6,
                  display: "flex", alignItems: "center", justifyContent: "center", overflow: "hidden",
                }}>
                  {isPhotoFile(f) ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={`/api/files/${f.places[0].attachmentId}`} alt="" loading="lazy"
                      style={{ width: "100%", height: "100%", objectFit: "cover" }} />
                  ) : (
                    <span aria-hidden style={{ fontSize: 30, color: glyph(f).fg }}>{glyph(f).glyph}</span>
                  )}
                </div>
                <div style={{ fontSize: 12, fontWeight: 600, overflowWrap: "anywhere", lineHeight: 1.25 }}>{f.fileName}</div>
              </a>
              <div className="mut" style={{ fontSize: 10.5, marginTop: 2 }}>
                {fmtBytes(f.size)} · {onShelf(f) ? "not on a system" : f.places[0].kind === "shelf" ? "" : (f.places[0] as { label: string }).label}
              </div>
            </div>
          ))}
        </div>
      )}

      {shown.length === 0 && (
        <div className="mut" style={{ fontSize: 12, padding: "14px 0", textAlign: "center" }}>
          No file matches &ldquo;{filter}&rdquo;.
        </div>
      )}
      {error && <div style={{ fontSize: 12, color: "#A32D2D", marginTop: 6 }}>{error}</div>}
    </>
  );
}

/**
 * Where a file is, in words.
 *
 * "Not on a system" is stated rather than implied by an absent chip. That
 * sentence is the whole reason this pass happened: a client would not upload
 * because they could not tell that a file here touches nothing of theirs.
 */
function WhereChips({ file, removable, pending, onRemoved, startTransition }: {
  file: StoreFile;
  removable: (p: Place) => boolean;
  pending: boolean;
  onRemoved: (error: string) => void;
  startTransition: (fn: () => void) => void;
}) {
  const shelf = file.places.find((p) => p.kind === "shelf");
  const records = file.places.filter((p) => p.kind !== "shelf");
  return (
    <>
      {records.length === 0 && shelf && (
        <span className="mut" style={{ fontSize: 11 }}>
          Not on a system
          {removable(shelf) && (
            <button className="btn link row-act" style={{ fontSize: 10, color: "#A32D2D", marginLeft: 4 }} disabled={pending}
              aria-label={`Delete ${file.fileName}`}
              onClick={() => {
                const why = promptReason(`Delete "${file.fileName}"? It is permanently removed from storage.`);
                if (!why) return;
                startTransition(async () => {
                  const res = await deleteAttachment(shelf.attachmentId, why);
                  onRemoved(res?.error ?? "");
                });
              }}>×</button>
          )}
        </span>
      )}
      {records.slice(0, 2).map((p) => (
        <span key={p.attachmentId} className="pill" style={{ background: "#EEF1F5", color: "#475569", display: "inline-flex", gap: 4, alignItems: "center" }}>
          <Link href={p.kind === "system" ? `/instruments/${p.id}` : `/assets/${p.id}`}
            style={{ textDecoration: "none" }}>{p.label}</Link>
          {removable(p) && (
            <button className="btn link row-act" style={{ fontSize: 10, color: "#A32D2D" }} disabled={pending}
              aria-label={`Remove ${file.fileName} from ${p.label}`}
              onClick={() => {
                const scope = file.places.length > 1
                  ? ` It stays on the ${file.places.length - 1} other place${file.places.length === 2 ? "" : "s"} it is filed.`
                  : " The file is permanently deleted from storage.";
                const why = promptReason(`Remove "${file.fileName}" from ${p.label}?${scope}`);
                if (!why) return;
                startTransition(async () => {
                  const res = await deleteAttachment(p.attachmentId, why);
                  onRemoved(res?.error ?? "");
                });
              }}>×</button>
          )}
        </span>
      ))}
      {records.length > 2 && <span className="mut" style={{ fontSize: 11 }}>+{records.length - 2}</span>}
    </>
  );
}
