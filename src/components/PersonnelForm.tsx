"use client";

import Link from "next/link";
import { useState, useTransition } from "react";
import {
  updateSettings, addOrg, addPerson, removePerson,
  removeClientAccess, setClientAccessOrg,
} from "@/app/actions";

function Toggle({ on, onClick, label }: { on: boolean; onClick: () => void; label: string }) {
  return (
    <button onClick={onClick} aria-label={label}
      style={{ width: 42, height: 24, borderRadius: 999, border: "none", cursor: "pointer", background: on ? "var(--coral)" : "var(--line)", position: "relative", flexShrink: 0, padding: 0 }}>
      <span style={{ position: "absolute", top: 3, left: on ? 21 : 3, width: 18, height: 18, borderRadius: "50%", background: "#fff", transition: "left 120ms" }} />
    </button>
  );
}

type OrgRow = {
  id: number; name: string; kind: string; themeColor: string;
  systems: number; logins: number; editors: number; recipients: string;
};
type PersonRow = { id: number; name: string; email: string; org: string };
type OrphanRow = { id: number; entry: string };

/**
 * Who is on this instance. Organizations are a directory here - each one's own
 * settings live on its own page, because an organization has enough to configure
 * (its look, its people, its recipients) that a shared list can't hold it, and
 * because that page is also the one an organization's own editors use.
 */
