"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { setCatalogDocTypes } from "@/app/actions";
import { toast } from "@/components/ui/Toast";
import { DOC_TYPES } from "@/lib/gxp";

export type PackageEntry = {
  id: number;
  kind: string;        // 'category' | 'asset_type' | 'model'
  assetType: string;
  name: string;
  docTypes: string[];
};

const SECTIONS: { kind: string; title: string; blurb: string }[] = [
  { kind: "model", title: "Models", blurb: "What this model owes wherever it lands - an Altis needs its IQ and OQ protocols on every regulated system." },
  { kind: "asset_type", title: "Module types", blurb: "Owed by every unit of the type, whatever the model." },
  { kind: "category", title: "System types", blurb: "What the system itself owes - URS, validation plan - beyond its modules." },
];

/**
 * Validation packages, declared once on the catalog.
 *
 * The same declare-once move as gas requirements: say what an Altis owes here,
 * and every regulated system it lands on shows the checklist with the holes
 * visible. Derived at read time, never copied, so refining the package updates
 * every checklist at once. Unregulated systems never see any of it.
 *
 * One row expands at a time - thirteen toggle chips on forty collapsed rows is
 * not a form anybody can read.
 */
export default function CatalogPackageCard({ entries }: { entries: PackageEntry[] }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [expanded, setExpanded] = useState<number | null>(null);
  const [error, setError] = useState("");
  const [pending, startTransition] = useTransition();

  const toggle = (e: PackageEntry, t: string) => {
    const next = e.docTypes.some((x) => x.toLowerCase() === t.toLowerCase())
      ? e.docTypes.filter((x) => x.toLowerCase() !== t.toLowerCase())
      : [...e.docTypes, t];
    setError("");
    startTransition(async () => {
      const res = await setCatalogDocTypes(e.id, next);
      if (res?.error) { setError(res.error); return; }
      toast({ message: `Saved the package for ${e.name}` });
      router.refresh();
    });
  };

  const declared = entries.filter((e) => e.docTypes.length);

  return (
    <div className="card">
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
        <div className="card-title">Validation packages</div>
        <span className="mut t-meta">
          {declared.length ? `${declared.length} declared` : "none declared yet"}
        </span>
        <button className="btn sm" style={{ marginLeft: "auto" }} onClick={() => setOpen((v) => !v)}>
          {open ? "Done" : "Edit"}
        </button>
      </div>
      <div className="mut t-small" style={{ marginBottom: 8 }}>
        The documents a kind of equipment owes on a <b>regulated (GxP)</b> system - IQ/OQ/PQ
        protocols and reports, URS, certs. Declared here once, every regulated system that matches
        shows the checklist with the gaps visible. Systems not marked GxP ignore all of it.
      </div>

      {!open && (
        declared.length === 0 ? (
          <div className="empty">
            <b>Nothing declared yet</b>
            Hit Edit and say what an Altis (or any LC-MS) owes - IQ protocol, OQ protocol, reports -
            and every regulated system with one arrives with the checklist.
          </div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            {declared.map((e) => (
              <div key={e.id} style={{ display: "flex", gap: 8, alignItems: "baseline", flexWrap: "wrap", padding: "5px 0", borderTop: "1px solid var(--line)" }}>
                <span className="t-body" style={{ fontWeight: 600 }}>{e.name}</span>
                <span className="mut t-meta">
                  {e.kind === "model" ? e.assetType : e.kind === "asset_type" ? "module type" : "system type"}
                </span>
                <span style={{ display: "flex", gap: 4, marginLeft: "auto", flexWrap: "wrap", justifyContent: "flex-end" }}>
                  {e.docTypes.map((t) => (
                    <span key={t} className="pill accent">{t}</span>
                  ))}
                </span>
              </div>
            ))}
          </div>
        )
      )}

      {open && (
        <input className="input" value={q} onChange={(e) => setQ(e.target.value)}
          placeholder="Filter by name - Altis, Mass Spec, LC-MS..." style={{ marginBottom: 4 }} />
      )}

      {open && SECTIONS.map((sec) => {
        const all = entries.filter((e) => e.kind === sec.kind);
        const rows = q.trim()
          ? all.filter((e) => `${e.name} ${e.assetType}`.toLowerCase().includes(q.trim().toLowerCase()))
          : all;
        if (!all.length || (q.trim() && !rows.length)) return null;
        const set = all.filter((e) => e.docTypes.length).length;
        return (
          <details key={sec.kind} open={!!q.trim() || undefined} style={{ marginTop: 10 }}>
            <summary style={{ cursor: "pointer", display: "flex", gap: 8, alignItems: "baseline", flexWrap: "wrap" }}>
              <span className="eyebrow">{sec.title}</span>
              <span className="mut t-meta">
                {q.trim() ? `${rows.length} of ${all.length}` : `${all.length}`}
                {set > 0 && ` · ${set} declared`}
              </span>
            </summary>
            <div className="mut t-meta" style={{ margin: "4px 0" }}>{sec.blurb}</div>
            {rows.map((e) => (
              <div key={e.id} style={{ padding: "6px 0", borderTop: "1px solid var(--line)" }}>
                <div className="row-hover" onClick={() => setExpanded(expanded === e.id ? null : e.id)}
                  style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", cursor: "pointer" }}>
                  <span className="t-body" style={{ minWidth: 0, flex: "1 1 150px" }}>
                    {e.name}
                    {e.kind === "model" && e.assetType && <span className="mut t-meta"> · {e.assetType}</span>}
                  </span>
                  <span className="mut t-meta">
                    {e.docTypes.length ? `${e.docTypes.length} document${e.docTypes.length === 1 ? "" : "s"}` : "-"}
                  </span>
                  <span className="mut t-small">{expanded === e.id ? "▾" : "▸"}</span>
                </div>
                {expanded === e.id && (
                  <div style={{ display: "flex", gap: 4, flexWrap: "wrap", padding: "6px 0 2px" }}>
                    {DOC_TYPES.map((t) => {
                      const on = e.docTypes.some((x) => x.toLowerCase() === t.toLowerCase());
                      return (
                        <button key={t} type="button" disabled={pending}
                          className={on ? "btn sm primary" : "btn sm"} style={{ fontSize: 11 }}
                          aria-pressed={on} onClick={() => toggle(e, t)}>
                          {t}
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>
            ))}
          </details>
        );
      })}

      {error && <div className="t-small" style={{ color: "var(--t-bad-fg)", marginTop: 8 }}>{error}</div>}
    </div>
  );
}
