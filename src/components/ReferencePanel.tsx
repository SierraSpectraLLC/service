"use client";

import { useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { upload } from "@vercel/blob/client";
import { addCatalogRef, listStoreFilesForRef, myCloudConnection, recordLibraryFiles, removeCatalogRef } from "@/app/actions";
import { looksLikeImage, refScopeLabel } from "@/lib/catalogRefs";
import { itemKey, type CloudItem } from "@/lib/cloudItems";
import CloudBrowser from "./CloudBrowser";
import ProvenanceChip from "./ProvenanceChip";
import { PROVENANCE_BLURB, PROVENANCE_CHOICES, PROVENANCE_LABEL, tallyLine, tallyProvenance } from "@/lib/provenance";
import { fmtBytes } from "@/lib/storage";
import { confirmDialog } from "@/components/ui/ConfirmDialog";
import { toast } from "@/components/ui/Toast";
import Dialog from "@/components/ui/Dialog";

type PickFile = {
  id: number; fileName: string; kind: string; description: string; size: number;
  isPhoto: boolean; where: string;
};

export type RefRow = {
  id: number; assetType: string; model: string; kind: string;
  /** The family a model-less reference is filed on - "every ISQ". */
  series?: string;
  title: string; url: string; body: string; createdBy: string; when: string;
  /** '' | original | facts | oem - see lib/provenance. */
  provenance?: string;
};

/**
 * Somewhere a reference may be filed: one model, every model of a family
 * (`series`, with `model` blank), or the whole module type (both blank).
 */
export type RefScope = { assetType: string; model: string; series?: string; label: string };

/** What myCloudConnection answers, once asked. */
type CloudState = { configured: boolean; account: string; brokenReason: string; setupProblem: string };

/**
 * The reference shelf for a piece of equipment: manuals, links and field notes
 * filed on the MODEL (or the module type), so what one engineer learns on one
 * unit is in front of the next engineer on every unit like it.
 *
 * Rendered on a system page (scopes = its modules), a unit page (its model),
 * and the catalog itself (every model). The rows are the same rows everywhere -
 * that is the point.
 *
 * Filing takes several files at once. A manufacturer's folder holds the whole
 * set for a family - hardware manual, user guide, preinstallation guide,
 * service manual - and filing them under "every ISQ" is one act, not four
 * trips through this dialog. Each file names its own reference; a typed title
 * applies only when one thing is being filed.
 */
export default function ReferencePanel({ refs, scopes, canEdit, sub }: {
  refs: RefRow[];
  /** Where a new reference may be filed - the equipment in front of the viewer. */
  scopes: RefScope[];
  canEdit: boolean;
  sub?: string;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState({ kind: "link", scope: 0, title: "", url: "", body: "", provenance: "" });
  // Where the thing being linked lives. "shelf" browses what the shop already
  // has - the manuals somebody uploaded, the photos already on records - which
  // is the normal case; "cloud" is the connected OneDrive, Teams or SharePoint,
  // copied in as it is filed; "web" is for a manual still on the maker's site.
  const [source, setSource] = useState<"shelf" | "web" | "upload" | "cloud">("shelf");
  const fileInput = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState("");
  const [picked, setPicked] = useState<PickFile[]>([]);
  const [cloudPicked, setCloudPicked] = useState<CloudItem[]>([]);
  const [cloud, setCloud] = useState<CloudState | "loading" | null>(null);
  const [files, setFiles] = useState<PickFile[] | "loading" | null>(null);
  const [fileFilter, setFileFilter] = useState("");
  const [progress, setProgress] = useState("");
  const [error, setError] = useState("");
  const [pending, startTransition] = useTransition();

  // A note carries one picture; a link shelf takes as many files as are ticked.
  const single = draft.kind === "note";
  const chosen = picked.length + cloudPicked.length;

  const loadFiles = () => {
    if (files !== null) return;
    setFiles("loading");
    startTransition(async () => {
      try { setFiles((await listStoreFilesForRef()).files); }
      catch { setFiles([]); setError("Couldn't load the file shelf"); }
    });
  };
  // Asked only when the tab is opened: most references come off the shelf, and
  // the connection belongs to the person, so it is theirs to answer for.
  const loadCloud = () => {
    if (cloud !== null) return;
    setCloud("loading");
    startTransition(async () => {
      try { setCloud(await myCloudConnection()); }
      catch { setCloud({ configured: false, account: "", brokenReason: "", setupProblem: "" }); }
    });
  };

  const toggleShelf = (f: PickFile) => {
    setError("");
    setPicked((ps) => ps.some((p) => p.id === f.id) ? ps.filter((p) => p.id !== f.id) : single ? [f] : [...ps, f]);
  };
  const toggleCloud = (i: CloudItem) => {
    setError("");
    setCloudPicked((cs) => cs.some((c) => itemKey(c) === itemKey(i))
      ? cs.filter((c) => itemKey(c) !== itemKey(i)) : single ? [i] : [...cs, i]);
  };

  /*
   * Upload, then point at what was uploaded.
   *
   * The manual for the machine in front of somebody is, more often than not, a
   * PDF on their laptop rather than a file already on the shelf - and telling
   * them to go to Library, upload it, come back and find it is three screens to
   * file one reference. So this lands the file on the same shelf the browser
   * reads (it IS a library file afterwards, findable and reusable) and then
   * simply arrives among `picked`, which is where browsing already ends up. One
   * save path, whichever way the file got here.
   */
  const sendFile = async (list: FileList | null) => {
    const file = Array.from(list ?? [])[0];
    if (!file) return;
    setError("");
    setUploading(`${file.name} (${fmtBytes(file.size)})`);
    try {
      const blob = await upload(file.name, file, { access: "public", handleUploadUrl: "/api/upload" });
      const res = await recordLibraryFiles(
        [{ fileName: file.name, url: blob.url, size: file.size, description: "" }],
      );
      if (res.error) throw new Error(res.error);
      const id = res.ids?.[0];
      if (id === undefined) throw new Error("The file uploaded but was not filed");
      const mine: PickFile = {
        id, fileName: file.name, kind: "Report", description: "", size: file.size,
        isPhoto: looksLikeImage(file.name), where: "just uploaded",
      };
      setPicked((ps) => (single ? [mine] : [...ps, mine]));
      // It is on the shelf now, so a second reference in the same sitting finds
      // it by browsing rather than by uploading it again.
      setFiles(null);
      setSource("shelf");
    } catch (e) {
      // Named, because a silent stop here looks exactly like it worked.
      setError(`${file.name}: ${(e as Error).message}`);
    } finally {
      setUploading("");
      if (fileInput.current) fileInput.current.value = "";
    }
  };

  /**
   * Copy one OneDrive file onto our shelf and answer its library id - the same
   * route and the same three steps CloudLibraryCard takes, because a reference
   * must outlive the connection it was filed through: the person who connected
   * that account leaves, the folder gets renamed, and the manual must still
   * open for whoever is standing at the instrument.
   */
  const copyIn = async (item: CloudItem): Promise<number> => {
    const q = new URLSearchParams({ item: item.id, drive: item.driveId });
    const res = await fetch(`/api/cloud/file?${q}`);
    if (!res.ok) throw new Error((await res.text()) || `Microsoft would not send ${item.name}`);
    const blob = await res.blob();
    const put = await upload(item.name, blob, { access: "public", handleUploadUrl: "/api/upload" });
    const rec = await recordLibraryFiles([{ fileName: item.name, url: put.url, size: blob.size, description: "" }]);
    if (rec?.error) throw new Error(rec.error);
    const id = rec.ids?.[0];
    if (id === undefined) throw new Error("copied, but not filed on the shelf");
    return id;
  };

  const reset = () => {
    setDraft({ kind: "link", scope: draft.scope, title: "", url: "", body: "", provenance: "" });
    setPicked([]); setCloudPicked([]); setFileFilter(""); setProgress("");
  };

  const save = () => {
    const scope = scopes[draft.scope];
    if (!scope) return;
    setError("");
    const where = {
      assetType: scope.assetType, model: scope.model, series: scope.series ?? "",
      kind: draft.kind, body: draft.body, provenance: draft.provenance,
    };
    // A web address, or a note with no picture: one reference, as typed.
    if (source === "web" || chosen === 0) {
      startTransition(async () => {
        const res = await addCatalogRef({ ...where, title: draft.title, url: source === "web" ? draft.url : "" });
        if (res?.error) { setError(res.error); return; }
        reset();
        setOpen(false);
        router.refresh();
      });
      return;
    }
    // One reference per chosen file, in the order they were ticked: shelf
    // files first (nothing to move), then each OneDrive file copied in as its
    // turn comes. A failure is named and the file stays ticked, so what did
    // not get filed can be tried again without re-finding it; what did get
    // filed is not filed twice.
    startTransition(async () => {
      const total = chosen;
      const title = total === 1 ? draft.title : "";
      const failed: string[] = [];
      const shelfLeft: PickFile[] = [];
      const cloudLeft: CloudItem[] = [];
      let n = 0, filed = 0;
      for (const f of picked) {
        n++;
        setProgress(`Filing ${n} of ${total}: ${f.fileName}`);
        const res = await addCatalogRef({ ...where, title: title || f.fileName, url: `/api/files/${f.id}` });
        if (res?.error) { failed.push(`${f.fileName}: ${res.error}`); shelfLeft.push(f); } else filed++;
      }
      for (const c of cloudPicked) {
        n++;
        setProgress(`Copying ${n} of ${total}: ${c.name}`);
        try {
          const id = await copyIn(c);
          const res = await addCatalogRef({ ...where, title: title || c.name, url: `/api/files/${id}` });
          if (res?.error) throw new Error(res.error);
          filed++;
        } catch (e) {
          failed.push(`${c.name}: ${(e as Error).message}`);
          cloudLeft.push(c);
        }
      }
      setProgress("");
      if (filed > 0) {
        toast({ message: `Filed ${filed} reference${filed === 1 ? "" : "s"} under ${scope.label}` });
        // Copied-in files are on the shelf now; the next browse should show them.
        if (cloudPicked.length > cloudLeft.length) setFiles(null);
        router.refresh();
      }
      if (failed.length) {
        setPicked(shelfLeft);
        setCloudPicked(cloudLeft);
        setError(`${failed.length} not filed - ${failed.join(" · ")}`);
        return;
      }
      reset();
      setOpen(false);
    });
  };

  // Grouped by where they are filed, so "Thermo Altis" reads as one shelf.
  const groups = [...new Set(refs.map((r) => refScopeLabel(r)))];

  const chosenNames = [...picked.map((p) => p.fileName), ...cloudPicked.map((c) => c.name)];

  return (
    <div className="card">
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
        <div className="card-title">Reference</div>
        {/* How much of this shelf could travel with a licensed library. */}
        {canEdit && refs.length > 0 && (
          <span className="mut" style={{ fontSize: 11 }}>{tallyLine(tallyProvenance(refs))}</span>
        )}
        {canEdit && scopes.length > 0 && (
          <button className="btn sm" style={{ marginLeft: "auto" }}
            onClick={() => { const next = !open; setOpen(next); setError(""); if (next) loadFiles(); }}>
            {open ? "Cancel" : "+ Add"}
          </button>
        )}
      </div>
      <div className="mut t-meta" style={{ marginBottom: 8 }}>
        {sub ?? "Manuals, links and field notes, filed on the model in the catalog - every system with this equipment sees the same shelf."}
      </div>

      {open && (
        <Dialog open onClose={() => { if (!pending) setOpen(false); }} title="File a reference"
          footer={
            <>
              <span className={`dialog-status${error ? " err" : ""}`}>{progress || error}</span>
              <button className="btn" onClick={() => setOpen(false)} disabled={pending}>Cancel</button>
              <button className="btn accent" onClick={save} disabled={pending}>
                {pending ? "Saving..." : chosen > 1 ? `File ${chosen}` : "File it"}
              </button>
            </>
          }>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 8 }}>
            <div className="seg" role="group" aria-label="Reference kind">
              {(["link", "note"] as const).map((k) => (
                <button key={k} type="button" aria-pressed={draft.kind === k}
                  onClick={() => {
                    setDraft({ ...draft, kind: k });
                    // A note takes one picture: keep the first of what was ticked.
                    if (k === "note" && chosen > 1) { setPicked((ps) => ps.slice(0, 1)); setCloudPicked((cs) => (picked.length ? [] : cs.slice(0, 1))); }
                  }}>
                  {k === "link" ? "↗ Link" : "✎ Note"}
                </button>
              ))}
            </div>
            <select value={draft.scope} aria-label="Filed under" className="t-small"
              onChange={(e) => setDraft({ ...draft, scope: parseInt(e.target.value) })}
              style={{ width: "auto" }}>
              {scopes.map((s, i) => <option key={`${s.assetType}|${s.model}|${s.series ?? ""}`} value={i}>{s.label}</option>)}
            </select>
          </div>
          <label>
            Title{" "}
            <span className="mut" style={{ fontWeight: 400 }}>
              {chosen > 1 ? `(each of the ${chosen} files names itself)` : "(a chosen file names itself)"}
            </span>
          </label>
          <input value={draft.title} disabled={chosen > 1}
            placeholder={chosen > 1 ? "" : draft.kind === "link" ? "Altis service manual" : "H-ESI needle & seal install"}
            onChange={(e) => setDraft({ ...draft, title: e.target.value })} style={{ marginBottom: 8 }} />

          {/* Point at a file, don't retype its address. Most of what belongs
              here is already uploaded - the manuals on the shelf, the photos on
              records - so browsing them is the default and a web address is
              the special case, not the other way round. */}
          <label>{draft.kind === "link" ? "What it points at *" : "Picture or document (optional)"}</label>
          <div className="seg" role="group" aria-label="Where the file is" style={{ marginBottom: 8 }}>
            <button type="button" aria-pressed={source === "shelf"}
              onClick={() => { setSource("shelf"); loadFiles(); }}>Our files</button>
            <button type="button" aria-pressed={source === "cloud"}
              onClick={() => { setSource("cloud"); loadCloud(); }}>OneDrive</button>
            <button type="button" aria-pressed={source === "upload"}
              onClick={() => setSource("upload")}>Upload</button>
            <button type="button" aria-pressed={source === "web"}
              onClick={() => setSource("web")}>Web link</button>
          </div>

          {/* What is ticked so far, from either list - visible whichever tab is
              showing, so three off the shelf and four from OneDrive read as
              one set of seven about to be filed. */}
          {chosen > 0 && source !== "web" && (
            <div className="t-meta" style={{ display: "flex", gap: 8, alignItems: "baseline", padding: "6px 8px", marginBottom: 8,
              border: "1px solid var(--line)", borderRadius: 8, background: "#fff" }}>
              <span style={{ minWidth: 0, flex: 1 }}>
                <b>{chosen} chosen</b>
                <span className="mut">
                  {" · "}{chosenNames.slice(0, 5).join(", ")}{chosenNames.length > 5 ? ` and ${chosenNames.length - 5} more` : ""}
                </span>
              </span>
              <button className="btn link t-meta" style={{ flexShrink: 0 }} disabled={pending}
                onClick={() => { setPicked([]); setCloudPicked([]); }}>clear</button>
            </div>
          )}

          {source === "upload" ? (
            <div style={{ border: "1px solid var(--line)", borderRadius: 8, background: "#fff",
              padding: 10, marginBottom: 8 }}>
              <input ref={fileInput} type="file" aria-label="File to upload"
                disabled={!!uploading || pending}
                onChange={(e) => { void sendFile(e.target.files); }} />
              <div className="mut t-meta" style={{ marginTop: 6 }}>
                {uploading
                  ? `Uploading ${uploading}…`
                  : "It lands under Library → Documents as well, so the next person can find it there."}
              </div>
            </div>
          ) : source === "web" ? (
            <input className="mono" value={draft.url} placeholder="https://..."
              onChange={(e) => setDraft({ ...draft, url: e.target.value })} style={{ marginBottom: 8 }} />
          ) : source === "cloud" ? (
            <div style={{ border: "1px solid var(--line)", borderRadius: 8, background: "#fff", padding: "0 8px 8px", marginBottom: 8 }}>
              {(cloud === null || cloud === "loading") && <div className="mut t-small" style={{ paddingTop: 8 }}>Checking the connection…</div>}
              {cloud !== null && cloud !== "loading" && !cloud.configured && (
                <div className="mut t-small" style={{ paddingTop: 8 }}>
                  {cloud.setupProblem || "OneDrive is not set up on this portal yet."}
                </div>
              )}
              {cloud !== null && cloud !== "loading" && cloud.configured && (
                <>
                  <div className="mut t-meta" style={{ paddingTop: 8 }}>
                    Tick what to file{single ? "" : " - a whole folder at once if you like"}. Each file is copied onto our shelf as it is
                    filed, so the reference keeps working after the connection is gone.
                  </div>
                  <CloudBrowser account={cloud.account} brokenReason={cloud.brokenReason} pdfOnly={false}
                    onToggle={toggleCloud} selectedKeys={new Set(cloudPicked.map(itemKey))} disabled={pending} />
                </>
              )}
            </div>
          ) : (
            <div style={{ border: "1px solid var(--line)", borderRadius: 8, background: "#fff", padding: 8, marginBottom: 8 }}>
              <input value={fileFilter} onChange={(e) => setFileFilter(e.target.value)}
                placeholder="Filter by name, description or where it lives"
                className="t-small" style={{ marginBottom: 6 }} aria-label="Filter files" />
              {files === "loading" && <div className="mut t-small">Loading the shelf…</div>}
              {Array.isArray(files) && files.length === 0 && (
                <div className="mut t-small">
                  Nothing stored yet. Upload here, or put manuals under Library → Documents and point at them.
                </div>
              )}
              {Array.isArray(files) && (() => {
                const needle = fileFilter.trim().toLowerCase();
                const shown = files.filter((f) => !needle
                  || `${f.fileName} ${f.description} ${f.where}`.toLowerCase().includes(needle));
                if (!shown.length) return <div className="mut t-small">Nothing matches that.</div>;
                const listed = shown.slice(0, 200);
                const allOn = listed.every((f) => picked.some((p) => p.id === f.id));
                return (
                  <>
                    {/* The filtered set in one go: type "ISQ", tick every ISQ manual. */}
                    {!single && listed.length > 1 && (
                      <button type="button" className="btn link t-meta" style={{ marginBottom: 4 }} disabled={pending}
                        onClick={() => setPicked((ps) => allOn
                          ? ps.filter((p) => !listed.some((f) => f.id === p.id))
                          : [...ps, ...listed.filter((f) => !ps.some((p) => p.id === f.id))])}>
                        {allOn ? `clear the ${listed.length} shown` : `select all ${listed.length} shown`}
                      </button>
                    )}
                    <div style={{ maxHeight: 200, overflowY: "auto" }}>
                      {listed.map((f) => {
                        const on = picked.some((p) => p.id === f.id);
                        return (
                          <label key={f.id} className="row-hover"
                            style={{ display: "flex", gap: 8, alignItems: "baseline", width: "100%",
                              padding: "5px 4px", cursor: "pointer", borderTop: "1px solid var(--line)" }}>
                            <input type="checkbox" checked={on} disabled={pending} onChange={() => toggleShelf(f)}
                              aria-label={`Select ${f.fileName}`} style={{ alignSelf: "center" }} />
                            <span aria-hidden className="t-small">{f.isPhoto ? "▣" : "▢"}</span>
                            <span className="mono t-small" style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                              {f.fileName}
                            </span>
                            <span className="mut t-meta">{f.where}</span>
                            <span className="mut t-meta" style={{ marginLeft: "auto", flexShrink: 0 }}>{fmtBytes(f.size)}</span>
                          </label>
                        );
                      })}
                    </div>
                  </>
                );
              })()}
            </div>
          )}
          {draft.kind === "note" && (
            <>
              <label>The note *</label>
              <textarea value={draft.body} rows={3} style={{ width: "100%", marginBottom: 8 }}
                placeholder="What the next engineer needs to know"
                onChange={(e) => setDraft({ ...draft, body: e.target.value })} />
            </>
          )}
          {/* Asked while it is being written, which is the only moment anybody
              actually knows the answer. Skippable - an unreviewed row is honest,
              and simply stays out of anything licensed. Applies to every file
              being filed in this sitting - they came from the same place. */}
          <label>Where it came from <span className="mut" style={{ fontWeight: 400 }}>(decides what can be licensed on)</span></label>
          <select value={draft.provenance} aria-label="Where it came from" className="t-small"
            onChange={(e) => setDraft({ ...draft, provenance: e.target.value })}
            style={{ width: "auto", marginBottom: 4 }}>
            <option value="">Not saying yet</option>
            {PROVENANCE_CHOICES.map((c) => <option key={c} value={c}>{PROVENANCE_LABEL[c]}</option>)}
          </select>
          <div className="mut" style={{ fontSize: 11, marginBottom: 8 }}>
            {PROVENANCE_BLURB[(draft.provenance || "") as keyof typeof PROVENANCE_BLURB]}
          </div>
        </Dialog>
      )}

      {groups.map((g) => (
        <div key={g} style={{ marginBottom: 6 }}>
          <div className="eyebrow" style={{ margin: "6px 0 2px" }}>{g}</div>
          {refs.filter((r) => refScopeLabel(r) === g).map((r) => (
            <div key={r.id} style={{ display: "flex", gap: 8, alignItems: "flex-start", padding: "6px 0", borderTop: "1px solid var(--line)" }}>
              <span aria-hidden className="t-small" style={{ marginTop: 1 }}>{r.kind === "link" ? "↗" : "✎"}</span>
              <div style={{ flex: 1, minWidth: 0 }}>
                {r.kind === "link" ? (
                  <a href={r.url} target="_blank" rel="noreferrer" className="t-body" style={{ fontWeight: 600 }}>
                    {r.title || r.url} ↗
                  </a>
                ) : (
                  <>
                    {r.title && <div className="t-body" style={{ fontWeight: 700 }}>{r.title}</div>}
                    {r.body && <div style={{ fontSize: 13, whiteSpace: "pre-wrap" }}>{r.body}</div>}
                    {r.url && (looksLikeImage(r.url) ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <a href={r.url} target="_blank" rel="noreferrer">
                        <img src={r.url} alt={r.title || "reference"} style={{ maxHeight: 120, maxWidth: "100%", borderRadius: 6, marginTop: 4, display: "block" }} />
                      </a>
                    ) : (
                      <a href={r.url} target="_blank" rel="noreferrer" className="t-small">attachment ↗</a>
                    ))}
                  </>
                )}
                <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap", marginTop: 3 }}>
                  <span className="mut" style={{ fontSize: 11 }}>{r.createdBy}{r.when ? ` · ${r.when}` : ""}</span>
                  <ProvenanceChip what="ref" id={r.id} value={r.provenance ?? ""} canEdit={canEdit} />
                </div>
              </div>
              {canEdit && (
                <button className="btn link" aria-label={`Remove ${r.title || "reference"}`} disabled={pending}
                  style={{ color: "var(--t-bad-fg)", fontSize: 13 }}
                  onClick={async () => {
                    if (!(await confirmDialog({
                      title: `Remove this from ${g}?`,
                      body: r.series && !r.model
                        ? `It is filed on the whole ${r.series} family and disappears from every model in it.`
                        : "It disappears from every unit that shows it.",
                      action: "Remove reference", tone: "bad",
                    }))) return;
                    startTransition(async () => {
                      await removeCatalogRef(r.id);
                      toast({ message: `Removed the reference from ${g}` });
                      router.refresh();
                    });
                  }}>×</button>
              )}
            </div>
          ))}
        </div>
      ))}

      {refs.length === 0 && (
        <div className="empty">
          <b>Nothing filed yet</b>
          Link the service manual, or write down the thing that was tricky - filed on the
          model, it shows up on every system with one.
        </div>
      )}
    </div>
  );
}