export default function PersonnelForm(props: {
  clientAccessEnabled: boolean;
  orgs: OrgRow[]; orphans: OrphanRow[];
  people: PersonRow[]; orgNames: string[];
  operatorOrgId: number | null; sheetOrgId: number | null;
  showRecipients: boolean; showSheetSync: boolean;
}) {
  const [view, setView] = useState(props.clientAccessEnabled);
  const [error, setError] = useState("");
  const [pending, startTransition] = useTransition();

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

  const [personDraft, setPersonDraft] = useState({ name: "", email: "", org: props.orgNames[0] ?? "" });
  const [personError, setPersonError] = useState("");
  const submitPerson = () => {
    if (!personDraft.name.trim()) return;
    setPersonError("");
    startTransition(async () => {
      const res = await addPerson(personDraft.name, personDraft.email, personDraft.org);
      if (res?.error) setPersonError(res.error);
      else setPersonDraft({ name: "", email: "", org: personDraft.org });
    });
  };

  return (
    <>
      <div className="card">
        <div className="card-title">Organizations</div>
        <div className="mut" style={{ fontSize: 12, marginBottom: 10 }}>
          A client owns systems; a provider services them. Each sees only what&apos;s shared with it. Open one to
          set its look, its people and where its reports go.
        </div>

        <div style={{ display: "flex", gap: 12, alignItems: "center", padding: "2px 0 10px" }}>
          <Toggle on={view} label="Client sign-in" onClick={() => {
            const next = !view;
            setView(next);
            startTransition(() => updateSettings({ clientAccessEnabled: next }));
          }} />
          <div>
            <div style={{ fontSize: 13, fontWeight: 700 }}>Client sign-in</div>
            <div className="mut" style={{ fontSize: 11 }}>Master switch. Off blocks every non-staff sign-in, whatever each organization&apos;s list says.</div>
          </div>
        </div>

        {props.orgs.map((o) => (
          <Link key={o.id} href={`/settings/organizations/${o.id}`} className="row-hover"
            style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", padding: "9px 4px", borderTop: "1px solid var(--line)", textDecoration: "none", color: "inherit" }}>
            {/* Their header color, so the list looks like the workspaces do. */}
            <span aria-hidden style={{ width: 10, height: 10, borderRadius: 3, flexShrink: 0, background: o.themeColor || "var(--line)" }} />
            <span style={{ fontSize: 14, fontWeight: 700 }}>{o.name}</span>
            <span className="pill" style={{ background: o.kind === "provider" ? "#FAF0DC" : "#E7F2FA", color: o.kind === "provider" ? "#8A5410" : "#1D6396" }}>{o.kind}</span>
            {props.operatorOrgId === o.id && (
              <span className="pill" style={{ background: "#E5F3E5", color: "#2E6B2E" }}>operator</span>
            )}
            {props.showSheetSync && props.sheetOrgId === o.id && (
              <span className="pill" style={{ background: "#E5F3E5", color: "#2E6B2E" }}>sheet sync</span>
            )}
            <span className="mut" style={{ fontSize: 11, marginLeft: "auto", textAlign: "right" }}>
              {o.systems} system{o.systems === 1 ? "" : "s"} ·{" "}
              {o.logins === 0
                ? "nobody can sign in"
                : `${o.logins} sign-in${o.logins === 1 ? "" : "s"}${o.editors ? `, ${o.editors} can edit` : ""}`}
              {props.showRecipients && !o.recipients.trim() && " · no report recipients"}
            </span>
          </Link>
        ))}
        {props.orgs.length === 0 && (
          <div className="mut" style={{ fontSize: 12, margin: "6px 0" }}>
            None yet - add one, then share systems with it from each system&apos;s page.
          </div>
        )}

        <div style={{ display: "flex", gap: 6, marginTop: 10, flexWrap: "wrap" }}>
          <input value={orgDraft.name} onChange={(e) => setOrgDraft({ ...orgDraft, name: e.target.value })}
            onKeyDown={(e) => { if (e.key === "Enter") submitOrg(); }}
            placeholder="New organization name" style={{ flex: "1 1 160px", fontSize: 13 }} />
          <select value={orgDraft.kind} onChange={(e) => setOrgDraft({ ...orgDraft, kind: e.target.value })}
            style={{ width: "auto", fontSize: 12 }}>
            <option value="client">client</option>
            <option value="provider">provider</option>
          </select>
          <button className="btn sm accent" onClick={submitOrg} disabled={pending || !orgDraft.name.trim()}>Add</button>
        </div>
        {orgError && <div style={{ fontSize: 12, color: "#A32D2D", marginTop: 6 }}>{orgError}</div>}
      </div>

      {/* A sign-in with no organization has no scope, so it can't sign in at all. */}
      {props.orphans.length > 0 && (
        <div className="card" style={{ borderColor: "#EAD9B0", background: "#FDF8EE" }}>
          <div className="card-title" style={{ color: "#8A5410" }}>Sign-ins with no organization</div>
          <div className="mut" style={{ fontSize: 12, marginBottom: 8 }}>
            These cannot sign in until they name one - a login with no organization has nothing to see.
          </div>
          {props.orphans.map((r) => (
            <div key={r.id} style={{ display: "flex", alignItems: "center", gap: 8, padding: "5px 0", borderTop: "1px solid var(--line)", flexWrap: "wrap" }}>
              <span className="mono" style={{ fontSize: 12 }}>{r.entry}</span>
              <select defaultValue="" disabled={pending} aria-label={`Organization for ${r.entry}`}
                onChange={(e) => { const v = parseInt(e.target.value); if (v) startTransition(async () => { await setClientAccessOrg(r.id, v); }); }}
                style={{ width: "auto", fontSize: 11, padding: "1px 4px" }}>
                <option value="">choose an organization</option>
                {props.orgs.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
              </select>
              <button className="btn link" style={{ marginLeft: "auto", color: "#A32D2D", fontSize: 11 }} disabled={pending}
                onClick={() => {
                  if (!window.confirm(`Remove ${r.entry}?`)) return;
                  setError("");
                  startTransition(() => removeClientAccess(r.id));
                }}>remove</button>
            </div>
          ))}
          {error && <div style={{ fontSize: 12, color: "#A32D2D", marginTop: 6 }}>{error}</div>}
        </div>
      )}

      <div className="card">
        <div className="card-title">Roster</div>
        <div className="mut" style={{ fontSize: 12, marginBottom: 10 }}>
          Names tasks can be assigned to and @mentions can reach. An email makes assignments and mentions reach
          them; without one they can still be assigned, just not notified. Signing in is separate - that&apos;s
          each organization&apos;s own page.
        </div>
        {props.people.map((p) => (
          <div key={p.id} style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 0", borderTop: "1px solid var(--line)" }}>
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
        {props.people.length === 0 && <div className="mut" style={{ fontSize: 12 }}>Nobody on the roster yet.</div>}
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
    </>
  );
}
