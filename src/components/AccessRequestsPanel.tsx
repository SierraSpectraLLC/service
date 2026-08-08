"use client";

import { useState, useTransition } from "react";
import { approveAccessRequest, denyAccessRequest } from "@/app/actions";

export type AccessRequestRow = {
  id: number; orgName: string; orgKind: string; requestedBy: string; message: string; when: string;
};

/**
 * Someone matched this system by serial number and is asking in. Shown only
 * to the people who can decide: staff and the owning organization's editors.
 */
export default function AccessRequestsPanel({ requests }: { requests: AccessRequestRow[] }) {
  const [error, setError] = useState("");
  const [pending, startTransition] = useTransition();
  if (!requests.length) return null;

  return (
    <>
      <div className="eyebrow" style={{ marginTop: 14, marginBottom: 6 }}>Access requests</div>
      {requests.map((r) => (
        <div key={r.id} style={{ border: "1px solid #EAD9B0", background: "#FDF8EE", borderRadius: 8, padding: "8px 12px", marginBottom: 6 }}>
          <div style={{ display: "flex", gap: 8, alignItems: "baseline", flexWrap: "wrap" }}>
            <b style={{ fontSize: 13 }}>{r.orgName}</b>
            {r.orgKind === "provider" && <span className="pill" style={{ background: "#FAF0DC", color: "#8A5410" }}>provider</span>}
            <span className="mut" style={{ fontSize: 12 }}>{r.requestedBy} · {r.when}</span>
          </div>
          {r.message && <div className="mut" style={{ fontSize: 12, whiteSpace: "pre-wrap", marginTop: 2 }}>{r.message}</div>}
          <div style={{ display: "flex", gap: 6, marginTop: 6, alignItems: "center" }}>
            <button className="btn sm accent" disabled={pending}
              onClick={() => startTransition(async () => {
                const res = await approveAccessRequest(r.id, "view");
                if (res?.error) setError(res.error);
              })}>Allow viewing</button>
            <button className="btn sm" disabled={pending}
              onClick={() => startTransition(async () => {
                const res = await approveAccessRequest(r.id, "edit");
                if (res?.error) setError(res.error);
              })}>Allow editing</button>
            <button className="btn link" style={{ color: "#A32D2D" }} disabled={pending}
              onClick={() => startTransition(async () => {
                const res = await denyAccessRequest(r.id);
                if (res?.error) setError(res.error);
              })}>Deny</button>
          </div>
        </div>
      ))}
      {error && <div style={{ fontSize: 12, color: "#A32D2D", marginBottom: 6 }}>{error}</div>}
    </>
  );
}
