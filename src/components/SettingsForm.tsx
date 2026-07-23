"use client";

import { useState, useTransition } from "react";
import { updateSettings, addClientAccess, removeClientAccess } from "@/app/actions";

function Toggle({ on, onClick, label }: { on: boolean; onClick: () => void; label: string }) {
  return (
    <button onClick={onClick} aria-label={label}
      style={{ width: 42, height: 24, borderRadius: 999, border: "none", cursor: "pointer", background: on ? "var(--coral)" : "var(--line)", position: "relative", flexShrink: 0, padding: 0 }}>
      <span style={{ position: "absolute", top: 3, left: on ? 21 : 3, width: 18, height: 18, borderRadius: "50%", background: "#fff", transition: "left 120ms" }} />
    </button>
  );
}

type AllowRow = { id: number; entry: string; addedBy: string };

export default function SettingsForm(props: {
  clientAccessEnabled: boolean; clientCanEdit: boolean; allowlist: AllowRow[]; envClients: string[];
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
