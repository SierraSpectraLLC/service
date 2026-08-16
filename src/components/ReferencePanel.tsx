"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { addCatalogRef, removeCatalogRef } from "@/app/actions";
import { looksLikeImage, refScopeLabel } from "@/lib/catalogRefs";

export type RefRow = {
  id: number; assetType: string; model: string; kind: string;
  title: string; url: string; body: string; createdBy: string; when: string;
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
  const [draft, setDraft] = useState({ kind: "link", scope: 0, title: "", url: "", body: "" });
  const [error, setError] = useState("");
  const [pending, startTransition] = useTransition();

  const save = () => {
    const scope = scopes[draft.scope];
    if (!scope) return;
    setError("");
    startTransition(async () => {
      const res = await addCatalogRef({
        assetType: scope.assetType, model: scope.model,
        kind: draft.kind, title: draft.title, url: draft.url, body: draft.body,
      });
      if (res?.error) { setError(res.error); return; }
      setDraft({ kind: "link", scope: draft.scope, title: "", url: "", body: "" });
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
        {canEdit && scopes.length > 0 && (
          <button className="btn sm" style={{ marginLeft: "auto" }} onClick={() => { setOpen((v) => !v); setError(""); }}>
            {open ? "Cancel" : "+ Add"}
          </button>
        )}
      </div>
      <div className="mut" style={{ fontSize: 11, marginBottom: 8 }}>
        {sub ?? "Manuals, links and field notes, filed on the model in the catalog - every system with this equipment sees the same shelf."}
      </div>

      {open && (
        <div className="dash-form">
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 8 }}>
            <div className="seg" role="group" aria-label="Reference kind">
              {(["link", "note"] as const).map((k) => (
                <button key={k} type="button" aria-pressed={draft.kind === k}
                  onClick={() => setDraft({ ...draft, kind: k })}>
                  {k === "link" ? "🔗 Link" : "✎ Note"}
                </button>
              ))}
            </div>
            <select value={draft.scope} aria-label="Filed under"
              onChange={(e) => setDraft({ ...draft, scope: parseInt(e.target.value) })}
              style={{ width: "auto", fontSize: 12 }}>
              {scopes.map((s, i) => <option key={`${s.assetType}|${s.model}`} value={i}>{s.label}</option>)}
            </select>
          </div>
          <label>Title</label>
          <input value={draft.title} placeholder={draft.kind === "link" ? "Altis service manual" : "H-ESI needle & seal install"}
            onChange={(e) => setDraft({ ...draft, title: e.target.value })} style={{ marginBottom: 8 }} />
          <label>{draft.kind === "link" ? "URL *" : "Picture or file URL (optional)"}</label>
          <input className="mono" value={draft.url}
            placeholder={draft.kind === "link" ? "https://..." : "Paste a photo's link from the gallery, or any URL"}
            onChange={(e) => setDraft({ ...draft, url: e.target.value })} style={{ marginBottom: 8 }} />
          {draft.kind === "note" && (
            <>
              <label>The note *</label>
              <textarea value={draft.body} rows={3} style={{ width: "100%", marginBottom: 8 }}
                placeholder="What the next engineer needs to know"
                onChange={(e) => setDraft({ ...draft, body: e.target.value })} />
            </>
          )}
          {error && <div style={{ fontSize: 12, color: "#A32D2D", marginBottom: 8 }}>{error}</div>}
          <button className="btn sm accent" onClick={save} disabled={pending}>
            {pending ? "Saving..." : "File it"}
          </button>
        </div>
      )}

      {groups.map((g) => (
        <div key={g} style={{ marginBottom: 6 }}>
          <div className="eyebrow" style={{ margin: "6px 0 2px" }}>{g}</div>
          {refs.filter((r) => refScopeLabel(r) === g).map((r) => (
            <div key={r.id} style={{ display: "flex", gap: 8, alignItems: "flex-start", padding: "6px 0", borderTop: "1px solid var(--line)" }}>
              <span aria-hidden style={{ fontSize: 12, marginTop: 1 }}>{r.kind === "link" ? "🔗" : "✎"}</span>
              <div style={{ flex: 1, minWidth: 0 }}>
                {r.kind === "link" ? (
                  <a href={r.url} target="_blank" rel="noreferrer" style={{ fontSize: 13, fontWeight: 600 }}>
                    {r.title || r.url} ↗
                  </a>
                ) : (
                  <>
                    {r.title && <div style={{ fontSize: 13, fontWeight: 700 }}>{r.title}</div>}
                    {r.body && <div style={{ fontSize: 12.5, whiteSpace: "pre-wrap" }}>{r.body}</div>}
                    {r.url && (looksLikeImage(r.url) ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <a href={r.url} target="_blank" rel="noreferrer">
                        <img src={r.url} alt={r.title || "reference"} style={{ maxHeight: 120, maxWidth: "100%", borderRadius: 6, marginTop: 4, display: "block" }} />
                      </a>
                    ) : (
                      <a href={r.url} target="_blank" rel="noreferrer" style={{ fontSize: 12 }}>attachment ↗</a>
                    ))}
                  </>
                )}
                <div className="mut" style={{ fontSize: 10.5, marginTop: 2 }}>{r.createdBy}{r.when ? ` · ${r.when}` : ""}</div>
              </div>
              {canEdit && (
                <button className="btn link" aria-label={`Remove ${r.title || "reference"}`} disabled={pending}
                  style={{ color: "#A32D2D", fontSize: 13 }}
                  onClick={() => {
                    if (!window.confirm(`Remove this from ${g}? It disappears from every unit that shows it.`)) return;
                    startTransition(async () => { await removeCatalogRef(r.id); router.refresh(); });
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
