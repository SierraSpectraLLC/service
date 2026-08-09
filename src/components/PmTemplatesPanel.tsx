"use client";

import { useState, useTransition } from "react";
import { addPmTemplate, updatePmTemplate, removePmTemplate } from "@/app/actions";
import { ScopeField } from "@/components/CheckoutItemsPanel";
import { cadenceLabel } from "@/lib/pm";

type Tpl = {
  id: number; assetType: string; title: string; body: string;
  everyDays: number; partName: string; partNumber: string; modelScope: string[];
};

const emptyDraft = { title: "", body: "", everyDays: "90", partName: "", partNumber: "", modelScope: [] as string[] };

const CADENCES = [
  { days: "7", label: "weekly" }, { days: "14", label: "every 2 weeks" },
  { days: "30", label: "monthly" }, { days: "90", label: "quarterly" },
  { days: "180", label: "every 6 months" }, { days: "365", label: "yearly" },
];

/**
 * The maintenance a MODEL needs, written once and stamped onto every unit of
 * it - same shape as checkout items, but recurring. Scope narrows a job to
 * specific models, which is how an LC-20AD and an LC-20ADXR get the same seal
 * job with different part numbers.
 */
export default function PmTemplatesPanel({ templates, assetTypes, modelOptions }: {
  templates: Tpl[];
  assetTypes: string[];
  modelOptions: Record<string, string[]>; // distinct catalog models per asset type
}) {
  const [expanded, setExpanded] = useState<string | null>(null);
  const [draft, setDraft] = useState(emptyDraft);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [pending, startTransition] = useTransition();

  const open = (type: string) => {
    setExpanded(expanded === type ? null : type);
    setDraft(emptyDraft); setEditingId(null); setError(""); setNotice("");
  };

  const submit = (assetType: string) => {
    if (!draft.title.trim()) return;
    setError(""); setNotice("");
    startTransition(async () => {
      if (editingId !== null) {
        const res = await updatePmTemplate(editingId, { assetType, ...draft });
        if (res?.error) { setError(res.error); return; }
        setNotice("Saved. Units it's already on keep their current schedules.");
      } else {
        const res = await addPmTemplate({ assetType, ...draft });
        if (res?.error) { setError(res.error); return; }
        setNotice(res.applied
          ? `Scheduled on ${res.applied} existing unit${res.applied === 1 ? "" : "s"}; new ones pick it up automatically.`
          : "Saved - no matching units yet; new ones pick it up automatically.");
      }
      setDraft(emptyDraft); setEditingId(null);
    });
  };

  const startEdit = (t: Tpl) => {
    setExpanded(t.assetType); setEditingId(t.id); setError(""); setNotice("");
    setDraft({ title: t.title, body: t.body, everyDays: String(t.everyDays), partName: t.partName, partNumber: t.partNumber, modelScope: t.modelScope });
  };

  const types = [...new Set([...assetTypes, ...templates.map((t) => t.assetType)])];

  return (
    <div className="card">
      <div className="card-title" style={{ marginBottom: 10 }}>Maintenance templates</div>

      {types.map((type) => {
        const ofType = templates.filter((t) => t.assetType === type);
        const isOpen = expanded === type;
        if (!ofType.length && !isOpen && assetTypes.indexOf(type) === -1) return null;
        return (
          <div key={type} style={{ borderTop: "1px solid var(--line)" }}>
            <button onClick={() => open(type)} className="row-hover"
              style={{ display: "flex", alignItems: "center", gap: 8, width: "100%", padding: "8px 4px", border: "none", background: "none", cursor: "pointer", textAlign: "left" }}>
              <span style={{ fontSize: 13, fontWeight: 700 }}>{type}</span>
              <span className="mut" style={{ fontSize: 11 }}>
                {ofType.length ? `${ofType.length} job${ofType.length === 1 ? "" : "s"}` : "nothing defined"}
              </span>
              <span className="mut" style={{ marginLeft: "auto", fontSize: 12 }}>{isOpen ? "▴" : "▾"}</span>
            </button>

            {isOpen && (
              <div style={{ padding: "0 4px 10px" }}>
                {ofType.map((t) => (
                  <div key={t.id} style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap", padding: "5px 0" }}>
                    <span style={{ fontSize: 13 }}>{t.title}</span>
                    <span className="pill" style={{ background: "#EDEBFA", color: "#4F45A3" }}>{cadenceLabel(t.everyDays)}</span>
                    {t.modelScope.length
                      ? t.modelScope.map((m) => <span key={m} className="pill" style={{ background: "#E7F2FA", color: "#1D6396" }}>{m}</span>)
                      : <span className="pill" style={{ background: "#EEF1F5", color: "#94A3B8" }}>all models</span>}
                    {t.partNumber && (
                      <span className="mono mut" style={{ fontSize: 11 }}>{t.partName ? `${t.partName} · ` : ""}PN {t.partNumber}</span>
                    )}
                    <span style={{ marginLeft: "auto", display: "flex", gap: 8 }}>
                      <button className="btn link" style={{ fontSize: 11 }} disabled={pending} onClick={() => startEdit(t)}>edit</button>
                      <button className="btn link" style={{ fontSize: 11, color: "#A32D2D" }} disabled={pending}
                        onClick={() => {
                          if (!window.confirm(`Remove the "${t.title}" template? Schedules already on units stay.`)) return;
                          startTransition(async () => {
                            const res = await removePmTemplate(t.id);
                            if (res?.error) setError(res.error);
                          });
                        }}>remove</button>
                    </span>
                  </div>
                ))}

                <div style={{ border: "1px solid var(--line)", borderRadius: 10, padding: "10px 12px", marginTop: 6 }}>
                  <div className="eyebrow" style={{ marginBottom: 6 }}>{editingId !== null ? "Edit job" : "New job"}</div>
                  <input value={draft.title} onChange={(e) => setDraft({ ...draft, title: e.target.value })}
                    placeholder='e.g. "Replace plunger seals"' style={{ width: "100%", fontSize: 13, marginBottom: 6 }} />
                  <textarea value={draft.body} onChange={(e) => setDraft({ ...draft, body: e.target.value })} rows={2}
                    placeholder="Steps or notes for whoever does it (optional)" style={{ width: "100%", fontSize: 13, marginBottom: 6, resize: "vertical" }} />
                  <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center", marginBottom: 6 }}>
                    <select value={draft.everyDays} onChange={(e) => setDraft({ ...draft, everyDays: e.target.value })}
                      style={{ width: "auto", fontSize: 12 }}>
                      {CADENCES.map((c) => <option key={c.days} value={c.days}>{c.label}</option>)}
                      {!CADENCES.some((c) => c.days === draft.everyDays) && (
                        <option value={draft.everyDays}>every {draft.everyDays} days</option>
                      )}
                    </select>
                    <input type="number" min={1} max={3650} value={draft.everyDays}
                      onChange={(e) => setDraft({ ...draft, everyDays: e.target.value })}
                      aria-label="Cadence in days" style={{ width: 70, fontSize: 12 }} />
                    <span className="mut" style={{ fontSize: 11 }}>days</span>
                    <input value={draft.partName} onChange={(e) => setDraft({ ...draft, partName: e.target.value })}
                      placeholder="Part name (optional)" style={{ flex: "1 1 130px", fontSize: 12 }} />
                    <input className="mono" value={draft.partNumber} onChange={(e) => setDraft({ ...draft, partNumber: e.target.value })}
                      placeholder="Part number" style={{ flex: "1 1 120px", fontSize: 12 }} />
                  </div>
                  <ScopeField scope={draft.modelScope} options={modelOptions[type] ?? []}
                    onChange={(next) => setDraft({ ...draft, modelScope: next })} />
                  <div style={{ display: "flex", gap: 8, marginTop: 8, alignItems: "center" }}>
                    {editingId !== null && (
                      <button className="btn sm" onClick={() => { setEditingId(null); setDraft(emptyDraft); }}>Cancel</button>
                    )}
                    <button className="btn sm accent" style={{ marginLeft: "auto" }} disabled={pending || !draft.title.trim()}
                      onClick={() => submit(type)}>
                      {pending ? "Saving..." : editingId !== null ? "Save changes" : "Add + apply to fleet"}
                    </button>
                  </div>
                </div>
                {notice && <div style={{ fontSize: 12, color: "#2E6B2E", marginTop: 6 }}>{notice}</div>}
                {error && <div style={{ fontSize: 12, color: "#A32D2D", marginTop: 6 }}>{error}</div>}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
