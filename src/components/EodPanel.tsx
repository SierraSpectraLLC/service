"use client";

import { useRef, useState, useTransition } from "react";
import { saveEodUpdate, setEodSkip } from "@/app/actions";

type Sys = {
  id: number; label: string; client: string;
  systemUpdate: string; actionItem: string; skipped: boolean;
  suggestedUpdate: string; suggestedAction: string;
};
type Draft = { systemUpdate: string; actionItem: string };
type SaveState = "dirty" | "saving" | "saved";

const SEP = "-".repeat(50);
const AUTOSAVE_MS = 900;

export default function EodPanel({ systems, dateMDY }: { systems: Sys[]; dateMDY: string }) {
  const [drafts, setDrafts] = useState<Record<number, Draft>>(
    Object.fromEntries(systems.map((s) => [s.id, { systemUpdate: s.systemUpdate, actionItem: s.actionItem }]))
  );
  const [status, setStatus] = useState<Record<number, SaveState>>({});
  const [copied, setCopied] = useState(false);
  const [pending, startTransition] = useTransition();

  // Autosave: debounce while typing, flush immediately on blur. The refs keep
  // the timer callbacks reading the latest draft, not the one they closed over.
  const timers = useRef<Record<number, ReturnType<typeof setTimeout>>>({});
  const draftsRef = useRef(drafts);
  draftsRef.current = drafts;

  const flush = (id: number) => {
    if (timers.current[id]) { clearTimeout(timers.current[id]); delete timers.current[id]; }
    const d = draftsRef.current[id];
    if (!d) return;
    setStatus((s) => ({ ...s, [id]: "saving" }));
    startTransition(async () => {
      await saveEodUpdate(id, d);
      // If the user typed again while this save was in flight, stay dirty;
      // the newer edit's own timer will save it.
      setStatus((s) => (s[id] === "dirty" ? s : { ...s, [id]: "saved" }));
    });
  };

  const setDraft = (id: number, patch: Partial<Draft>) => {
    setDrafts((d) => ({ ...d, [id]: { ...d[id], ...patch } }));
    setStatus((s) => ({ ...s, [id]: "dirty" }));
    if (timers.current[id]) clearTimeout(timers.current[id]);
    timers.current[id] = setTimeout(() => flush(id), AUTOSAVE_MS);
  };

  const included = systems.filter((s) => !s.skipped);

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

  const saveLabel = (st: SaveState | undefined) =>
    st === "saving" ? "Saving..." : st === "saved" ? "Saved ✓" : st === "dirty" ? "Unsaved" : "";
  const anyUnsaved = Object.values(status).some((s) => s === "dirty" || s === "saving");

  return (
    <>
      <div className="card">
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4, flexWrap: "wrap" }}>
          <div className="card-title">End-of-day client update</div>
          <span className="mut" style={{ fontSize: 12 }}>{dateMDY}</span>
          <div style={{ marginLeft: "auto", display: "flex", gap: 8, alignItems: "center" }}>
            <span className="mut" style={{ fontSize: 12 }}>
              {anyUnsaved ? "Saving..." : Object.keys(status).length ? "All changes saved" : ""}
            </span>
            <button className="btn sm" onClick={() => included.forEach(autofill)} disabled={pending || !included.some(canAutofill)}>
              Autofill empty
            </button>
          </div>
        </div>
        <div className="mut" style={{ fontSize: 12, marginBottom: 12 }}>
          Every active system (anything not Shipped). Saves automatically as you type. Autofill drafts from
          today&apos;s activity - always review before copying. Skipped systems stay out of the email.
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
                <div style={{ marginLeft: "auto", display: "flex", gap: 8, alignItems: "center" }}>
                  <span className="mut" style={{ fontSize: 11 }}>{saveLabel(status[s.id])}</span>
                  {canAutofill(s) && (
                    <button className="btn link" onClick={() => autofill(s)} disabled={pending} title="Draft from today's activity and open items">
                      autofill
                    </button>
                  )}
                  <button className="btn link" style={{ color: "#A32D2D" }} disabled={pending}
                    onClick={() => startTransition(() => setEodSkip(s.id, true))}>skip</button>
                </div>
              </div>
              <label style={{ fontSize: 11 }}>System Update</label>
              <textarea rows={2} value={drafts[s.id]?.systemUpdate ?? ""}
                onChange={(e) => setDraft(s.id, { systemUpdate: e.target.value })}
                onBlur={() => { if (status[s.id] === "dirty") flush(s.id); }}
                placeholder={s.suggestedUpdate || "What happened on this system today"}
                style={{ marginBottom: 8, resize: "vertical" }} />
              <label style={{ fontSize: 11 }}>Action Item</label>
              <input value={drafts[s.id]?.actionItem ?? ""}
                onChange={(e) => setDraft(s.id, { actionItem: e.target.value })}
                onBlur={() => { if (status[s.id] === "dirty") flush(s.id); }}
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
