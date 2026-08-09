"use client";

import { useRef, useState, useTransition } from "react";
import {
  updateSettings, addClientAccess, removeClientAccess,
  addStage, setStageColor, renameStage, deleteStage,
  addPerson, removePerson, updateEodRecipients,
  addVocabTerm, deleteVocabTerm,
  addOrg, removeOrg, setSheetOrg, setClientAccessOrg, setClientAccessRole, setBranding, setOperatorOrg, setOrgAppearance, setModule,
} from "@/app/actions";
import { promptReason } from "@/lib/reason";

function Toggle({ on, onClick, label }: { on: boolean; onClick: () => void; label: string }) {
  return (
    <button onClick={onClick} aria-label={label}
      style={{ width: 42, height: 24, borderRadius: 999, border: "none", cursor: "pointer", background: on ? "var(--coral)" : "var(--line)", position: "relative", flexShrink: 0, padding: 0 }}>
      <span style={{ position: "absolute", top: 3, left: on ? 21 : 3, width: 18, height: 18, borderRadius: "50%", background: "#fff", transition: "left 120ms" }} />
    </button>
  );
}

type AllowRow = { id: number; entry: string; addedBy: string; orgId: number | null; canEdit: boolean };
type OrgRow = { id: number; name: string; kind: string; themeColor: string; logoUrl: string; eodRecipients: string; systems: number; logins: number };
type VocabRow = { id: number; kind: string; assetType: string; name: string };
type StageRow = { id: number; name: string; bg: string; fg: string; builtin: boolean };
type PersonRow = { id: number; name: string; email: string; org: string };

