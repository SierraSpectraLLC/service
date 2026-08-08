"use client";

import { useState, useTransition } from "react";
import { addClientAccess, removeClientAccess } from "@/app/actions";

type Entry = { id: number; entry: string; canEdit: boolean };

/**
 * An organization's editors manage their own colleagues: invite by email,
 * remove. Domain-wide entries and role changes stay with the platform owner.
 */
export default function MembersCard({ orgId, orgName, entries }: {
  orgId: number; orgName: string; entries: Entry[];
}) {
  const [email, setEmail] = useState("");
  const [role, setRole] = useState("viewer");
  const [error, setError] = useState("");
  const [sent, setSent] = useState("");
  const [pending, startTransition] = useTransition();

  const invite = () => {
    const v = email.trim();
    if (!v) return;
    setError(""); setSent("");
    startTransition(async () => {
      const res = await addClientAccess(v, orgId, role === "editor");
      if (res?.error) setError(res.error);
      else { setSent(v); setEmail(""); }
    });
  };

  return (
    <div className="card">
      <div className="card-title">People at {orgName}</div>
      <div className="mut" style={{ fontSize: 11, marginBottom: 8 }}>
        Everyone here signs in with their email - no passwords.
      </div>
      {entries.map((e) => (
        <div key={e.id} style={{ display: "flex", alignItems: "center", gap: 8, padding: "5px 0", borderTop: "1px solid var(--line)" }}>
          <span className="mono" style={{ fontSize: 13 }}>{e.entry}</span>
          <span className="pill" style={{ background: e.canEdit ? "#E5F3E5" : "#EEF1F5", color: e.canEdit ? "#2E6B2E" : "#475569" }}>
            {e.entry.startsWith("@") ? "whole domain" : e.canEdit ? "editor" : "viewer"}
          </span>
          {!e.entry.startsWith("@") && (
            <button className="btn link" style={{ marginLeft: "auto", color: "#A32D2D" }} disabled={pending}
              onClick={() => {
                if (!window.confirm(`Remove ${e.entry}? They are signed out immediately.`)) return;
                startTransition(() => removeClientAccess(e.id));
              }}>remove</button>
          )}
        </div>
      ))}
      <div style={{ display: "flex", gap: 6, marginTop: 10, flexWrap: "wrap" }}>
        <input className="mono" value={email} onChange={(e) => setEmail(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") invite(); }}
          placeholder="colleague@company.com" style={{ flex: "1 1 180px", fontSize: 13 }} />
        <select value={role} onChange={(e) => setRole(e.target.value)} style={{ width: "auto", fontSize: 12 }}>
          <option value="viewer">viewer</option>
          <option value="editor">editor</option>
        </select>
        <button className="btn sm accent" onClick={invite} disabled={pending || !email.trim()}>
          {pending ? "Inviting..." : "Invite"}
        </button>
      </div>
      {sent && <div style={{ fontSize: 12, color: "#2E6B2E", marginTop: 6 }}>Invited {sent} - they got an email with a sign-in link.</div>}
      {error && <div style={{ fontSize: 12, color: "#A32D2D", marginTop: 6 }}>{error}</div>}
    </div>
  );
}
