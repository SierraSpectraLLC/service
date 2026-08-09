"use client";

import { useRef, useState, useTransition } from "react";
import {
  addStage, setStageColor, renameStage, deleteStage,
  setBranding, setOperatorOrg, setModule,
} from "@/app/actions";

function Toggle({ on, onClick, label }: { on: boolean; onClick: () => void; label: string }) {
  return (
    <button onClick={onClick} aria-label={label}
      style={{ width: 42, height: 24, borderRadius: 999, border: "none", cursor: "pointer", background: on ? "var(--coral)" : "var(--line)", position: "relative", flexShrink: 0, padding: 0 }}>
      <span style={{ position: "absolute", top: 3, left: on ? 21 : 3, width: 18, height: 18, borderRadius: "50%", background: "#fff", transition: "left 120ms" }} />
    </button>
  );
}

function Section({ title, hint, children }: { title: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="card">
      <div className="card-title">{title}</div>
      {hint && <div className="mut" style={{ fontSize: 12, marginBottom: 10 }}>{hint}</div>}
      {children}
    </div>
  );
}

function SubHead({ children }: { children: React.ReactNode }) {
  return <div className="eyebrow" style={{ marginTop: 14, marginBottom: 6 }}>{children}</div>;
}

type StageRow = { id: number; name: string; bg: string; fg: string; builtin: boolean };
type OrgRow = { id: number; name: string; kind: string };

/**
 * The instance itself: what it's called, who operates it, which optional
 * workflows run, and the stages work moves through. Nothing here is about a
 * particular person or company (that's Personnel) or a piece of equipment
 * (that's Catalog).
 */
