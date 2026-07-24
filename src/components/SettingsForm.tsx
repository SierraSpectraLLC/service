"use client";

import { useRef, useState, useTransition } from "react";
import {
  updateSettings, addClientAccess, removeClientAccess,
  addStage, setStageColor, renameStage, deleteStage,
} from "@/app/actions";

function Toggle({ on, onClick, label }: { on: boolean; onClick: () => void; label: string }) {
  return (
    <button onClick={onClick} aria-label={label}
      style={{ width: 42, height: 24, borderRadius: 999, border: "none", cursor: "pointer", background: on ? "var(--coral)" : "var(--line)", position: "relative", flexShrink: 0, padding: 0 }}>
      <span style={{ position: "absolute", top: 3, left: on ? 21 : 3, width: 18, height: 18, borderRadius: "50%", background: "#fff", transition: "left 120ms" }} />
    </button>
  );
}

type AllowRow = { id: number; entry: string; addedBy: string };
type StageRow = { id: number; name: string; bg: string; fg: string; builtin: boolean };

export default function SettingsForm(props: {
  clientAccessEnabled: boolean; clientCanEdit: boolean; allowlist: AllowRow[]; envClients: string[];
  stageDefs: StageRow[];
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
      const res = await addClientAccess(v);
      if (res?.error) setError(res.error);
      else setNewEntry("");
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
        <div style={{ fontSize: 14, fontWeight: 700, marginBottom: 2 }}>Who can sign in as a client</div>
        <div className="mut" style={{ fontSize: 12, marginBottom: 10 }}>
          An email allows one person; <span className="mono">@company.com</span> allows everyone at that domain.
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
            {r.addedBy && <span className="mut" style={{ fontSize: 11 }}>added by {r.addedBy}</span>}
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
            placeholder="jane@labzenllc.com or @labzenllc.com" style={{ flex: 1, fontSize: 13 }} />
          <button className="btn sm accent" onClick={add} disabled={pending || !newEntry.trim()}>
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
