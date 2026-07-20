"use client";

import { useState, useTransition } from "react";
import { updateSettings } from "@/app/actions";

function Toggle({ on, onClick, label }: { on: boolean; onClick: () => void; label: string }) {
  return (
    <button onClick={onClick} aria-label={label}
      style={{ width: 42, height: 24, borderRadius: 999, border: "none", cursor: "pointer", background: on ? "var(--coral)" : "var(--line)", position: "relative", flexShrink: 0, padding: 0 }}>
      <span style={{ position: "absolute", top: 3, left: on ? 21 : 3, width: 18, height: 18, borderRadius: "50%", background: "#fff", transition: "left 120ms" }} />
    </button>
  );
}

export default function SettingsForm(props: { clientAccessEnabled: boolean; clientCanEdit: boolean }) {
  const [view, setView] = useState(props.clientAccessEnabled);
  const [edit, setEdit] = useState(props.clientCanEdit);
  const [, startTransition] = useTransition();

  const apply = (nextView: boolean, nextEdit: boolean) => {
    const e = nextView ? nextEdit : false;
    setView(nextView);
    setEdit(e);
    startTransition(() => updateSettings({ clientAccessEnabled: nextView, clientCanEdit: e }));
  };

  return (
    <div className="card">
      <div style={{ fontWeight: 700, fontSize: 15, color: "var(--navy)", marginBottom: 4 }}>Client access</div>
      <div className="mut" style={{ fontSize: 13, marginBottom: 14 }}>
        Sierra Spectra staff always have full access. These toggles control what client accounts (CLIENT_EMAILS) can do.
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
      <div className="mut" style={{ marginTop: 14, fontSize: 12, borderTop: "1px solid var(--line)", paddingTop: 12 }}>
        Roles: owner · staff · client-viewer · client-editor, enforced server-side on every action.
      </div>
    </div>
  );
}
