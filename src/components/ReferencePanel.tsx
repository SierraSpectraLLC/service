"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { addCatalogRef, listStoreFilesForRef, removeCatalogRef } from "@/app/actions";
import { looksLikeImage, refScopeLabel } from "@/lib/catalogRefs";
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
  title: string; url: string; body: string; createdBy: string; when: string;
  /** '' | original | facts | oem - see lib/provenance. */
  provenance?: string;
};

export type RefScope = { assetType: string; model: string; label: string };

/**
 * The reference shelf for a piece of equipment: manuals, links and field notes
 * filed on the MODEL (or the module type), so what one engineer learns on one
 * unit is in front of the next engineer on every unit like it.
 *
 * Rendered on a system page (scopes = its modules), a unit page (its model),
 * and the catalog itself (every model). The rows are the same rows everywhere -
 * that is the point.
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
  // is the normal case; "web" is for a manual still on the manufacturer's site.
  const [source, setSource] = useState<"shelf" | "web">("shelf");
  const [picked, setPicked] = useState<PickFile | null>(null);
  const [files, setFiles] = useState<PickFile[] | "loading" | null>(null);
  const [fileFilter, setFileFilter] = useState("");
  const [error, setError] = useState("");
  const [pending, startTransition] = useTransition();

  const loadFiles = () => {
    if (files !== null) return;
    setFiles("loading");
    startTransition(async () => {
      try { setFiles((await listStoreFilesForRef()).files); }
      catch { setFiles([]); setError("Couldn't load the file shelf"); }
    });
  };
  const reset = () => {
    setDraft({ kind: "link", scope: draft.scope, title: "", url: "", body: "", provenance: "" });
    setPicked(null); setFileFilter("");
  };

  const save = () => {
    const scope = scopes[draft.scope];
    if (!scope) return;
    setError("");
    startTransition(async () => {
      const res = await addCatalogRef({
        assetType: scope.assetType, model: scope.model,
        kind: draft.kind,
        // A shelf file needs no title typed: its own name is one.
        title: draft.title || (source === "shelf" ? picked?.fileName ?? "" : ""),
        url: source === "shelf" ? (picked ? `/api/files/${picked.id}` : "") : draft.url,
        body: draft.body,
        provenance: draft.provenance,
      });
      if (res?.error) { setError(res.error); return; }
      reset();
      setOpen(false);
      router.refresh();
    });
  };

  // Grouped by where they are filed, so "Thermo Altis" reads as one shelf.
  const groups = [...new Set(refs.map((r) => refScopeLabel(r)))];

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
        <Dialog open onClose={() => setOpen(false)} title="File a reference"
          footer={
            <>
              <span className={`dialog-status${error ? " err" : ""}`}>{error}</span>
              <button className="btn" onClick={() => setOpen(false)} disabled={pending}>Cancel</button>
              <button className="btn accent" onClick={save} disabled={pending}>
                {pending ? "Saving..." : "File it"}
              </button>
            </>
          }>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 8 }}>
            <div className="seg" role="group" aria-label="Reference kind">
              {(["link", "note"] as const).map((k) => (
                <button key={k} type="button" aria-pressed={draft.kind === k}
                  onClick={() => setDraft({ ...draft, kind: k })}>
                  {k === "link" ? "↗ Link" : "✎ Note"}
                </button>
              ))}
            </div>
            <select value={draft.scope} aria-label="Filed under" className="t-small"
              onChange={(e) => setDraft({ ...draft, scope: parseInt(e.target.value) })}
              style={{ width: "auto" }}>
              {scopes.map((s, i) => <option key={`${s.assetType}|${s.model}`} value={i}>{s.label}</option>)}
            </select>
          </div>
          <label>Title <span className="mut" style={{ fontWeight: 400 }}>(a chosen file names itself)</span></label>
          <input value={draft.title} placeholder={draft.kind === "link" ? "Altis service manual" : "H-ESI needle & seal install"}
            onChange={(e) => setDraft({ ...draft, title: e.target.value })} style={{ marginBottom: 8 }} />

          {/* Point at a file, don't retype its address. Most of what belongs
              here is already uploaded - the manuals on the shelf, the photos on
              records - so browsing them is the default and a web address is
              the special case, not the other way round. */}
          <label>{draft.kind === "link" ? "What it points at *" : "Picture or document (optional)"}</label>
          <div className="seg" role="group" aria-label="Where the file is" style={{ marginBottom: 8 }}>
            <button type="button" aria-pressed={source === "shelf"}
              onClick={() => { setSource("shelf"); loadFiles(); }}>Our files</button>
            <button type="button" aria-pressed={source === "web"}
              onClick={() => setSource("web")}>Web link</button>
          </div>

          {source === "web" ? (
            <input className="mono" value={draft.url} placeholder="https://..."
              onChange={(e) => setDraft({ ...draft, url: e.target.value })} style={{ marginBottom: 8 }} />
          ) : picked ? (
            <div style={{ display: "flex", gap: 8, alignItems: "center", padding: "6px 8px", marginBottom: 8,
              border: "1px solid var(--line)", borderRadius: 8, background: "#fff" }}>
              <span aria-hidden className="t-body">{picked.isPhoto ? "▣" : "▢"}</span>
              <span className="mono t-small" style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {picked.fileName}
              </span>
              <span className="mut t-meta">{picked.where}</span>
              <button className="btn link" style={{ marginLeft: "auto" }}
                onClick={() => setPicked(null)}>change</button>
            </div>
          ) : (
            <div style={{ border: "1px solid var(--line)", borderRadius: 8, background: "#fff", padding: 8, marginBottom: 8 }}>
              <input value={fileFilter} onChange={(e) => setFileFilter(e.target.value)}
                placeholder="Filter by name, description or where it lives"
                className="t-small" style={{ marginBottom: 6 }} aria-label="Filter files" />
              {files === "loading" && <div className="mut t-small">Loading the shelf…</div>}
              {Array.isArray(files) && files.length === 0 && (
                <div className="mut t-small">
                  Nothing stored yet. Upload manuals under Library → Files, then point at them here.
                </div>
              )}
              {Array.isArray(files) && (() => {
                const needle = fileFilter.trim().toLowerCase();
                const shown = files.filter((f) => !needle
                  || `${f.fileName} ${f.description} ${f.where}`.toLowerCase().includes(needle));
                if (!shown.length) return <div className="mut t-small">Nothing matches that.</div>;
                return (
                  <div style={{ maxHeight: 200, overflowY: "auto" }}>
                    {shown.slice(0, 200).map((f) => (
                      <button key={f.id} type="button" className="row-hover"
                        onClick={() => { setPicked(f); setError(""); }}
                        style={{ display: "flex", gap: 8, alignItems: "baseline", width: "100%", textAlign: "left",
                          padding: "5px 4px", border: "none", background: "none", cursor: "pointer",
                          borderTop: "1px solid var(--line)" }}>
                        <span aria-hidden className="t-small">{f.isPhoto ? "▣" : "▢"}</span>
                        <span className="mono t-small" style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                          {f.fileName}
                        </span>
                        <span className="mut t-meta">{f.where}</span>
                        <span className="mut t-meta" style={{ marginLeft: "auto", flexShrink: 0 }}>{fmtBytes(f.size)}</span>
                      </button>
                    ))}
                  </div>
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
              and simply stays out of anything licensed. */}
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
                      body: "It disappears from every unit that shows it.",
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
