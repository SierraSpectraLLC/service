"use client";

import { useRef, useState, useTransition } from "react";
import {
  addStage, setStageColor, renameStage, deleteStage,
  addVocabTerm, deleteVocabTerm, setBranding, setOperatorOrg, setModule,
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

type VocabRow = { id: number; kind: string; assetType: string; name: string };
type StageRow = { id: number; name: string; bg: string; fg: string; builtin: boolean };
type OrgRow = { id: number; name: string; kind: string };

/**
 * The instance itself: what it's called, who operates it, which optional
 * workflows run, and the vocabulary the shop works in. Nothing here is about a
 * particular person or company - that's Personnel.
 */
export default function ConfigurationForm(props: {
  stageDefs: StageRow[];
  vocab: VocabRow[]; assetTypes: string[];
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

  // Vocabulary: categories, models and stages - all "the words this shop uses".
  const [catDraft, setCatDraft] = useState("");
  const [modelDraft, setModelDraft] = useState({ assetType: props.assetTypes[0] ?? "Pump", name: "" });
  const [vocabError, setVocabError] = useState("");
  const submitVocab = (kind: "category" | "model") => {
    const name = kind === "category" ? catDraft : modelDraft.name;
    if (!name.trim()) return;
    setVocabError("");
    startTransition(async () => {
      const res = await addVocabTerm(kind, kind === "model" ? modelDraft.assetType : "", name);
      if (res?.error) setVocabError(res.error);
      else kind === "category" ? setCatDraft("") : setModelDraft((d) => ({ ...d, name: "" }));
    });
  };
  const categories = props.vocab.filter((v) => v.kind === "category");
  const models = props.vocab.filter((v) => v.kind === "model");

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

      <Section title="Vocabulary"
        hint="Categories, models and stages, defined ahead of use. Define a model you don't stock yet and it shows up wherever models are picked - like scoping a checkout test to both an ASI-V and an ASI-L. Removing a term never touches records already using it.">
        <SubHead>System categories</SubHead>
        <div style={{ display: "flex", gap: 4, flexWrap: "wrap", marginBottom: 6 }}>
          {categories.map((c) => (
            <span key={c.id} className="pill" style={{ background: "#E7F2FA", color: "#1D6396", display: "inline-flex", alignItems: "center", gap: 4 }}>
              {c.name}
              <button className="btn link" aria-label={`Remove ${c.name}`} style={{ color: "inherit", padding: 0, fontSize: 12 }}
                disabled={pending} onClick={() => startTransition(() => deleteVocabTerm(c.id))}>×</button>
            </span>
          ))}
          {categories.length === 0 && <span className="mut" style={{ fontSize: 12 }}>None defined - the pickers offer categories already in use.</span>}
        </div>
        <div style={{ display: "flex", gap: 6 }}>
          <input value={catDraft} onChange={(e) => setCatDraft(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") submitVocab("category"); }}
            placeholder='New category, e.g. "LC-MS"' style={{ flex: 1, fontSize: 13, maxWidth: 260 }} />
          <button className="btn sm" onClick={() => submitVocab("category")} disabled={pending || !catDraft.trim()}>Add</button>
        </div>

        <SubHead>Asset models</SubHead>
        {[...new Set(models.map((m) => m.assetType))].map((at) => (
          <div key={at} style={{ display: "flex", gap: 4, flexWrap: "wrap", alignItems: "center", marginBottom: 4 }}>
            <span className="mut" style={{ fontSize: 12, width: 110, flexShrink: 0 }}>{at}</span>
            {models.filter((m) => m.assetType === at).map((m) => (
              <span key={m.id} className="pill" style={{ background: "#EDEBFA", color: "#4F45A3", display: "inline-flex", alignItems: "center", gap: 4 }}>
                {m.name}
                <button className="btn link" aria-label={`Remove ${m.name}`} style={{ color: "inherit", padding: 0, fontSize: 12 }}
                  disabled={pending} onClick={() => startTransition(() => deleteVocabTerm(m.id))}>×</button>
              </span>
            ))}
          </div>
        ))}
        <div style={{ display: "flex", gap: 6, marginTop: 6, flexWrap: "wrap" }}>
          <select value={modelDraft.assetType} onChange={(e) => setModelDraft({ ...modelDraft, assetType: e.target.value })}
            style={{ width: "auto", fontSize: 12 }}>
            {props.assetTypes.map((t) => <option key={t}>{t}</option>)}
          </select>
          <input value={modelDraft.name} onChange={(e) => setModelDraft({ ...modelDraft, name: e.target.value })}
            onKeyDown={(e) => { if (e.key === "Enter") submitVocab("model"); }}
            placeholder='New model, e.g. "ASI-L"' style={{ flex: "1 1 160px", fontSize: 13, maxWidth: 220 }} />
          <button className="btn sm" onClick={() => submitVocab("model")} disabled={pending || !modelDraft.name.trim()}>Add</button>
        </div>
        {vocabError && <div style={{ fontSize: 12, color: "#A32D2D", marginTop: 6 }}>{vocabError}</div>}

        <SubHead>Stages</SubHead>
        <div className="mut" style={{ fontSize: 11, marginBottom: 6 }}>
          Pick a background color - the text color adjusts itself. Built-in names are locked (sync and
          reports key on them); stages you add can be renamed or deleted.
        </div>
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