export default function SettingsForm(props: {
  clientAccessEnabled: boolean; clientCanEdit: boolean; allowlist: AllowRow[]; envClients: string[];
  stageDefs: StageRow[]; people: PersonRow[]; eodRecipients: string;
  vocab: VocabRow[]; assetTypes: string[];
  orgs: OrgRow[]; sheetOrgId: number | null; orgNames: string[];
  modules: { sheetSync: boolean; eod: boolean; digest: boolean };
  platformName: string; platformTagline: string; operatorOrgId: number | null;
}) {
  const [view, setView] = useState(props.clientAccessEnabled);
  const [edit, setEdit] = useState(props.clientCanEdit);
  const [newEntry, setNewEntry] = useState("");
  const [moduleState, setModuleState] = useState<Record<string, boolean>>({});
  const [error, setError] = useState("");
  const [pending, startTransition] = useTransition();

  const apply = (nextView: boolean, nextEdit: boolean) => {
    const e = nextView ? nextEdit : false;
    setView(nextView);
    setEdit(e);
    startTransition(() => updateSettings({ clientAccessEnabled: nextView, clientCanEdit: e }));
  };

  const add = () => {
    const v = newEntry.trim();
    if (!v) return;
    setError("");
    startTransition(async () => {
      const res = await addClientAccess(v, parseInt(newEntryOrg), newEntryRole === "editor");
      if (res?.error) setError(res.error);
      else setNewEntry("");
    });
  };

  // What the platform calls itself, and which service org runs it.
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

  // Organizations: who the portal is shared with.
  const [newEntryOrg, setNewEntryOrg] = useState("");
  const [newEntryRole, setNewEntryRole] = useState("viewer");
  const [orgDraft, setOrgDraft] = useState({ name: "", kind: "client" });
  const [orgError, setOrgError] = useState("");
  const submitOrg = () => {
    if (!orgDraft.name.trim()) return;
    setOrgError("");
    startTransition(async () => {
      const res = await addOrg(orgDraft.name, orgDraft.kind);
      if (res?.error) setOrgError(res.error);
      else setOrgDraft({ name: "", kind: orgDraft.kind });
    });
  };
  const dropOrg = (o: OrgRow) => {
    const reason = promptReason(
      `Remove ${o.name}? Their ${o.logins} sign-in entr${o.logins === 1 ? "y" : "ies"} stop working and they lose access to ${o.systems} system${o.systems === 1 ? "" : "s"}. The systems and their history are untouched.`
    );
    if (!reason) return;
    setOrgError("");
    startTransition(async () => {
      const res = await removeOrg(o.id, reason);
      if (res?.error) setOrgError(res.error);
    });
  };

  // Vocabulary: categories + models defined ahead of use.
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

  // People roster + EOD recipients.
  const [personDraft, setPersonDraft] = useState({ name: "", email: "", org: props.orgNames[0] ?? "" });
  const [personError, setPersonError] = useState("");
  // Each organization has its own daily-report recipients (see the
  // Organizations rows) - the report is per client, so the list is too.
  const [recipients, setRecipients] = useState<Record<number, string>>(
    Object.fromEntries(props.orgs.map((o) => [o.id, o.eodRecipients]))
  );
  const [recipientsMsg, setRecipientsMsg] = useState("");
  const submitPerson = () => {
    if (!personDraft.name.trim()) return;
    setPersonError("");
    startTransition(async () => {
      const res = await addPerson(personDraft.name, personDraft.email, personDraft.org);
      if (res?.error) setPersonError(res.error);
      else setPersonDraft({ name: "", email: "", org: personDraft.org });
    });
  };
  const saveRecipients = (orgId: number) => {
    setRecipientsMsg("");
    startTransition(async () => {
      const res = await updateEodRecipients(orgId, recipients[orgId] ?? "");
      setRecipientsMsg(res?.error ?? "Saved ✓");
    });
  };

  // Stage editor: live-preview color drags locally, commit debounced.
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
    <div className="card">
      <div style={{ fontWeight: 700, fontSize: 15, color: "var(--navy)", marginBottom: 4 }}>Client access</div>
      <div className="mut" style={{ fontSize: 13, marginBottom: 14 }}>
        Platform staff always have full access. Editor/viewer is set per person in the sign-in list below.
      </div>
      <div style={{ display: "flex", gap: 12, alignItems: "flex-start", padding: "12px 0", borderTop: "1px solid var(--line)" }}>
        <Toggle on={view} label="Client sign-in" onClick={() => apply(!view, edit)} />
        <div>
          <div style={{ fontSize: 14, fontWeight: 700 }}>Client sign-in</div>
          <div className="mut" style={{ fontSize: 12 }}>Master switch. Off blocks every non-staff sign-in.</div>
        </div>
      </div>
      <div style={{ borderTop: "1px solid var(--line)", paddingTop: 12, marginTop: 2, marginBottom: 12 }}>
        <div style={{ fontSize: 14, fontWeight: 700, marginBottom: 2 }}>People</div>
        <div className="mut" style={{ fontSize: 12, marginBottom: 10 }}>
          Task assignees and @mention targets. An email makes assignments and mentions reach
          them; without one they can still be assigned, just not notified.
        </div>
        {props.people.map((p) => (
          <div key={p.id} style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 0", borderBottom: "1px solid var(--line)" }}>
            <span style={{ fontSize: 13, fontWeight: 700 }}>{p.name}</span>
            {p.org && <span className="pill" style={{ background: "#EEF1F5", color: "#475569" }}>{p.org}</span>}
            {p.email && <span className="mut mono" style={{ fontSize: 11 }}>{p.email}</span>}
            <button className="btn link" style={{ marginLeft: "auto", color: "#A32D2D" }} disabled={pending}
              onClick={() => {
                if (!window.confirm(`Remove ${p.name} from the roster? Existing task assignments keep the name.`)) return;
                startTransition(() => removePerson(p.id));
              }}>remove</button>
          </div>
        ))}
        <div style={{ display: "flex", gap: 6, marginTop: 10, flexWrap: "wrap" }}>
          <input value={personDraft.name} onChange={(e) => setPersonDraft({ ...personDraft, name: e.target.value })}
            placeholder="Name" style={{ flex: "1 1 90px", fontSize: 13 }} />
          <input className="mono" value={personDraft.email} onChange={(e) => setPersonDraft({ ...personDraft, email: e.target.value })}
            placeholder="email (optional)" style={{ flex: "2 1 160px", fontSize: 13 }} />
          <select value={personDraft.org} onChange={(e) => setPersonDraft({ ...personDraft, org: e.target.value })} style={{ width: "auto", fontSize: 13 }}>
            <option value="">no organization</option>
            {props.orgNames.map((n) => <option key={n} value={n}>{n}</option>)}
          </select>
          <button className="btn sm accent" onClick={submitPerson} disabled={pending || !personDraft.name.trim()}>Add</button>
        </div>
        {personError && <div style={{ fontSize: 12, color: "#A32D2D", marginTop: 6 }}>{personError}</div>}
      </div>

      <div style={{ borderTop: "1px solid var(--line)", paddingTop: 12, marginTop: 2, marginBottom: 12 }}>
        <div style={{ fontSize: 14, fontWeight: 700, marginBottom: 2 }}>Categories &amp; models</div>
        <div className="mut" style={{ fontSize: 12, marginBottom: 10 }}>
          The shared vocabulary everything references. Define a model here (say, an ASI-L you don&apos;t
          stock yet) and it shows up wherever models are picked - like scoping a checkout test to both
          the ASI-V and the ASI-L. Removing a term never touches records already using it.
        </div>

        <div className="eyebrow" style={{ marginBottom: 4 }}>System categories</div>
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
        <div style={{ display: "flex", gap: 6, marginBottom: 12 }}>
          <input value={catDraft} onChange={(e) => setCatDraft(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") submitVocab("category"); }}
            placeholder='New category, e.g. "LC-MS"' style={{ flex: 1, fontSize: 13, maxWidth: 260 }} />
          <button className="btn sm" onClick={() => submitVocab("category")} disabled={pending || !catDraft.trim()}>Add</button>
        </div>

        <div className="eyebrow" style={{ marginBottom: 4 }}>Asset models</div>
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
      </div>

      <div style={{ borderTop: "1px solid var(--line)", paddingTop: 12, marginTop: 2, marginBottom: 12 }}>
        <div style={{ fontSize: 14, fontWeight: 700, marginBottom: 2 }}>Stages</div>
        <div className="mut" style={{ fontSize: 12, marginBottom: 10 }}>
          Pick a background color - the text color adjusts automatically. Built-in stage names are locked
          (sync and reports key on them); stages you add can be renamed or deleted.
        </div>
        {props.stageDefs.map((s) => (
          <div key={s.id} style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 0", borderBottom: "1px solid var(--line)" }}>
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
        <div style={{ display: "flex", gap: 6, marginTop: 10, alignItems: "center" }}>
          <input value={stageDraft.name} onChange={(e) => setStageDraft({ ...stageDraft, name: e.target.value })}
            onKeyDown={(e) => { if (e.key === "Enter") submitStage(); }}
            placeholder="New stage name" style={{ flex: 1, fontSize: 13 }} />
          <input type="color" value={stageDraft.bg} onChange={(e) => setStageDraft({ ...stageDraft, bg: e.target.value })}
            style={{ width: 34, height: 30, padding: 2, border: "1px solid var(--line)", borderRadius: 6, background: "#fff", cursor: "pointer" }} />
          <button className="btn sm accent" onClick={submitStage} disabled={pending || !stageDraft.name.trim()}>Add</button>
        </div>
        {stageError && <div style={{ fontSize: 12, color: "#A32D2D", marginTop: 6 }}>{stageError}</div>}
      </div>

      <div style={{ borderTop: "1px solid var(--line)", paddingTop: 12, marginTop: 2 }}>
        <div style={{ fontSize: 14, fontWeight: 700, marginBottom: 2 }}>Modules</div>
        <div className="mut" style={{ fontSize: 12, marginBottom: 10 }}>
          Optional workflows. Off hides their pages and silences their scheduled runs.
        </div>
        {([
          ["sheetSync", "Google Sheet tracker sync", props.modules.sheetSync],
          ["eod", "EOD client report", props.modules.eod],
          ["digest", "Daily staff digest", props.modules.digest],
        ] as const).map(([key, label, on]) => (
          <div key={key} style={{ display: "flex", gap: 12, alignItems: "center", padding: "8px 0", borderTop: "1px solid var(--line)" }}>
            <Toggle on={moduleState[key] ?? on} label={label}
              onClick={() => {
                const next = !(moduleState[key] ?? on);
                setModuleState((m) => ({ ...m, [key]: next }));
                startTransition(async () => { await setModule(key, next); });
              }} />
            <div style={{ fontSize: 13, fontWeight: 700 }}>{label}</div>
          </div>
        ))}
      </div>

      <div style={{ borderTop: "1px solid var(--line)", paddingTop: 12, marginTop: 2 }}>
        <div style={{ fontSize: 14, fontWeight: 700, marginBottom: 2 }}>Platform identity</div>
        <div className="mut" style={{ fontSize: 12, marginBottom: 10 }}>
          The portal&apos;s name, shown in the header, browser tab, sign-in page and emails.
        </div>
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
        </div>
        {brandError && <div style={{ fontSize: 12, color: "#A32D2D", marginTop: 6 }}>{brandError}</div>}

        <div style={{ display: "flex", gap: 6, marginTop: 12, alignItems: "center", flexWrap: "wrap" }}>
          <span className="mut" style={{ fontSize: 12 }}>Operated by:</span>
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
            <option value="">Nobody - use the platform name</option>
            {props.orgs.filter((o) => o.kind === "provider").map((o) => (
              <option key={o.id} value={o.id}>{o.name}</option>
            ))}
          </select>
        </div>
        <div className="mut" style={{ fontSize: 11, marginTop: 4 }}>
          Named on sign-off packets and daily reports; systems staff create are shared with it.
        </div>
      </div>

      <div style={{ borderTop: "1px solid var(--line)", paddingTop: 12, marginTop: 2 }}>
        <div style={{ fontSize: 14, fontWeight: 700, marginBottom: 2 }}>Organizations</div>
        <div className="mut" style={{ fontSize: 12, marginBottom: 10 }}>
          A <b>client</b> owns systems; a <b>provider</b> services them. Each sees only what&apos;s shared with it.
        </div>
        {props.orgs.map((o) => (
          <div key={o.id} style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 0", borderBottom: "1px solid var(--line)", flexWrap: "wrap" }}>
            <span style={{ fontSize: 13, fontWeight: 700 }}>{o.name}</span>
            <span className="pill" style={{ background: o.kind === "provider" ? "#FAF0DC" : "#E7F2FA", color: o.kind === "provider" ? "#8A5410" : "#1D6396" }}>{o.kind}</span>
            <span className="mut" style={{ fontSize: 11 }}>
              {o.systems} system{o.systems === 1 ? "" : "s"} · {o.logins} sign-in entr{o.logins === 1 ? "y" : "ies"}
            </span>
            {props.sheetOrgId === o.id && (
              <span className="pill" style={{ background: "#E5F3E5", color: "#2E6B2E" }}>tracker + EOD</span>
            )}
            <span style={{ marginLeft: "auto", display: "flex", gap: 8, alignItems: "center" }}>
              {/* Owner override: repaint any org (orgs style themselves on their dashboard). */}
              <input type="color" value={o.themeColor || "#172A4A"} disabled={pending}
                aria-label={`Header color for ${o.name}`} title={`Header color for ${o.name}`}
                onChange={(e) => startTransition(async () => {
                  const res = await setOrgAppearance({ themeColor: e.target.value, logoUrl: o.logoUrl }, o.id);
                  if (res?.error) setOrgError(res.error);
                })}
                style={{ width: 26, height: 22, padding: 1, border: "1px solid var(--line)", borderRadius: 5, background: "#fff", cursor: "pointer" }} />
              {(o.themeColor || o.logoUrl) && (
                <button className="btn link" style={{ fontSize: 11 }} disabled={pending}
                  onClick={() => startTransition(async () => {
                    const res = await setOrgAppearance({ themeColor: "", logoUrl: "" }, o.id);
                    if (res?.error) setOrgError(res.error);
                  })}>default look</button>
              )}
              {props.sheetOrgId !== o.id && o.kind === "client" && (
                <button className="btn link" style={{ fontSize: 11 }} disabled={pending}
                  onClick={() => startTransition(() => setSheetOrg(o.id))}>use for tracker/EOD</button>
              )}
              <button className="btn link" style={{ color: "#A32D2D", fontSize: 11 }} disabled={pending}
                onClick={() => dropOrg(o)}>remove</button>
            </span>
            <div style={{ flexBasis: "100%", display: "flex", gap: 6, alignItems: "center" }}>
              <span className="mut" style={{ fontSize: 11, whiteSpace: "nowrap" }}>Daily report to</span>
              <input className="mono" value={recipients[o.id] ?? ""}
                onChange={(e) => { setRecipients((r) => ({ ...r, [o.id]: e.target.value })); setRecipientsMsg(""); }}
                placeholder="nobody - no report is sent" style={{ flex: 1, fontSize: 12 }} />
              <button className="btn link" style={{ fontSize: 11 }} disabled={pending || (recipients[o.id] ?? "") === o.eodRecipients}
                onClick={() => saveRecipients(o.id)}>save</button>
            </div>
          </div>
        ))}
        {recipientsMsg && (
          <div style={{ fontSize: 12, marginTop: 6, color: recipientsMsg === "Saved ✓" ? "#2E6B2E" : "#A32D2D" }}>{recipientsMsg}</div>
        )}
        {props.orgs.length === 0 && (
          <div className="mut" style={{ fontSize: 12, marginBottom: 6 }}>
            None yet - add one, then share systems with it from each system&apos;s page.
          </div>
        )}
        <div style={{ display: "flex", gap: 6, marginTop: 10, flexWrap: "wrap" }}>
          <input value={orgDraft.name} onChange={(e) => setOrgDraft({ ...orgDraft, name: e.target.value })}
            onKeyDown={(e) => { if (e.key === "Enter") submitOrg(); }}
            placeholder="Organization name" style={{ flex: "1 1 160px", fontSize: 13 }} />
          <select value={orgDraft.kind} onChange={(e) => setOrgDraft({ ...orgDraft, kind: e.target.value })}
            style={{ width: "auto", fontSize: 12 }}>
            <option value="client">client</option>
            <option value="provider">provider</option>
          </select>
          <button className="btn sm accent" onClick={submitOrg} disabled={pending || !orgDraft.name.trim()}>Add</button>
        </div>
        {orgError && <div style={{ fontSize: 12, color: "#A32D2D", marginTop: 6 }}>{orgError}</div>}
      </div>

      <div style={{ borderTop: "1px solid var(--line)", paddingTop: 12, marginTop: 2 }}>
        <div style={{ fontSize: 14, fontWeight: 700, marginBottom: 2 }}>Who can sign in as a client</div>
        <div className="mut" style={{ fontSize: 12, marginBottom: 10 }}>
          An email allows one person; <span className="mono">@company.com</span> allows everyone at that domain.
          Each entry signs in as one organization and sees only what&apos;s shared with it; an exact email
          beats a domain entry, so one person can be split out of their company&apos;s organization.
          Removing an entry signs those people out immediately.
        </div>

        {props.envClients.length > 0 && (
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 8 }}>
            {props.envClients.map((e) => (
              <span key={e} className="pill mono" title="Set in server config (CLIENT_EMAILS) - remove it there"
                style={{ background: "#EEF1F5", color: "#64748B" }}>{e} · env</span>
            ))}
          </div>
        )}

        {props.allowlist.map((r) => (
          <div key={r.id} style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 0", borderBottom: "1px solid var(--line)" }}>
            <span className="mono" style={{ fontSize: 13 }}>{r.entry}</span>
            {r.entry.startsWith("@") && <span className="pill" style={{ background: "#E7F2FA", color: "#1D6396" }}>whole domain</span>}
            <select value={r.orgId ?? ""} disabled={pending} aria-label={`Organization for ${r.entry}`}
              onChange={(e) => { const v = parseInt(e.target.value); if (v) startTransition(async () => { await setClientAccessOrg(r.id, v); }); }}
              style={{ width: "auto", fontSize: 11, padding: "2px 4px" }}>
              <option value="">no organization - cannot sign in</option>
              {props.orgs.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
            </select>
            <select value={r.canEdit ? "editor" : "viewer"} disabled={pending} aria-label={`Role for ${r.entry}`}
              onChange={(e) => startTransition(async () => { await setClientAccessRole(r.id, e.target.value === "editor"); })}
              style={{ width: "auto", fontSize: 11, padding: "2px 4px" }}>
              <option value="viewer">viewer</option>
              <option value="editor">editor</option>
            </select>
            {r.addedBy && <span className="mut hide-m" style={{ fontSize: 11 }}>added by {r.addedBy}</span>}
            <button className="btn link" style={{ marginLeft: "auto", color: "#A32D2D" }} disabled={pending}
              onClick={() => {
                if (!window.confirm(`Remove ${r.entry}? Anyone covered only by this entry is signed out immediately.`)) return;
                startTransition(() => removeClientAccess(r.id));
              }}>remove</button>
          </div>
        ))}
        {props.allowlist.length === 0 && props.envClients.length === 0 && (
          <div className="mut" style={{ fontSize: 12, marginBottom: 6 }}>No client emails yet.</div>
        )}

        <div style={{ display: "flex", gap: 6, marginTop: 10 }}>
          <input className="mono" value={newEntry} onChange={(e) => setNewEntry(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") add(); }}
            placeholder="jane@company.com or @company.com" style={{ flex: "1 1 180px", fontSize: 13 }} />
          <select value={newEntryOrg} onChange={(e) => setNewEntryOrg(e.target.value)} style={{ width: "auto", fontSize: 12 }}>
            <option value="">signs in as...</option>
            {props.orgs.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
          </select>
          <select value={newEntryRole} onChange={(e) => setNewEntryRole(e.target.value)} style={{ width: "auto", fontSize: 12 }}>
            <option value="viewer">viewer</option>
            <option value="editor">editor</option>
          </select>
          <button className="btn sm accent" onClick={add} disabled={pending || !newEntry.trim() || !newEntryOrg}>
            {pending ? "..." : "Invite"}
          </button>
        </div>
        {error && <div style={{ fontSize: 12, color: "#A32D2D", marginTop: 6 }}>{error}</div>}
      </div>

      <div className="mut" style={{ marginTop: 14, fontSize: 12, borderTop: "1px solid var(--line)", paddingTop: 12 }}>
        Roles: owner · staff · client-viewer · client-editor, enforced server-side on every action.
      </div>
    </div>
  );
}
