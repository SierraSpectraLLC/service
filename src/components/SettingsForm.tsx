"use client";

import { useRef, useState, useTransition } from "react";
import {
  updateSettings, addClientAccess, removeClientAccess,
  addStage, setStageColor, renameStage, deleteStage,
  addPerson, removePerson, updateEodRecipients,
  addVocabTerm, deleteVocabTerm,
  addOrg, removeOrg, setSheetOrg, setClientAccessOrg,
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

type AllowRow = { id: number; entry: string; addedBy: string; orgId: number | null };
type OrgRow = { id: number; name: string; kind: string; systems: number; logins: number };
type VocabRow = { id: number; kind: string; assetType: string; name: string };
type StageRow = { id: number; name: string; bg: string; fg: string; builtin: boolean };
type PersonRow = { id: number; name: string; email: string; org: string };

export default function SettingsForm(props: {
  clientAccessEnabled: boolean; clientCanEdit: boolean; allowlist: AllowRow[]; envClients: string[];
  stageDefs: StageRow[]; people: PersonRow[]; eodRecipients: string;
  vocab: VocabRow[]; assetTypes: string[];
  orgs: OrgRow[]; sheetOrgId: number | null;
}) {
  const [view, setView] = useState(props.clientAccessEnabled);
  const [edit, setEdit] = useState(props.clientCanEdit);
  const [newEntry, setNewEntry] = useState("");
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
      const res = await addClientAccess(v, parseInt(newEntryOrg));
      if (res?.error) setError(res.error);
      else setNewEntry("");
    });
  };

  // Organizations: who the portal is shared with.
  const [newEntryOrg, setNewEntryOrg] = useState("");
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
  const [personDraft, setPersonDraft] = useState({ name: "", email: "", org: "sierra" });
  const [personError, setPersonError] = useState("");
  const [recipients, setRecipients] = useState(props.eodRecipients);
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
  const saveRecipients = () => {
    setRecipientsMsg("");
    startTransition(async () => {
      const res = await updateEodRecipients(recipients);
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
        Sierra Spectra staff always have full access. These toggles control what client accounts (the sign-in list below) can do.
      </div>
      <div style={{ display: "flex", gap: 12, alignItems: "flex-start", padding: "12px 0", borderTop: "1px solid var(--line)" }}>
        <Toggle on={view} label="Client can view" onClick={() => apply(!view, edit)} />
        <div>
          <div style={{ fontSize: 14, fontWeight: 700 }}>Client can view</div>
          <div className="mut" style={{ fontSize: 12 }}>Read-only dashboard and instrument detail. No settings, no parity view. Turning this off also blocks client sign-in.</div>
        </div>
      </div>
      <div style={{ display: "flex", gap: 12, alignItems: "flex-start", padding: "12px 0", borderTop: "1px solid var(--line)" }}>
        <Toggle on={edit} label="Client can edit" onClick={() => apply(edit && !view ? view : (edit ? view : true), !edit)} />
        <div>
          <div style={{ fontSize: 14, fontWeight: 700 }}>Client can edit</div>
          <div className="mut" style={{ fontSize: 12 }}>Stages, tasks, parts, and notes. Every change is attributed in the audit log. Enabling this also enables viewing.</div>
        </div>
      </div>
      <div style={{ borderTop: "1px solid var(--line)", paddingTop: 12, marginTop: 2, marginBottom: 12 }}>
        <div style={{ fontSize: 14, fontWeight: 700, marginBottom: 2 }}>People</div>
        <div className="mut" style={{ fontSize: 12, marginBottom: 10 }}>
          Task assignees and @mention targets - Sierra and LabZen. An email makes assignments and
          mentions reach them; without one they can still be assigned, just not notified.
        </div>
        {props.people.map((p) => (
          <div key={p.id} style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 0", borderBottom: "1px solid var(--line)" }}>
            <span style={{ fontSize: 13, fontWeight: 700 }}>{p.name}</span>
            <span className="pill" style={p.org === "labzen"
              ? { background: "#E7F2FA", color: "#1D6396" }
              : { background: "#EEF1F5", color: "#475569" }}>
              {p.org === "labzen" ? "LabZen" : "Sierra"}
            </span>
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
            <option value="sierra">Sierra</option>
            <option value="labzen">LabZen</option>
          </select>
          <button className="btn sm accent" onClick={submitPerson} disabled={pending || !personDraft.name.trim()}>Add</button>
        </div>
        {personError && <div style={{ fontSize: 12, color: "#A32D2D", marginTop: 6 }}>{personError}</div>}
      </div>

      <div style={{ borderTop: "1px solid var(--line)", paddingTop: 12, marginTop: 2, marginBottom: 12 }}>
        <div style={{ fontSize: 14, fontWeight: 700, marginBottom: 2 }}>EOD email recipients</div>
        <div className="mut" style={{ fontSize: 12, marginBottom: 10 }}>
          Who the EOD page&apos;s &quot;Send to LabZen&quot; button emails. Comma-separated.
        </div>
        <div style={{ display: "flex", gap: 6 }}>
          <input className="mono" value={recipients} onChange={(e) => { setRecipients(e.target.value); setRecipientsMsg(""); }}
            placeholder="michael@labzenllc.com, adam@labzenllc.com" style={{ flex: 1, fontSize: 13 }} />
          <button className="btn sm accent" onClick={saveRecipients} disabled={pending || recipients === props.eodRecipients}>Save</button>
        </div>
        {recipientsMsg && (
          <div style={{ fontSize: 12, marginTop: 6, color: recipientsMsg === "Saved ✓" ? "#2E6B2E" : "#A32D2D" }}>{recipientsMsg}</div>
        )}
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
        <div style={{ fontSize: 14, fontWeight: 700, marginBottom: 2 }}>Organizations</div>
        <div className="mut" style={{ fontSize: 12, marginBottom: 10 }}>
          Who the portal is shared with. A <b>client</b> owns or operates systems; a <b>provider</b> is an
          outside service outfit brought onto specific systems. Each organization sees only the systems
          shared with it - set that on a system&apos;s own page. Sierra Spectra always sees everything.
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
              {props.sheetOrgId !== o.id && o.kind === "client" && (
                <button className="btn link" style={{ fontSize: 11 }} disabled={pending}
                  onClick={() => startTransition(() => setSheetOrg(o.id))}>use for tracker/EOD</button>
              )}
              <button className="btn link" style={{ color: "#A32D2D", fontSize: 11 }} disabled={pending}
                onClick={() => dropOrg(o)}>remove</button>
            </span>
          </div>
        ))}
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
            placeholder="jane@labzenllc.com or @labzenllc.com" style={{ flex: "1 1 180px", fontSize: 13 }} />
          <select value={newEntryOrg} onChange={(e) => setNewEntryOrg(e.target.value)} style={{ width: "auto", fontSize: 12 }}>
            <option value="">signs in as...</option>
            {props.orgs.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
          </select>
          <button className="btn sm accent" onClick={add} disabled={pending || !newEntry.trim() || !newEntryOrg}>
            {pending ? "..." : "Add"}
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
