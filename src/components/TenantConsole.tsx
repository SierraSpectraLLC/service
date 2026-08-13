"use client";

import { useState, useTransition } from "react";
import { createOperator } from "@/app/actions";

export type TenantRow = {
  id: number; name: string;
  staff: number; owners: number;
  clients: number; clientLogins: number;
  systems: number; live: number;
  machines: number; invitedOnto: number;
  since: string;
};

/**
 * One row per service company, and the form that opens a workspace for the next
 * one. The numbers are the ones a price is built from - seats, clients, systems,
 * machines - so an invoice is read here rather than reconstructed later.
 */
export default function TenantConsole({ rows, unassigned, rootOrgId }: {
  rows: TenantRow[];
  /** Staff rows with no company: they see nothing until one is set, so say so. */
  unassigned: string[];
  rootOrgId: number | null;
}) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [error, setError] = useState("");
  const [done, setDone] = useState("");
  const [pending, startTransition] = useTransition();

  const submit = () => {
    setError(""); setDone("");
    startTransition(async () => {
      const res = await createOperator(name, email);
      if (res?.error) { setError(res.error); return; }
      setDone(`${name.trim()} can sign in as ${email.trim().toLowerCase()}`);
      setName(""); setEmail(""); setOpen(false);
    });
  };

  const cell = { padding: "7px 8px", fontSize: 12.5, textAlign: "right" as const, whiteSpace: "nowrap" as const };
  const head = { ...cell, fontSize: 11, fontWeight: 700, color: "var(--mut)", textTransform: "uppercase" as const, letterSpacing: 0.4 };

  return (
    <div className="card">
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4, flexWrap: "wrap" }}>
        <div className="card-title">Service companies</div>
        <button className="btn sm accent" style={{ marginLeft: "auto" }} onClick={() => setOpen((v) => !v)}>
          {open ? "Cancel" : "+ Open a workspace"}
        </button>
      </div>

      {open && (
        <div style={{ border: "1px solid var(--line)", borderRadius: 10, padding: "10px 12px", margin: "8px 0" }}>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "flex-end" }}>
            <div style={{ flex: "1 1 200px" }}>
              <label style={{ fontSize: 12, fontWeight: 700, display: "block", marginBottom: 3 }}>Company</label>
              <input value={name} onChange={(e) => setName(e.target.value)} autoFocus
                placeholder="Northwind Analytical" style={{ width: "100%", fontSize: 13 }} />
            </div>
            <div style={{ flex: "1 1 220px" }}>
              <label style={{ fontSize: 12, fontWeight: 700, display: "block", marginBottom: 3 }}>Their first owner</label>
              <input value={email} onChange={(e) => setEmail(e.target.value)} type="email"
                placeholder="owner@northwind.com" style={{ width: "100%", fontSize: 13 }} />
            </div>
            <button className="btn sm accent" disabled={pending || !name.trim() || !email.trim()} onClick={submit}>
              {pending ? "Opening..." : "Open"}
            </button>
          </div>
          {error && <div style={{ fontSize: 12, color: "#A32D2D", marginTop: 8 }}>{error}</div>}
        </div>
      )}
      {done && <div style={{ fontSize: 12.5, color: "#2E6B2E", fontWeight: 700, margin: "6px 0" }}>Opened ✓ {done}</div>}

      {unassigned.length > 0 && (
        <div style={{ fontSize: 12.5, color: "#8A5410", background: "#FAF0DC", borderRadius: 8, padding: "7px 10px", margin: "8px 0" }}>
          No company set for {unassigned.join(", ")} — they see nothing until one is.
        </div>
      )}

      <div style={{ overflowX: "auto" }}>
        <table style={{ borderCollapse: "collapse", width: "100%", minWidth: 620 }}>
          <thead>
            <tr>
              <th style={{ ...head, textAlign: "left" }}>Company</th>
              <th style={head}>Seats</th>
              <th style={head}>Clients</th>
              <th style={head}>Client logins</th>
              <th style={head}>Systems</th>
              <th style={head}>Machines</th>
              <th style={head}>Invited onto</th>
              <th style={{ ...head, textAlign: "left" }}>Since</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id} style={{ borderTop: "1px solid var(--line)" }}>
                <td style={{ ...cell, textAlign: "left", fontWeight: 700 }}>
                  {r.name}
                  {r.id === rootOrgId && (
                    <span className="pill" style={{ background: "#E7F2FA", color: "#1D6396", marginLeft: 6 }}>runs the platform</span>
                  )}
                </td>
                <td style={cell}>{r.staff}{r.owners > 0 && <span className="mut"> ({r.owners} owner{r.owners === 1 ? "" : "s"})</span>}</td>
                <td style={cell}>{r.clients}</td>
                <td style={cell}>{r.clientLogins}</td>
                <td style={cell}>
                  {r.live}{r.systems !== r.live && <span className="mut"> of {r.systems}</span>}
                </td>
                <td style={cell}>{r.machines}</td>
                <td style={cell}>{r.invitedOnto || <span className="mut">—</span>}</td>
                <td style={{ ...cell, textAlign: "left" }} className="mut">{r.since}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {rows.length === 0 && <div className="mut" style={{ fontSize: 12.5 }}>No workspaces yet.</div>}
    </div>
  );
}
