"use client";

import { useState, useTransition } from "react";
import { saveEodUpdate, setEodSkip } from "@/app/actions";

type Sys = {
  id: number; label: string; client: string;
  systemUpdate: string; actionItem: string; skipped: boolean;
  suggestedUpdate: string; suggestedAction: string;
};
type Draft = { systemUpdate: string; actionItem: string };

const SEP = "-".repeat(50);

export default function EodPanel({ systems, dateMDY }: { systems: Sys[]; dateMDY: string }) {
  const [drafts, setDrafts] = useState<Record<number, Draft>>(
    Object.fromEntries(systems.map((s) => [s.id, { systemUpdate: s.systemUpdate, actionItem: s.actionItem }]))
  );
  const [savedIds, setSavedIds] = useState<Set<number>>(new Set());
  const [copied, setCopied] = useState(false);
  const [pending, startTransition] = useTransition();

  const included = systems.filter((s) => !s.skipped);

  const setDraft = (id: number, patch: Partial<Draft>) => {
    setDrafts((d) => ({ ...d, [id]: { ...d[id], ...patch } }));
    setSavedIds((s) => { const n = new Set(s); n.delete(id); return n; });
  };

  const dirty = (s: Sys) => {
    const d = drafts[s.id];
    return !!d && (d.systemUpdate !== s.systemUpdate || d.actionItem !== s.actionItem);
  };

  // Fill only what's empty - a suggestion never overwrites something typed.
  const autofill = (s: Sys) => {
    const d = drafts[s.id];
    setDraft(s.id, {
      systemUpdate: d.systemUpdate || s.suggestedUpdate,
      actionItem: d.actionItem || s.suggestedAction,
    });
  };
  const canAutofill = (s: Sys) => {
    const d = drafts[s.id];
    return (!d.systemUpdate && !!s.suggestedUpdate) || (!d.actionItem && !!s.suggestedAction);
  };

  const save = (id: number) =>
    startTransition(async () => {
      await saveEodUpdate(id, drafts[id]);
      setSavedIds((s) => new Set(s).add(id));
    });

  const saveAll = () =>
    startTransition(async () => {
      for (const s of included) {
        if (dirty(s)) await saveEodUpdate(s.id, drafts[s.id]);
      }
      setSavedIds(new Set(included.map((s) => s.id)));
    });

  const emailText = [
    `${dateMDY} - Daily Updates`,
    "",
    SEP,
    ...included.flatMap((s, i) => [
      `System ${i + 1}: ${s.label}`,
      "",
      `System Update: ${drafts[s.id]?.systemUpdate ?? ""}`,
      `Action Item: ${drafts[s.id]?.actionItem ?? ""}`,
      "",
      SEP,
    ]),
  ].join("\n");

  const copy = async () => {
    await navigator.clipboard.writeText(emailText);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <>
      <div className="card">
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4, flexWrap: "wrap" }}>
          <div className="card-title">End-of-day client update</div>
          <span className="mut" style={{ fontSize: 12 }}>{dateMDY}</span>
          <div style={{ marginLeft: "auto", display: "flex", gap: 8 }}>
            <button className="btn sm" onClick={() => included.forEach(autofill)} disabled={pending || !included.some(canAutofill)}>
              Autofill empty
            </button>
            <button className="btn sm accent" onClick={saveAll} disabled={pending || !included.some(dirty)}>
              {pending ? "Saving..." : "Save all"}
            </button>
          </div>
        </div>
        <div className="mut" style={{ fontSize: 12, marginBottom: 12 }}>
          Every active system (anything not Shipped). Autofill drafts from today&apos;s activity - always review before copying.
          Skipped systems stay out of the email.
        </div>

        {systems.length === 0 && <div className="mut" style={{ fontSize: 13 }}>No active systems.</div>}
        {systems.map((s) => {
          const num = included.findIndex((x) => x.id === s.id);
          if (s.skipped) {
            return (
              <div key={s.id} style={{ border: "1px dashed var(--line)", borderRadius: 10, padding: "8px 12px", marginBottom: 8, display: "flex", alignItems: "center", gap: 8, opacity: 0.65 }}>
                <span className="mono" style={{ fontSize: 12, fontWeight: 700 }}>{s.label}</span>
                <span className="pill" style={{ background: "#EEF1F5", color: "#64748B" }}>Skipped today</span>
                <button className="btn link" style={{ marginLeft: "auto" }} disabled={pending}
                  onClick={() => startTransition(() => setEodSkip(s.id, false))}>Include</button>
              </div>
            );
          }
          return (
            <div key={s.id} style={{ border: "1px solid var(--line)", borderRadius: 10, padding: 12, marginBottom: 8, background: "#FAFBFD" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8, flexWrap: "wrap" }}>
                <span style={{ fontSize: 13, fontWeight: 700 }}>System {num + 1}: <span className="mono">{s.label}</span></span>
                <span className="mut" style={{ fontSize: 12 }}>{s.client}</span>
                <div style={{ marginLeft: "auto", display: "flex", gap: 6, alignItems: "center" }}>
                  {canAutofill(s) && (
                    <button className="btn link" onClick={() => autofill(s)} disabled={pending} title="Draft from today's activity and open items">
                      autofill
                    </button>
                  )}
                  <button className="btn sm" onClick={() => save(s.id)} disabled={pending || !dirty(s)}>
                    {savedIds.has(s.id) && !dirty(s) ? "Saved ✓" : "Save"}
                  </button>
                  <button className="btn link" style={{ color: "#A32D2D" }} disabled={pending}
                    onClick={() => startTransition(() => setEodSkip(s.id, true))}>skip</button>
                </div>
              </div>
              <label style={{ fontSize: 11 }}>System Update</label>
              <textarea rows={2} value={drafts[s.id]?.systemUpdate ?? ""}
                onChange={(e) => setDraft(s.id, { systemUpdate: e.target.value })}
                placeholder={s.suggestedUpdate || "What happened on this system today"}
                style={{ marginBottom: 8, resize: "vertical" }} />
              <label style={{ fontSize: 11 }}>Action Item</label>
              <input value={drafts[s.id]?.actionItem ?? ""}
                onChange={(e) => setDraft(s.id, { actionItem: e.target.value })}
                placeholder={s.suggestedAction || "Next step / what we need"} />
            </div>
          );
        })}
      </div>

      <div className="card">
        <div style={{ display: "flex", alignItems: "center", marginBottom: 10 }}>
          <div className="card-title">Email preview</div>
          <button className="btn sm primary" style={{ marginLeft: "auto" }} onClick={copy}>
            {copied ? "Copied ✓" : "Copy to clipboard"}
          </button>
        </div>
        <pre style={{
          fontSize: 12, whiteSpace: "pre-wrap", overflowWrap: "anywhere", background: "#F5F7FA",
          border: "1px solid var(--line)", borderRadius: 8, padding: 12, margin: 0,
        }}>{emailText}</pre>
      </div>
    </>
  );
}