export default function ConfigurationForm(props: {
  stageDefs: StageRow[];
  orgs: OrgRow[];
  modules: { sheetSync: boolean; eod: boolean; digest: boolean };
  platformName: string; platformTagline: string; operatorOrgId: number | null;
}) {
  const [moduleState, setModuleState] = useState<Record<string, boolean>>({});
  const [pending, startTransition] = useTransition();

  const [brandDraft, setBrandDraft] = useState({ name: props.platformName, tagline: props.platformTagline });
  const [brandError, setBrandError] = useState("");
  const [brandSaved, setBrandSaved] = useState(false);
  const saveBrand = () => {
    setBrandError(""); setBrandSaved(false);
    startTransition(async () => {
      const res = await setBranding(brandDraft);
      if (res?.error) setBrandError(res.error);
      else setBrandSaved(true);
    });
  };

  const [stageDraft, setStageDraft] = useState({ name: "", bg: "#C9DAF8" });
  const [stageError, setStageError] = useState("");
  const [colors, setColors] = useState<Record<number, string>>({});
  const colorTimers = useRef<Record<number, ReturnType<typeof setTimeout>>>({});
  const changeColor = (id: number, bg: string) => {
    setColors((c) => ({ ...c, [id]: bg }));
    if (colorTimers.current[id]) clearTimeout(colorTimers.current[id]);
    colorTimers.current[id] = setTimeout(() => startTransition(() => setStageColor(id, bg)), 600);
  };
  const submitStage = () => {
    if (!stageDraft.name.trim()) return;
    setStageError("");
    startTransition(async () => {
      const res = await addStage(stageDraft.name, stageDraft.bg);
      if (res?.error) setStageError(res.error);
      else setStageDraft({ name: "", bg: "#C9DAF8" });
    });
  };
  const doRename = (s: StageRow) => {
    const next = window.prompt(`Rename stage "${s.name}" to:`, s.name);
    if (!next || next.trim() === s.name) return;
    setStageError("");
    startTransition(async () => {
      const res = await renameStage(s.id, next);
      if (res?.error) setStageError(res.error);
    });
  };
  const doDelete = (s: StageRow) => {
    if (!window.confirm(`Delete stage "${s.name}"? It will be removed from any system that has it.`)) return;
    setStageError("");
    startTransition(async () => {
      const res = await deleteStage(s.id);
      if (res?.error) setStageError(res.error);
    });
  };

  return (
    <>
      <Section title="This instance"
        hint="The portal's name, who operates it, and which optional workflows are switched on.">
        <div className="pf2" style={{ marginBottom: 8 }}>
          <div>
            <label>Name</label>
            <input value={brandDraft.name} onChange={(e) => { setBrandSaved(false); setBrandDraft({ ...brandDraft, name: e.target.value }); }}
              placeholder="e.g. Instrapath" />
          </div>
          <div>
            <label>Tagline</label>
            <input value={brandDraft.tagline} onChange={(e) => { setBrandSaved(false); setBrandDraft({ ...brandDraft, tagline: e.target.value }); }}
              placeholder="instrument portal" />
          </div>
        </div>
        <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          <button className="btn sm accent" onClick={saveBrand} disabled={pending || !brandDraft.name.trim()}>
            {pending ? "Saving..." : "Save name"}
          </button>
          {brandSaved && <span className="mut" style={{ fontSize: 12 }}>Saved.</span>}
          <span style={{ marginLeft: "auto", display: "flex", gap: 6, alignItems: "center" }}>
            <span className="mut" style={{ fontSize: 12 }}>Operated by</span>
            <select value={props.operatorOrgId ?? ""} disabled={pending}
              onChange={(e) => {
                const next = e.target.value ? parseInt(e.target.value) : null;
                setBrandError("");
                startTransition(async () => {
                  const res = await setOperatorOrg(next);
                  if (res?.error) setBrandError(res.error);
                });
              }}
              style={{ width: "auto", fontSize: 12 }}>
              <option value="">nobody - use the platform name</option>
              {props.orgs.filter((o) => o.kind === "provider").map((o) => (
                <option key={o.id} value={o.id}>{o.name}</option>
              ))}
            </select>
          </span>
        </div>
        <div className="mut" style={{ fontSize: 11, marginTop: 4 }}>
          The operator is named on sign-off packets and reports; systems staff create are shared with it.
        </div>
        {brandError && <div style={{ fontSize: 12, color: "#A32D2D", marginTop: 6 }}>{brandError}</div>}

        <SubHead>Modules</SubHead>
        <div className="mut" style={{ fontSize: 11, marginBottom: 6 }}>
          Off hides their pages and silences their scheduled runs.
        </div>
        {([
          ["sheetSync", "Google Sheet tracker sync", props.modules.sheetSync],
          ["eod", "Daily client reports", props.modules.eod],
          ["digest", "Daily staff digest", props.modules.digest],
        ] as const).map(([key, label, on]) => (
          <div key={key} style={{ display: "flex", gap: 12, alignItems: "center", padding: "6px 0", borderTop: "1px solid var(--line)" }}>
            <Toggle on={moduleState[key] ?? on} label={label}
              onClick={() => {
                const next = !(moduleState[key] ?? on);
                setModuleState((m) => ({ ...m, [key]: next }));
                startTransition(async () => { await setModule(key, next); });
              }} />
            <div style={{ fontSize: 13, fontWeight: 700 }}>{label}</div>
          </div>
        ))}
      </Section>

      {/* Equipment vocabulary - system types and models - lives in Settings >
          Catalog; stages are workflow, so they stay with the instance. */}
      <Section title="Stages"
        hint="The steps work moves through. Pick a background color - the text color adjusts itself. Built-in names are locked (sync and reports key on them); stages you add can be renamed or deleted.">

        {props.stageDefs.map((s) => (
          <div key={s.id} style={{ display: "flex", alignItems: "center", gap: 8, padding: "5px 0", borderTop: "1px solid var(--line)" }}>
            <span className="pill" style={{ background: colors[s.id] ?? s.bg, color: s.fg }}>{s.name}</span>
            <div style={{ marginLeft: "auto", display: "flex", gap: 8, alignItems: "center" }}>
              {!s.builtin && (
                <>
                  <button className="btn link" style={{ fontSize: 11 }} disabled={pending} onClick={() => doRename(s)}>rename</button>
                  <button className="btn link" style={{ fontSize: 11, color: "#A32D2D" }} disabled={pending} onClick={() => doDelete(s)}>delete</button>
                </>
              )}
              <input type="color" value={colors[s.id] ?? s.bg} onChange={(e) => changeColor(s.id, e.target.value)}
                disabled={s.id < 0} title={s.id < 0 ? "Available after the next deploy seeds the stage table" : "Stage color"}
                style={{ width: 34, height: 26, padding: 2, border: "1px solid var(--line)", borderRadius: 6, background: "#fff", cursor: "pointer" }} />
            </div>
          </div>
        ))}
        <div style={{ display: "flex", gap: 6, marginTop: 8, alignItems: "center" }}>
          <input value={stageDraft.name} onChange={(e) => setStageDraft({ ...stageDraft, name: e.target.value })}
            onKeyDown={(e) => { if (e.key === "Enter") submitStage(); }}
            placeholder="New stage name" style={{ flex: 1, fontSize: 13 }} />
          <input type="color" value={stageDraft.bg} onChange={(e) => setStageDraft({ ...stageDraft, bg: e.target.value })}
            style={{ width: 34, height: 30, padding: 2, border: "1px solid var(--line)", borderRadius: 6, background: "#fff", cursor: "pointer" }} />
          <button className="btn sm accent" onClick={submitStage} disabled={pending || !stageDraft.name.trim()}>Add</button>
        </div>
        {stageError && <div style={{ fontSize: 12, color: "#A32D2D", marginTop: 6 }}>{stageError}</div>}
      </Section>
    </>
  );
}
