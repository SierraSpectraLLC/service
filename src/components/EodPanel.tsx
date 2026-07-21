"use client";

import { useState, useTransition } from "react";
import { saveEodUpdate } from "@/app/actions";

type Sys = { id: number; label: string; client: string; systemUpdate: string; actionItem: string };
type Draft = { systemUpdate: string; actionItem: string };

const SEP = "-".repeat(50);

export default function EodPanel({ systems, dateMDY }: { systems: Sys[]; dateMDY: string }) {
  const [drafts, setDrafts] = useState<Record<number, Draft>>(
    Object.fromEntries(systems.map((s) => [s.id, { systemUpdate: s.systemUpdate, actionItem: s.actionItem }]))
  );
  const [savedIds, setSavedIds] = useState<Set<number>>(new Set());
  const [copied, setCopied] = useState(false);
  const [pending, startTransition] = useTransition();

  const setDraft = (id: number, patch: Partial<Draft>) => {
    setDrafts((d) => ({ ...d, [id]: { ...d[id], ...patch } }));
    setSavedIds((s) => { const n = new Set(s); n.delete(id); return n; });
  };

  const save = (id: number) =>
    startTransition(async () => {
      await saveEodUpdate(id, drafts[id]);
      setSavedIds((s) => new Set(s).add(id));
    });

  const emailText = [
    `${dateMDY} - Daily Updates`,
    "",
    SEP,
    ...systems.flatMap((s, i) => [
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
        <div style={{ display: "flex", alignItems: "center", marginBottom: 4 }}>
          <div className="card-title">End-of-day client update</div>
          <span className="mut" style={{ marginLeft: "auto", fontSize: 12 }}>{dateMDY}</span>
        </div>
        <div className="mut" style={{ fontSize: 12, marginBottom: 12 }}>
          Every active system (anything not Shipped). Fill in the two lines per system, save, then copy the email below.
        </div>

        {systems.length === 0 && <div className="mut" style={{ fontSize: 13 }}>No active systems.</div>}
        {systems.map((s, i) => (
          <div key={s.id} style={{ border: "1px solid var(--line)", borderRadius: 10, padding: 12, marginBottom: 8, background: "#FAFBFD" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8, flexWrap: "wrap" }}>
              <span style={{ fontSize: 13, fontWeight: 700 }}>System {i + 1}: <span className="mono">{s.label}</span></span>
              <span className="mut" style={{ fontSize: 12 }}>{s.client}</span>
              <button className="btn sm" style={{ marginLeft: "auto" }} onClick={() => save(s.id)} disabled={pending}>
                {savedIds.has(s.id) ? "Saved ✓" : pending ? "..." : "Save"}
              </button>
            </div>
            <label style={{ fontSize: 11 }}>System Update</label>
            <textarea rows={2} value={drafts[s.id]?.systemUpdate ?? ""}
              onChange={(e) => setDraft(s.id, { systemUpdate: e.target.value })}
              placeholder="What happened on this system today" style={{ marginBottom: 8, resize: "vertical" }} />
            <label style={{ fontSize: 11 }}>Action Item</label>
            <input value={drafts[s.id]?.actionItem ?? ""}
              onChange={(e) => setDraft(s.id, { actionItem: e.target.value })}
              placeholder="Next step / what we need" />
          </div>
        ))}
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
