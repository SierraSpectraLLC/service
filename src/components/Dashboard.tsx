"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { STAGES, STAGE_COLOR } from "@/lib/stages";
import { createInstrument } from "@/app/actions";

type Row = {
  id: number; externalId: string; client: string; model: string; priority: number;
  stages: string[]; notes: string; openParts: number; gasIssues: string[]; lastActivity: string;
};

const Pill = ({ bg, fg, children }: { bg: string; fg: string; children: React.ReactNode }) => (
  <span className="pill" style={{ background: bg, color: fg }}>{children}</span>
);

export default function Dashboard({ data, canEdit, isStaff }: { data: Row[]; canEdit: boolean; isStaff: boolean }) {
  const router = useRouter();
  const [filter, setFilter] = useState("All");
  const [q, setQ] = useState("");
  const [showNew, setShowNew] = useState(false);
  const [draft, setDraft] = useState({ externalId: "", client: "", model: "", priority: "" });
  const [pending, startTransition] = useTransition();

  const filtered = useMemo(() => {
    let list = data;
    if (filter === "Awaiting parts") list = list.filter((i) => i.openParts > 0);
    else if (filter === "Gas attention") list = list.filter((i) => i.gasIssues.length > 0);
    else if (filter !== "All") list = list.filter((i) => i.stages.includes(filter));
    if (q.trim()) {
      const s = q.toLowerCase();
      list = list.filter((i) =>
        [i.externalId, i.client, i.model, i.notes, i.stages.join(" "), i.gasIssues.join(" "), i.lastActivity].join(" ").toLowerCase().includes(s)
      );
    }
    return list;
  }, [data, filter, q]);

  const counts = {
    total: data.length,
    blocked: data.filter((i) => i.stages.includes("Waiting / blocked")).length,
    waiting: data.filter((i) => i.openParts > 0).length,
    gas: data.filter((i) => i.gasIssues.length > 0).length,
    shipped: data.filter((i) => i.stages.includes("Shipped") || i.stages.includes("Waiting to ship")).length,
  };

  const submitNew = () => {
    if (!draft.externalId.trim() || !draft.model.trim()) return;
    startTransition(async () => {
      const id = await createInstrument({
        externalId: draft.externalId, client: draft.client, model: draft.model,
        priority: parseInt(draft.priority) || 99,
      });
      setShowNew(false);
      setDraft({ externalId: "", client: "", model: "", priority: "" });
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
        {["All", ...STAGES, "Awaiting parts", "Gas attention"].map((f) => (
          <button key={f} onClick={() => setFilter(f)} className="btn sm" style={{
            borderRadius: 999,
            borderColor: filter === f ? "var(--navy)" : "var(--line)",
            background: filter === f ? "var(--navy)" : "#fff",
            color: filter === f ? "#fff" : "var(--mut)",
          }}>{f}</button>
        ))}
        {isStaff && (
          <button className="btn sm primary" style={{ marginLeft: "auto" }} onClick={() => setShowNew((v) => !v)}>
            {showNew ? "Cancel" : "+ New instrument"}
          </button>
        )}
      </div>

      {showNew && (
        <div className="dash-form">
          <div className="pf2" style={{ marginBottom: 8 }}>
            <div><label>System ID *</label><input value={draft.externalId} onChange={(e) => setDraft({ ...draft, externalId: e.target.value })} placeholder="G-012" /></div>
            <div><label>Client</label><input value={draft.client} onChange={(e) => setDraft({ ...draft, client: e.target.value })} placeholder="GMI" /></div>
          </div>
          <div className="pf-ship" style={{ marginBottom: 10 }}>
            <div><label>Priority</label><input value={draft.priority} onChange={(e) => setDraft({ ...draft, priority: e.target.value })} placeholder="11" /></div>
            <div><label>Model *</label><input value={draft.model} onChange={(e) => setDraft({ ...draft, model: e.target.value })} placeholder="Shimadzu LCMS-8045 + LC-30" /></div>
          </div>
          <button className="btn sm accent" onClick={submitNew} disabled={pending}>{pending ? "Creating..." : "Create instrument"}</button>
        </div>
      )}

      <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search ID, model, client, stage..." style={{ marginBottom: 12 }} />

      <div className="card" style={{ padding: 0, overflow: "hidden" }}>
        <div className="grid-row eyebrow" style={{ padding: "9px 14px", borderBottom: "1px solid var(--line)" }}>
          <span>ID</span><span>System</span><span className="hide-m">Stages</span><span className="hide-m">Parts / gas</span>
        </div>
        {filtered.map((i) => (
          <div key={i.id} className="grid-row row-hover" onClick={() => router.push(`/instruments/${i.id}`)}
            style={{ padding: "11px 14px", borderBottom: "1px solid var(--line)", fontSize: 13 }}>
            <span className="mono" style={{ fontSize: 12, fontWeight: 700, color: "var(--navy)" }}>{i.externalId}</span>
            <span style={{ minWidth: 0 }}>
              <span style={{ display: "block", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{i.model}</span>
              <span className="mut" style={{ fontSize: 11 }}>{i.client} · P{i.priority}</span>
            </span>
            <span className="hide-m" style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
              {i.stages.map((s) => (
                <Pill key={s} bg={STAGE_COLOR[s]?.bg || "#EEF1F5"} fg={STAGE_COLOR[s]?.fg || "#475569"}>{s}</Pill>
              ))}
            </span>
            <span className="hide-m" style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
              {i.openParts > 0 && <Pill bg="#FAF0DC" fg="#8A5410">{i.openParts} open</Pill>}
              {i.gasIssues.map((g) => (
                <Pill key={g} bg={g.endsWith("low") ? "#FAF0DC" : "#FBE9E9"} fg={g.endsWith("low") ? "#8A5410" : "#A32D2D"}>{g}</Pill>
              ))}
              {i.openParts === 0 && i.gasIssues.length === 0 && <span className="mut" style={{ fontSize: 12 }}>-</span>}
            </span>
          </div>
        ))}
        {filtered.length === 0 && (
          <div className="mut" style={{ padding: 24, fontSize: 13, textAlign: "center" }}>No instruments match. Clear the filter or search.</div>
        )}
      </div>
      {!canEdit && <div className="mut" style={{ fontSize: 12, marginTop: 10 }}>Read-only access.</div>}
    </div>
  );
}
