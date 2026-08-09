"use client";

import { useMemo, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import PickOrAdd from "./PickOrAdd";
import CatalogSelect from "./CatalogSelect";
import { createInstrument } from "@/app/actions";

type StageDefLite = { name: string; bg: string; fg: string };

type Row = {
  id: number; externalId: string; client: string; category: string; label: string; priority: number; lead: string;
  stages: string[]; notes: string; openParts: number; gasIssues: string[];
  overdue: number; assetIssues: string[]; missingFromSheet: boolean; lastActivity: string;
};

const Pill = ({ bg, fg, children }: { bg: string; fg: string; children: React.ReactNode }) => (
  <span className="pill" style={{ background: bg, color: fg }}>{children}</span>
);

export default function Dashboard({ data, stageDefs, people, clients, categories, canEdit, isStaff }: {
  data: Row[]; stageDefs: StageDefLite[]; people: string[];
  clients: string[]; categories: string[]; canEdit: boolean; isStaff: boolean;
}) {
  const router = useRouter();
  const stageNames = stageDefs.map((d) => d.name);
  const stageColor = (name: string) => stageDefs.find((d) => d.name === name) ?? { bg: "#EEF1F5", fg: "#475569" };
  const [selected, setSelected] = useState<string[]>([]);
  const [filterOpen, setFilterOpen] = useState(false);
  const [q, setQ] = useState("");
  const [showNew, setShowNew] = useState(false);
  const [draft, setDraft] = useState({ externalId: "", client: "", category: "", priority: "", lead: "" });
  const [pending, startTransition] = useTransition();

  const FLAGS = ["Overdue tasks", "Awaiting parts", "Gas attention", "Asset attention", ...(isStaff ? ["Not on sheet"] : [])];
  const LEADS = [...new Set(data.map((i) => i.lead).filter(Boolean))].sort();
  const CATS = [...new Set(data.map((i) => i.category).filter(Boolean))].sort();
  const catKey = (c: string) => `cat:${c}`;
  const leadKey = (l: string) => `lead:${l}`;
  const toggleFilter = (f: string) =>
    setSelected((s) => (s.includes(f) ? s.filter((x) => x !== f) : [...s, f]));

  const matchesFlag = (i: Row, f: string) =>
    f === "Overdue tasks" ? i.overdue > 0
    : f === "Awaiting parts" ? i.openParts > 0
    : f === "Gas attention" ? i.gasIssues.length > 0
    : f === "Asset attention" ? i.assetIssues.length > 0
    : f === "Not on sheet" ? i.missingFromSheet
    : true;

  const filtered = useMemo(() => {
    let list = data;
    // Stages and leads each combine as OR within their group; flags combine as AND.
    const stageSel = selected.filter((f) => stageNames.includes(f));
    const leadSel = selected.filter((f) => f.startsWith("lead:")).map((f) => f.slice(5));
    const catSel = selected.filter((f) => f.startsWith("cat:")).map((f) => f.slice(4));
    const flagSel = selected.filter((f) => !stageNames.includes(f) && !f.startsWith("lead:") && !f.startsWith("cat:"));
    if (stageSel.length) list = list.filter((i) => stageSel.some((s) => i.stages.includes(s)));
    if (leadSel.length) list = list.filter((i) => leadSel.includes(i.lead));
    if (catSel.length) list = list.filter((i) => catSel.includes(i.category));
    for (const f of flagSel) list = list.filter((i) => matchesFlag(i, f));
    if (q.trim()) {
      const s = q.toLowerCase();
      list = list.filter((i) =>
        [i.externalId, i.client, i.category, i.label, i.lead, i.notes, i.stages.join(" "), i.gasIssues.join(" "), i.assetIssues.join(" "),
          i.missingFromSheet ? "not on sheet" : "", i.lastActivity].join(" ").toLowerCase().includes(s)
      );
    }
    return list;
  }, [data, selected, q]);

  const counts = {
    total: data.length,
    blocked: data.filter((i) => i.stages.includes("Waiting / blocked")).length,
    waiting: data.filter((i) => i.openParts > 0).length,
    gas: data.filter((i) => i.gasIssues.length > 0).length,
    shipped: data.filter((i) => i.stages.includes("Shipped") || i.stages.includes("Waiting to ship")).length,
  };

  const submitNew = () => {
    if (!draft.externalId.trim()) return;
    startTransition(async () => {
      const id = await createInstrument({
        externalId: draft.externalId, client: draft.client, category: draft.category,
        priority: parseInt(draft.priority) || 99, lead: draft.lead,
      });
      setShowNew(false);
      setDraft({ externalId: "", client: "", category: "", priority: "", lead: "" });
      router.push(`/instruments/${id}`);
    });
  };

  return (
    <div className="container">
      <div className="metric-grid" style={{ marginBottom: 14 }}>
        {([
          ["Total systems", counts.total, "var(--navy)"],
          ["Waiting / blocked", counts.blocked, "#A32D2D"],
          ["Awaiting parts", counts.waiting, "#8A5410"],
          ["Gas attention", counts.gas, "#A33A1A"],
          ["Ship queue + shipped", counts.shipped, "#085041"],
        ] as [string, number, string][]).map(([label, n, color]) => (
          <div key={label} className="card" style={{ padding: "12px 14px", marginBottom: 0 }}>
            <div style={{ fontSize: 12 }} className="mut">{label}</div>
            <div style={{ fontSize: 26, fontWeight: 700, color }}>{n}</div>
          </div>
        ))}
      </div>

      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center", marginBottom: 12 }}>
        <div style={{ position: "relative" }}>
          <button className="btn sm" onClick={() => setFilterOpen((v) => !v)} style={{
            borderRadius: 999,
            borderColor: selected.length ? "var(--navy)" : "var(--line)",
            background: selected.length ? "var(--navy)" : "#fff",
            color: selected.length ? "#fff" : "var(--mut)",
          }}>
            Filter by{selected.length ? ` (${selected.length})` : ""} {filterOpen ? "▴" : "▾"}
          </button>
          {filterOpen && (
            <>
              <div onClick={() => setFilterOpen(false)} style={{ position: "fixed", inset: 0, zIndex: 20 }} />
              <div style={{
                position: "absolute", top: "calc(100% + 6px)", left: 0, zIndex: 21, background: "#fff",
                border: "1px solid var(--line)", borderRadius: 10, boxShadow: "0 8px 24px rgba(23,42,74,0.14)",
                padding: "10px 14px", minWidth: 220, maxHeight: "60vh", overflowY: "auto",
              }}>
                <div className="eyebrow" style={{ marginBottom: 4 }}>Stage</div>
                {stageNames.map((s) => (
                  <label key={s} style={{ display: "flex", alignItems: "center", gap: 8, padding: "4px 0", fontSize: 13, cursor: "pointer" }}>
                    <input type="checkbox" checked={selected.includes(s)} onChange={() => toggleFilter(s)}
                      style={{ width: 15, height: 15, accentColor: "var(--coral)" }} />
                    {s}
                  </label>
                ))}
                <div className="eyebrow" style={{ margin: "10px 0 4px" }}>Flags</div>
                {FLAGS.map((f) => (
                  <label key={f} style={{ display: "flex", alignItems: "center", gap: 8, padding: "4px 0", fontSize: 13, cursor: "pointer" }}>
                    <input type="checkbox" checked={selected.includes(f)} onChange={() => toggleFilter(f)}
                      style={{ width: 15, height: 15, accentColor: "var(--coral)" }} />
                    {f}
                  </label>
                ))}
                {LEADS.length > 0 && (
                  <>
                    <div className="eyebrow" style={{ margin: "10px 0 4px" }}>Lead</div>
                    {LEADS.map((l) => (
                      <label key={l} style={{ display: "flex", alignItems: "center", gap: 8, padding: "4px 0", fontSize: 13, cursor: "pointer" }}>
                        <input type="checkbox" checked={selected.includes(leadKey(l))} onChange={() => toggleFilter(leadKey(l))}
                          style={{ width: 15, height: 15, accentColor: "var(--coral)" }} />
                        {l}
                      </label>
                    ))}
                  </>
                )}
                {selected.length > 0 && (
                  <button className="btn link" style={{ marginTop: 8 }} onClick={() => setSelected([])}>Clear all</button>
                )}
              </div>
            </>
          )}
        </div>
        {selected.map((f) => (
          <button key={f} className="pill" onClick={() => toggleFilter(f)} title="Remove filter"
            style={{ background: "#EDEBFA", color: "#4F45A3", border: "none", cursor: "pointer" }}>
            {f.startsWith("lead:") ? f.slice(5) : f} ×
          </button>
        ))}
        {canEdit && (
          <button className="btn sm primary" style={{ marginLeft: "auto" }} onClick={() => setShowNew((v) => !v)}>
            {showNew ? "Cancel" : "+ New instrument"}
          </button>
        )}
      </div>

      {showNew && (
        <div className="dash-form">
          <div className="pf3" style={{ marginBottom: 8 }}>
            <div><label>System ID *</label><input value={draft.externalId} onChange={(e) => setDraft({ ...draft, externalId: e.target.value })} placeholder="G-012" /></div>
            <div>
              <label>Client</label>
              <PickOrAdd value={draft.client} options={clients} newLabel="+ New client..." placeholder="New client name"
                onChange={(client) => setDraft({ ...draft, client })} />
            </div>
            <div><label>Priority</label><input value={draft.priority} onChange={(e) => setDraft({ ...draft, priority: e.target.value })} placeholder="11" /></div>
          </div>
          <div className="pf2" style={{ marginBottom: 8 }}>
            <div>
              <label>Category</label>
              <CatalogSelect value={draft.category} options={categories} ariaLabel="System category"
                onChange={(category) => setDraft({ ...draft, category })}
                hint="Define system types in Settings → Catalog" />
            </div>
          </div>
          <div className="mut" style={{ fontSize: 12, marginBottom: 10 }}>
            The system is named by the assets you add on its page.
          </div>
          <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
            {people.length > 0 && (
              <>
                <span className="mut" style={{ fontSize: 12 }}>Lead:</span>
                <select value={draft.lead} onChange={(e) => setDraft({ ...draft, lead: e.target.value })} style={{ width: "auto", fontSize: 12 }}>
                  <option value="">-</option>
                  {people.map((p) => <option key={p} value={p}>{p}</option>)}
                </select>
              </>
            )}
            <button className="btn sm accent" onClick={submitNew} disabled={pending}>{pending ? "Creating..." : "Create instrument"}</button>
          </div>
        </div>
      )}

      <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search ID, asset, client, stage..." style={{ marginBottom: 12 }} />

      <div className="card" style={{ padding: 0, overflow: "hidden" }}>
        <div className="grid-row eyebrow" style={{ padding: "9px 14px", borderBottom: "1px solid var(--line)" }}>
          <span>ID</span><span>System</span><span className="hide-m">Stages</span><span className="hide-m">Parts / gas</span>
        </div>
        {filtered.map((i) => (
          <Link key={i.id} href={`/instruments/${i.id}`} className="grid-row row-hover"
            style={{ padding: "11px 14px", borderBottom: "1px solid var(--line)", fontSize: 13, textDecoration: "none", color: "inherit" }}>
            <span className="mono" style={{ fontSize: 12, fontWeight: 700, color: "var(--navy)" }}>{i.externalId}</span>
            <span style={{ minWidth: 0 }}>
              <span style={{ display: "block", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{i.label || <span className="mut">No assets listed yet</span>}</span>
              <span className="mut" style={{ fontSize: 11 }}>
                {i.client}{i.category ? ` · ${i.category}` : ""} · P{i.priority}
                {i.lead && <span style={{ color: "var(--navy)", fontWeight: 700 }}> · {i.lead}</span>}
                {i.missingFromSheet && <span style={{ color: "#A32D2D", fontWeight: 700 }}> · not on sheet</span>}
              </span>
            </span>
            <span className="hide-m" style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
              {i.stages.map((s) => (
                <Pill key={s} bg={stageColor(s).bg} fg={stageColor(s).fg}>{s}</Pill>
              ))}
            </span>
            <span className="hide-m" style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
              {i.missingFromSheet && <Pill bg="#FBE9E9" fg="#A32D2D">not on sheet</Pill>}
              {i.overdue > 0 && <Pill bg="#FBE9E9" fg="#A32D2D">{i.overdue} overdue</Pill>}
              {i.assetIssues.map((x) => (
                <Pill key={x} bg={x.endsWith("down") ? "#FBE9E9" : "#FAF0DC"} fg={x.endsWith("down") ? "#A32D2D" : "#8A5410"}>{x}</Pill>
              ))}
              {i.openParts > 0 && <Pill bg="#FAF0DC" fg="#8A5410">{i.openParts} open</Pill>}
              {i.gasIssues.map((g) => (
                <Pill key={g} bg={g.endsWith("low") ? "#FAF0DC" : "#FBE9E9"} fg={g.endsWith("low") ? "#8A5410" : "#A32D2D"}>{g}</Pill>
              ))}
              {!i.missingFromSheet && !i.overdue && i.assetIssues.length === 0 && i.openParts === 0 && i.gasIssues.length === 0 && <span className="mut" style={{ fontSize: 12 }}>-</span>}
            </span>
          </Link>
        ))}
        {filtered.length === 0 && (
          <div className="mut" style={{ padding: 24, fontSize: 13, textAlign: "center" }}>No instruments match. Clear the filter or search.</div>
        )}
      </div>
      {!canEdit && <div className="mut" style={{ fontSize: 12, marginTop: 10 }}>Read-only access.</div>}
    </div>
  );
}
