"use client";

import Link from "next/link";
import { useMemo, useState, useTransition } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { confirmDialog, confirmReason, inputDialog } from "@/components/ui/ConfirmDialog";
import {
  attachLibraryFile, createFolder, createShareLink, deleteAttachment, deleteFolder,
  moveFilesToFolder, moveFolder, renameFolder, saveFileColumns, updateAttachment,
  type FileColumnWidths,
} from "@/app/actions";
import Dialog from "@/components/ui/Dialog";
import { toast } from "@/components/ui/Toast";

import { addDaysIso, DEFAULT_LINK_DAYS } from "@/lib/dropShare";
import { ATTACH_KINDS, ATTACH_META } from "@/lib/stages";
import { canMoveFolder, childrenOf, descendantIds, folderPath, type FolderLike } from "@/lib/folders";
import { fmtBytes } from "@/lib/storage";
import { isPhotoFile } from "@/lib/photos";

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

const COL_DEFAULTS: FileColumnWidths = { where: 190, size: 72, when: 150 };
/** Mirrors the server clamp, so a drag never shows a width the save rejects. */
const COL_BOUNDS: Record<keyof FileColumnWidths, [number, number]> = {
  where: [90, 420], size: [56, 160], when: [90, 300],
};

/** One line, however long the text: ellipsis, with the full text on hover. */
const oneLine: React.CSSProperties = {
  overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
};

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
  files, folders = [], storeOrgId = null, openFolderId = null, columnWidths = null,
  systems = [], canOrganise = false, canRemoveShelf, canRemoveRecord, emptyNote,
}: {
  files: StoreFile[];
  /** The store's folders. Empty means this list is browsed flat. */
  folders?: StoreFolder[];
  /** Whose store, for creating folders in it. */
  storeOrgId?: number | null;
  /** The folder the URL says is open. Null = the top level. */
  openFolderId?: number | null;
  /** This person's saved column widths, read on the server. Null = defaults. */
  columnWidths?: FileColumnWidths | null;
  /** Systems a loose file can be filed onto from here. Empty hides the control. */
  systems?: { id: number; externalId: string; model: string }[];
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
  // The file whose details are open, and the draft being edited. A file you
  // cannot rename is a file you have to re-upload to correct, which is how a
  // store fills with "scan_0043 (1).pdf".
  const [details, setDetails] = useState<StoreFile | null>(null);
  const [draft, setDraft] = useState({ fileName: "", kind: "Other", description: "" });
  const [folderMove, setFolderMove] = useState<number | null>(null);
  // A row being dragged, and the folder it is over. The drag carries the
  // whole selection when the dragged row is part of it - the drive gesture.
  const [dragOver, setDragOver] = useState<number | null | "root">(null);
  const [shareUrl, setShareUrl] = useState("");
  const [copied, setCopied] = useState(false);
  const [filedNote, setFiledNote] = useState<{ text: string; ok: boolean } | null>(null);

  /**
   * Copy loose files onto a system - the same act the record's Files panel
   * calls "from the library", started from this end. Partial outcomes are
   * ordinary (a file may already be on the record), so the result is counted
   * out loud instead of the first refusal aborting the rest - and a
   * nothing-happened outcome is worded and colored as one, because "0 filed"
   * in success green reads as the software congratulating itself.
   */
  const fileOnto = (targets: StoreFile[], instrumentId: number, label: string) =>
    startTransition(async () => {
      let filed = 0; const skipped: string[] = [];
      for (const f of targets) {
        const shelf = f.places.find((pl) => pl.kind === "shelf");
        if (!shelf) continue;
        const res = await attachLibraryFile({ instrumentId, assetId: null }, shelf.attachmentId);
        if (res?.error) {
          // The action's refusals mostly name the file already; prefix only
          // when one doesn't, and say WHERE rather than "this record" - on
          // this page, the record is not the thing in front of the reader.
          const why = res.error.replace("this record", label);
          skipped.push(why.includes(f.fileName) ? why : `${f.fileName}: ${why}`);
        } else filed++;
      }
      setFiledNote(
        filed === 0
          ? { ok: false, text: `Nothing filed - ${skipped[0] ?? "no loose copies in the selection"}` }
          : {
              ok: true,
              text: `${filed} filed onto ${label}`
                + (skipped.length ? ` · ${skipped.length} already there` : ""),
            },
      );
      setPicked(new Set());
    });
  // Column widths, draggable at the header and remembered per person on the
  // server - the same "how I like this screen" fact as a panel arrangement.
  // Name is never a number: it flexes into whatever the fixed columns leave.
  const [cols, setCols] = useState<FileColumnWidths>(columnWidths ?? COL_DEFAULTS);

  const startResize = (key: keyof FileColumnWidths) => (e: React.MouseEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = cols[key];
    let latest = cols;
    const move = (ev: MouseEvent) => {
      const [lo, hi] = COL_BOUNDS[key];
      latest = { ...latest, [key]: Math.min(hi, Math.max(lo, startW + ev.clientX - startX)) };
      setCols(latest);
    };
    const up = () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
      // Saved once, on release - not per pixel of drag.
      void saveFileColumns(latest);
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  };

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
      <div className="mut t-body" style={{ padding: "18px 0", textAlign: "center" }}>
        {emptyNote ?? "No files yet. Drop one anywhere on this page, or use Upload above."}
      </div>
    );
  }

  const removable = (p: Place) => (p.kind === "shelf" ? canRemoveShelf : canRemoveRecord);
  /** The loose copies a gesture moves: the selection if the file is in it, else just the file. */
  const dragIds = (f: StoreFile): number[] => {
    const set = picked.has(f.url) ? shown.filter((x) => picked.has(x.url)) : [f];
    return set.flatMap((x) => { const sp = x.places.find((pl) => pl.kind === "shelf"); return sp ? [sp.attachmentId] : []; });
  };
  const dropIds = (e: React.DragEvent): number[] =>
    (e.dataTransfer.getData("application/x-store-file") || "").split(",").map((n) => parseInt(n)).filter((n) => n > 0);
  const acceptsFileDrag = (e: React.DragEvent) => e.dataTransfer.types.includes("application/x-store-file");
  const dropInto = (folderId: number | null) => (e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(null);
    const ids = dropIds(e);
    if (!ids.length) return;
    startTransition(async () => {
      const res = await moveFilesToFolder(ids, folderId);
      if (res?.error) { setError(res.error); return; }
      toast({ message: `Moved ${ids.length} file${ids.length === 1 ? "" : "s"}` });
      setPicked(new Set()); setError("");
    });
  };
  const toggle = (url: string) =>
    setPicked((s) => { const n = new Set(s); if (n.has(url)) n.delete(url); else n.add(url); return n; });

  // Bulk removal is deliberately only your own copies. A report on somebody's
  // system is their evidence, and sweeping a dozen of those away behind one
  // confirmation is not a thing this page should make easy - so the count says
  // exactly how many of the selection will actually go.
  const sweepable = shown.filter((f) => picked.has(f.url) && canRemoveShelf && onShelf(f));

  const head = (key: SortKey, label: string, extra: React.CSSProperties = {}) => (
    <button className="btn link" style={{ fontWeight: 700, color: "var(--mut)", padding: 0, ...extra }}
      onClick={() => setSort((s) => ({ key, desc: s.key === key ? !s.desc : key !== "name" }))}>
      {label}{sort.key === key ? (sort.desc ? " ↓" : " ↑") : ""}
    </button>
  );

  return (
    <>
      {folders.length > 0 || canOrganise ? (
        <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap", marginBottom: 8 }}>
          <button className="btn link" style={{ fontSize: 13, fontWeight: trail.length ? 400 : 700, background: dragOver === "root" ? "#EEF4FB" : undefined, borderRadius: 6 }}
            onClick={() => setAt(null)}
            onDragOver={(e) => { if (acceptsFileDrag(e)) { e.preventDefault(); setDragOver("root"); } }}
            onDragLeave={() => setDragOver(null)}
            onDrop={dropInto(null)}>All files</button>
          {trail.map((f, i) => (
            <span key={f.id} style={{ display: "inline-flex", gap: 6, alignItems: "center" }}>
              <span className="mut t-small">/</span>
              <button className="btn link" style={{ fontSize: 13, fontWeight: i === trail.length - 1 ? 700 : 400 }}
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
            className="t-small" style={{ flex: "1 1 200px" }} />
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
          className="t-small" style={{ flex: "1 1 200px" }} />
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
          <span className="t-small" style={{ fontWeight: 700 }}>{picked.size} selected</span>
          <span className="mut t-meta">
            {fmtBytes(shown.filter((f) => picked.has(f.url)).reduce((n, f) => n + f.size, 0))}
          </span>
          <button className="btn link" onClick={() => setPicked(new Set())}>clear</button>
          {systems.length > 0 && (
            <select value="" disabled={pending} aria-label="File the selection onto a system"
              onChange={(e) => {
                const id = parseInt(e.target.value);
                if (!id) return;
                const sys = systems.find((x) => x.id === id);
                fileOnto(shown.filter((f) => picked.has(f.url)), id, sys?.externalId ?? "the system");
              }}
              className="t-small" style={{ width: "auto" }}>
              <option value="">File onto system...</option>
              {systems.map((x) => (
                <option key={x.id} value={x.id}>{x.externalId}{x.model ? ` - ${x.model}` : ""}</option>
              ))}
            </select>
          )}
          {/* One archive of the selection. Authorized per file by the same
              gate as a single download - see /api/files/zip. */}
          <a className="btn sm" style={{ textDecoration: "none" }}
            href={`/api/files/zip?ids=${shown.filter((f) => picked.has(f.url)).map((f) => f.places[0].attachmentId).join(",")}`}>
            Download .zip
          </a>
          {canOrganise && !shareUrl && (
            <button className="btn sm" disabled={pending}
              title="A link anyone can open - no account needed. Lasts two weeks; revoke it under Links."
              onClick={async () => {
                const label = await inputDialog({
                  title: "Share these files",
                  body: "A link anyone can open - no account needed. Lasts two weeks; revoke it under Links.",
                  action: "Create link", label: "Label",
                  hint: "Optional - e.g. who it's for.", allowEmpty: true,
                });
                if (label === null) return;
                startTransition(async () => {
                  const ids = shown.filter((f) => picked.has(f.url)).map((f) => f.places[0].attachmentId);
                  const res = await createShareLink(ids, {
                    label, expiresOn: addDaysIso(new Date().toISOString().slice(0, 10), DEFAULT_LINK_DAYS),
                  });
                  if (res?.error || !res.token) { setError(res?.error ?? "Sharing failed"); return; }
                  setShareUrl(`${window.location.origin}/share/${res.token}`);
                  setError("");
                });
              }}>Share...</button>
          )}
          {shareUrl && (
            <span style={{ display: "inline-flex", gap: 6, alignItems: "center", minWidth: 0 }}>
              <a href={shareUrl} target="_blank" rel="noreferrer" className="mono t-meta" style={{ ...oneLine, maxWidth: 260 }}>{shareUrl}</a>
              <button className="btn sm accent" onClick={() => {
                void navigator.clipboard?.writeText(shareUrl);
                setCopied(true); setTimeout(() => setCopied(false), 1500);
              }}>{copied ? "Copied ✓" : "Copy link"}</button>
              <button className="btn link" onClick={() => setShareUrl("")}>done</button>
            </span>
          )}
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
            <button className="btn sm" disabled={pending} style={{ marginLeft: "auto", color: "var(--t-bad-fg)" }}
              onClick={async () => {
                const why = await confirmReason({
                  title: `Delete ${sweepable.length} file${sweepable.length === 1 ? "" : "s"} from your files?`,
                  body: sweepable.length < picked.size
                    ? `The other ${picked.size - sweepable.length} in the selection are filed on records and stay.`
                    : "They are permanently removed from storage.",
                  action: `Delete ${sweepable.length} file${sweepable.length === 1 ? "" : "s"}`, tone: "bad",
                });
                if (!why) return;
                startTransition(async () => {
                  for (const f of sweepable) {
                    const shelf = f.places.find((p) => p.kind === "shelf");
                    if (!shelf) continue;
                    const res = await deleteAttachment(shelf.attachmentId, why);
                    if (res?.error) { setError(res.error); return; }
                  }
                  toast({ message: `Deleted ${sweepable.length} file${sweepable.length === 1 ? "" : "s"}` });
                  setPicked(new Set());
                });
              }}>
              Delete {sweepable.length}
            </button>
          )}
        </div>
      )}

      {/* The browser proper, in the DataTable chrome: the same .dt/.reg grid
          the list pages use, with this table's one extra - draggable column
          widths feeding the grid tracks. Name takes the slack. */}
      {view === "list" && (
        <div className="dt reg"
          style={{ ["--reg-cols" as string]: `18px minmax(160px, 1fr) ${cols.where}px ${cols.size}px ${cols.when}px` }}>
        <div className="reg-head">
          <span className="reg-cell" style={{ overflow: "visible" }}>
            <input type="checkbox" aria-label="Select all"
              checked={shown.length > 0 && shown.every((f) => picked.has(f.url))}
              onChange={(e) => setPicked(e.target.checked ? new Set(shown.map((f) => f.url)) : new Set())} />
          </span>
          <span className="reg-cell">{head("name", "Name")}</span>
          {/* Each fixed column drags at its right edge. */}
          {([["where", "Where", {}], ["size", "Size", { textAlign: "right" }], ["when", "Modified", { textAlign: "right" }]] as const)
            .map(([key, label, extra]) => (
              <span key={key} className="reg-cell" style={{ position: "relative", overflow: "visible", ...extra }}>
                {head(key, label)}
                <span role="separator" aria-orientation="vertical" aria-label={`Resize the ${label} column`}
                  title="Drag to resize · double-click to reset"
                  onMouseDown={startResize(key)}
                  onDoubleClick={() => {
                    // The way back, without a settings screen: the same gesture
                    // every desktop file manager uses.
                    const next = { ...cols, [key]: COL_DEFAULTS[key] };
                    setCols(next);
                    void saveFileColumns(next);
                  }}
                  style={{
                    position: "absolute", top: -4, bottom: -4, right: -6, width: 11,
                    cursor: "col-resize", zIndex: 5,
                  }} />
              </span>
            ))}
        </div>

      {/* Folders first, the way every file list has done it since 1984. Hidden
          while searching, because a search is about files. */}
      {!searching && here.map((d) => (
        <div key={`d${d.id}`} className="reg-row dt-row row-hover file-row"
          onDragOver={(e) => { if (acceptsFileDrag(e)) { e.preventDefault(); setDragOver(d.id); } }}
          onDragLeave={() => setDragOver((v) => (v === d.id ? null : v))}
          onDrop={dropInto(d.id)}
          style={{
            background: dragOver === d.id ? "#EEF4FB" : undefined,
            outline: dragOver === d.id ? "1.5px dashed var(--navy)" : undefined, outlineOffset: -2,
          }}>
          <span className="dt-main">
          <span className="reg-cell" />
          <span className="reg-cell" style={{ overflow: "visible" }}>
            <button className="btn link" onClick={() => { setAt(d.id); setPicked(new Set()); }}
              style={{ textAlign: "left", display: "flex", gap: 7, alignItems: "baseline", minWidth: 0, maxWidth: "100%" }}
              title={d.name}>
              <span aria-hidden style={{ color: "var(--t-warn-fg)", flexShrink: 0 }}>▮</span>
              <span className="t-body" style={{ fontWeight: 700, minWidth: 0, ...oneLine }}>{d.name}</span>
            </button>
          </span>
          <span className="reg-cell">
            {(() => {
              // Everything at any depth, so a folder's line means the same
              // thing whether somebody nested things inside it or not.
              const scope = new Set([d.id, ...descendantIds(folders, d.id)]);
              const inside = files.filter((f) => f.folderId !== null && scope.has(f.folderId));
              const kids = descendantIds(folders, d.id).length;
              const n = inside.length + kids;
              return (
                <span className="mut t-meta">
                  {n === 0 ? "empty" : `${n} item${n === 1 ? "" : "s"}`}
                  {inside.length > 0 ? ` · ${fmtBytes(inside.reduce((t, f) => t + f.size, 0))}` : ""}
                </span>
              );
            })()}
          </span>
          <span className="reg-cell" />
          <span className="reg-cell" style={{ textAlign: "right", overflow: "visible" }}>
            {canOrganise && (
              <>
                <button className="btn link row-act" style={{ fontSize: 11 }} disabled={pending}
                  onClick={async () => {
                    const next = await inputDialog({
                      title: `Rename "${d.name}"`, action: "Rename",
                      label: "New name", initial: d.name,
                    });
                    if (next === null) return;
                    startTransition(async () => {
                      const res = await renameFolder(d.id, next);
                      setError(res?.error ?? "");
                    });
                  }}>rename</button>
                <button className="btn link row-act" style={{ fontSize: 11, marginLeft: 6 }} disabled={pending}
                  onClick={() => { setFolderMove(folderMove === d.id ? null : d.id); setError(""); }}>move</button>
                <button className="btn link row-act" style={{ fontSize: 11, color: "var(--t-bad-fg)", marginLeft: 6 }} disabled={pending}
                  onClick={async () => {
                    if (!(await confirmDialog({
                      title: `Delete the "${d.name}" folder?`,
                      body: "Only an empty folder can go - its files must be moved out first.",
                      action: `Delete ${d.name}`, tone: "bad",
                    }))) return;
                    startTransition(async () => {
                      const res = await deleteFolder(d.id);
                      setError(res?.error ?? "");
                      if (!res?.error) toast({ message: `Deleted the ${d.name} folder` });
                    });
                  }}>delete</button>
              </>
            )}
          </span>
          </span>
        </div>
      ))}

      {!searching && folderMove !== null && (
        <div style={{ padding: "7px 10px", background: "#F8FAFD", border: "1px solid var(--line)", borderRadius: 8, marginBottom: 6 }}>
          <div className="mut t-meta" style={{ marginBottom: 4 }}>
            Move &ldquo;{folders.find((f) => f.id === folderMove)?.name}&rdquo; into:
          </div>
          <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
            {[{ id: null as number | null, name: "Top level" },
              ...folders.map((f) => ({ id: f.id as number | null, name: folderPath(folders, f.id).map((x) => x.name).join(" / ") }))]
              // Only somewhere it can actually go: offering a destination the
              // server would refuse is a button that exists to say no.
              .filter((o) => canMoveFolder(folders, folderMove, o.id).ok
                && o.id !== folders.find((f) => f.id === folderMove)?.parentId)
              .map((o) => (
                <button key={o.id ?? "root"} className="btn sm" disabled={pending} style={{ fontSize: 11 }}
                  onClick={() => startTransition(async () => {
                    const res = await moveFolder(folderMove, o.id);
                    if (res?.error) { setError(res.error); return; }
                    setFolderMove(null); setError("");
                  })}>{o.name}</button>
              ))}
            <button className="btn link" onClick={() => setFolderMove(null)}>cancel</button>
          </div>
        </div>
      )}

      {shown.map((f, i) => (
        <div key={f.url} className={`reg-row dt-row row-hover file-row${i % 2 === 1 ? " alt" : ""}`}
          draggable={canOrganise && onShelf(f)}
          onDragStart={(e) => {
            // The drag never carries the browser's "Files" type, so the page's
            // drop-to-upload overlay stays quiet during an internal move.
            e.dataTransfer.setData("application/x-store-file", dragIds(f).join(","));
            e.dataTransfer.effectAllowed = "move";
          }}
          style={{ cursor: canOrganise && onShelf(f) ? "grab" : undefined }}>
          <span className="dt-main">
          <span className="reg-cell" style={{ overflow: "visible" }}>
            <input type="checkbox" checked={picked.has(f.url)} onChange={() => toggle(f.url)}
              aria-label={`Select ${f.fileName}`} />
          </span>
          {/* One line, whatever the name's length. The full name and the
              description ride on the hover title, so truncating costs a squint
              and never the information. */}
          <span className="reg-cell" style={{ display: "flex", gap: 7, alignItems: "baseline" }}
            title={f.description ? `${f.fileName} - ${f.description}` : f.fileName}>
            <span aria-hidden style={{ color: `var(--t-${glyph(f).tone}-fg)`, flexShrink: 0 }}>{glyph(f).glyph}</span>
            <a href={`/api/files/${f.places[0].attachmentId}`} target="_blank" rel="noreferrer" className="t-body"
              style={{ fontWeight: 600, textDecoration: "none", minWidth: 0, flexShrink: 1, ...oneLine }}>
              {f.fileName}
            </a>
            {f.description && (
              <span className="mut" style={{ fontSize: 12, minWidth: 0, flex: "0 1 auto", ...oneLine }}>
                {f.description}
              </span>
            )}
          </span>
          <span className="reg-cell" style={{ display: "flex", gap: 4, alignItems: "baseline" }}>
            {/* Found by search: say which folder it lives in, and make the
                answer a door. "Does it exist" without "where did I put it" is
                half of what somebody searching wanted. */}
            {searching && f.folderId !== null && (
              <button className="pill" type="button"
                title={folderPath(folders, f.folderId).map((x) => x.name).join(" / ")}
                onClick={() => { setFilter(""); setAt(f.folderId); }}
                style={{ background: "var(--t-warn-bg)", color: "var(--t-warn-fg)", border: "none", cursor: "pointer", ...oneLine, maxWidth: 120 }}>
                ▮ {folders.find((x) => x.id === f.folderId)?.name ?? "folder"}
              </button>
            )}
            <WhereChips file={f} removable={removable} pending={pending}
              onRemoved={(err) => setError(err)} startTransition={startTransition} />
          </span>
          <span className="reg-cell" style={{ textAlign: "right", overflow: "visible" }}>
            <span className="mut t-small">{fmtBytes(f.size)}</span>
            {canOrganise && (
              <button className="btn link row-act" style={{ fontSize: 11, marginLeft: 6 }}
                aria-label={`Details for ${f.fileName}`}
                onClick={() => {
                  setDetails(f);
                  setDraft({ fileName: f.fileName, kind: f.kind || "Other", description: f.description });
                  setError("");
                }}>edit</button>
            )}
          </span>
          {/* One line; widen the column when you want the uploader too - the
              hover title always carries both. */}
          <span className="reg-cell mut t-meta" title={`${f.when} · ${f.uploadedBy}`}
            style={{ textAlign: "right" }}>
            {f.when} · {f.uploadedBy}
          </span>
          </span>
        </div>
      ))}
      </div>
      )}

      {view === "grid" && (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(150px, 1fr))", gap: 10 }}>
          {/* Folders as tiles, ahead of the files - the list view has had them
              from the start, and a tile view where they vanish reads as "my
              folders are gone". Hidden while searching, same as the list. */}
          {!searching && here.map((d) => {
            const scope = new Set([d.id, ...descendantIds(folders, d.id)]);
            const n = files.filter((f) => f.folderId !== null && scope.has(f.folderId)).length
              + descendantIds(folders, d.id).length;
            return (
              <button key={`d${d.id}`} type="button" onClick={() => { setAt(d.id); setPicked(new Set()); }}
                onDragOver={(e) => { if (acceptsFileDrag(e)) { e.preventDefault(); setDragOver(d.id); } }}
                onDragLeave={() => setDragOver((v) => (v === d.id ? null : v))}
                onDrop={dropInto(d.id)}
                style={{
                  border: dragOver === d.id ? "1.5px dashed var(--navy)" : "1px solid var(--line)",
                  borderRadius: 10, padding: 8, minWidth: 0, textAlign: "left", cursor: "pointer",
                  background: dragOver === d.id ? "#EEF4FB" : "#fff",
                }}>
                <div style={{
                  height: 92, borderRadius: 6, background: "#FAF6EE", marginBottom: 6,
                  display: "flex", alignItems: "center", justifyContent: "center",
                }}>
                  <span aria-hidden style={{ fontSize: 26, color: "var(--t-warn-fg)" }}>▮</span>
                </div>
                <div className="t-small" style={{ fontWeight: 700, ...oneLine }}>{d.name}</div>
                <div className="mut" style={{ fontSize: 11, marginTop: 2 }}>{n === 0 ? "empty" : `${n} item${n === 1 ? "" : "s"}`}</div>
              </button>
            );
          })}
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
                    <span aria-hidden style={{ fontSize: 26, color: `var(--t-${glyph(f).tone}-fg)` }}>{glyph(f).glyph}</span>
                  )}
                </div>
                <div className="t-small" style={{ fontWeight: 600, overflowWrap: "anywhere", lineHeight: 1.25 }}>{f.fileName}</div>
              </a>
              <div className="mut" style={{ fontSize: 11, marginTop: 2 }}>
                {fmtBytes(f.size)} · {onShelf(f) ? "not on a system" : f.places[0].kind === "shelf" ? "" : (f.places[0] as { label: string }).label}
              </div>
            </div>
          ))}
        </div>
      )}

      {shown.length === 0 && (
        <div className="mut t-small" style={{ padding: "14px 0", textAlign: "center" }}>
          No file matches &ldquo;{filter}&rdquo;.
        </div>
      )}
      {filedNote && (
        <div className="t-small" style={{ marginTop: 6, fontWeight: 700, color: filedNote.ok ? "#2E6B2E" : "#8A5410" }}>
          {filedNote.text}
        </div>
      )}
      {error && <div className="t-small" style={{ color: "var(--t-bad-fg)", marginTop: 6 }}>{error}</div>}

      {/* One file, close up: what it is called, what it is, and where it came
          from. A store where a file cannot be renamed is a store that fills up
          with "scan_0043 (1).pdf" and stays that way. */}
      {details && (
        <Dialog open onClose={() => setDetails(null)} title="File details"
          footer={
            <>
              <a className="btn" href={`/api/files/${details.places[0].attachmentId}`} download
                style={{ textDecoration: "none" }}>Download</a>
              <span className={`dialog-status${error ? " err" : ""}`}>{error}</span>
              <button className="btn" onClick={() => setDetails(null)} disabled={pending}>Cancel</button>
              <button className="btn accent" disabled={pending || !draft.fileName.trim()}
                onClick={() => startTransition(async () => {
                  const res = await updateAttachment(details.places[0].attachmentId, draft);
                  if (res?.error) { setError(res.error); return; }
                  setDetails(null); setError("");
                  toast({ message: `Saved ${draft.fileName.trim()}` });
                })}>{pending ? "Saving..." : "Save file"}</button>
            </>
          }>
            <label>Name</label>
            <input value={draft.fileName} autoFocus maxLength={200}
              onChange={(e) => setDraft({ ...draft, fileName: e.target.value })}
              style={{ marginBottom: 8 }} />

            <label>What it is</label>
            <div className="seg" role="group" aria-label="File kind" style={{ marginBottom: 8, flexWrap: "wrap" }}>
              {ATTACH_KINDS.map((k) => (
                <button key={k} type="button" aria-pressed={draft.kind === k}
                  onClick={() => setDraft({ ...draft, kind: k })}>{k}</button>
              ))}
            </div>

            <label>Description</label>
            <textarea value={draft.description} rows={2} maxLength={500}
              placeholder="What somebody looking for this in a year would search for"
              onChange={(e) => setDraft({ ...draft, description: e.target.value })}
              style={{ width: "100%", marginBottom: 10, resize: "vertical" }} />

            <div className="mut" style={{ fontSize: 12, marginBottom: 10 }}>
              {fmtBytes(details.size)} · uploaded by {details.uploadedBy} · {details.when}
              <br />
              {details.places.some((pl) => pl.kind !== "shelf")
                ? `Filed on ${details.places.filter((pl) => pl.kind !== "shelf").length} record(s). Renaming it here renames it there too.`
                : "Not on any system."}
            </div>

            {systems.length > 0 && details.places.some((pl) => pl.kind === "shelf") && (
              <div style={{ marginBottom: 10 }}>
                <label>Put it on a system</label>
                <select value="" disabled={pending} aria-label="File this onto a system"
                  onChange={(e) => {
                    const id = parseInt(e.target.value);
                    if (!id) return;
                    const sys = systems.find((x) => x.id === id);
                    fileOnto([details], id, sys?.externalId ?? "the system");
                    setDetails(null);
                  }}
                  className="t-small">
                  <option value="">Choose a system...</option>
                  {systems.map((x) => (
                    <option key={x.id} value={x.id}>{x.externalId}{x.model ? ` - ${x.model}` : ""}</option>
                  ))}
                </select>
                <div className="mut" style={{ fontSize: 11, marginTop: 3 }}>
                  It appears in that system&apos;s files AND stays here - one stored copy, filed twice.
                </div>
              </div>
            )}
        </Dialog>
      )}
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
        <span className="mut t-meta">
          Not on a system
          {removable(shelf) && (
            <button className="btn link row-act" style={{ fontSize: 10, color: "var(--t-bad-fg)", marginLeft: 4 }} disabled={pending}
              aria-label={`Delete ${file.fileName}`}
              onClick={async () => {
                const why = await confirmReason({
                  title: `Delete "${file.fileName}"?`,
                  body: "It is permanently removed from storage.",
                  action: "Delete file", tone: "bad",
                });
                if (!why) return;
                startTransition(async () => {
                  const res = await deleteAttachment(shelf.attachmentId, why);
                  onRemoved(res?.error ?? "");
                  if (!res?.error) toast({ message: `Deleted ${file.fileName}` });
                });
              }}>×</button>
          )}
        </span>
      )}
      {records.slice(0, 2).map((p) => (
        <span key={p.attachmentId} className="pill neutral" style={{ display: "inline-flex", gap: 4, alignItems: "center" }}>
          <Link href={p.kind === "system" ? `/instruments/${p.id}` : `/assets/${p.id}`}
            style={{ textDecoration: "none" }}>{p.label}</Link>
          {removable(p) && (
            <button className="btn link row-act" style={{ fontSize: 10, color: "var(--t-bad-fg)" }} disabled={pending}
              aria-label={`Remove ${file.fileName} from ${p.label}`}
              onClick={async () => {
                const scope = file.places.length > 1
                  ? `It stays on the ${file.places.length - 1} other place${file.places.length === 2 ? "" : "s"} it is filed.`
                  : "The file is permanently deleted from storage.";
                const why = await confirmReason({
                  title: `Remove "${file.fileName}" from ${p.label}?`,
                  body: scope,
                  action: "Remove file", tone: "bad",
                });
                if (!why) return;
                startTransition(async () => {
                  const res = await deleteAttachment(p.attachmentId, why);
                  onRemoved(res?.error ?? "");
                  if (!res?.error) toast({ message: `Removed ${file.fileName} from ${p.label}` });
                });
              }}>×</button>
          )}
        </span>
      ))}
      {records.length > 2 && <span className="mut t-meta">+{records.length - 2}</span>}
    </>
  );
}
