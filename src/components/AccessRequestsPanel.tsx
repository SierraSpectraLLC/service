"use client";

import { useState, useTransition } from "react";
import { approveAccessRequest, approveClaim, denyAccessRequest } from "@/app/actions";

export type AccessRequestRow = {
  id: number; orgName: string; orgKind: string; kind: string;
  requestedBy: string; message: string; when: string;
};

/**
 * Someone matched this system by serial number and is asking in. Shown only to
 * the people who can decide: the operator, and for plain access requests the
 * owning organization's editors. A claim asserts ownership, so only the
 * operator sees a grant button for it.
 */
export default function AccessRequestsPanel({ requests, isOperator }: {
  requests: AccessRequestRow[]; isOperator: boolean;
}) {
  const [error, setError] = useState("");
  const [pending, startTransition] = useTransition();
  if (!requests.length) return null;

  return (
    <>
      <div className="eyebrow" style={{ marginTop: 14, marginBottom: 6 }}>Access requests</div>
      {requests.map((r) => {
        const isClaim = r.kind === "claim";
        return (
          <div key={r.id} style={{ border: `1px solid ${isClaim ? "#D9BFA6" : "#EAD9B0"}`, background: isClaim ? "#FBF1E8" : "#FDF8EE", borderRadius: 8, padding: "8px 12px", marginBottom: 6 }}>
            <div style={{ display: "flex", gap: 8, alignItems: "baseline", flexWrap: "wrap" }}>
              <b style={{ fontSize: 13 }}>{r.orgName}</b>
              {isClaim
                ? <span className="pill" style={{ background: "#F2E0CC", color: "#8A5410" }}>claims ownership</span>
                : r.orgKind === "provider" && <span className="pill" style={{ background: "#FAF0DC", color: "#8A5410" }}>provider</span>}
              <span className="mut" style={{ fontSize: 12 }}>{r.requestedBy} · {r.when}</span>
            </div>
            {r.message && <div className="mut" style={{ fontSize: 12, whiteSpace: "pre-wrap", marginTop: 2 }}>{r.message}</div>}
            {isClaim && !isOperator && (
              <div className="mut" style={{ fontSize: 11, marginTop: 4 }}>
                Ownership claims are decided by the platform operator.
              </div>
            )}
            <div style={{ display: "flex", gap: 6, marginTop: 6, alignItems: "center", flexWrap: "wrap" }}>
              {isClaim && isOperator && (
                <button className="btn sm accent" disabled={pending}
                  onClick={() => {
                    if (!window.confirm(`Make ${r.orgName} the owner of this system? They get edit access and the right to decide who else gets on it.`)) return;
                    startTransition(async () => {
                      const res = await approveClaim(r.id);
                      if (res?.error) setError(res.error);
                    });
                  }}>Grant ownership</button>
              )}
              {(!isClaim || isOperator) && (
                <>
                  <button className={`btn sm${isClaim ? "" : " accent"}`} disabled={pending}
                    onClick={() => startTransition(async () => {
                      const res = await approveAccessRequest(r.id, "view");
                      if (res?.error) setError(res.error);
                    })}>{isClaim ? "Access only (view)" : "Allow viewing"}</button>
                  <button className="btn sm" disabled={pending}
                    onClick={() => startTransition(async () => {
                      const res = await approveAccessRequest(r.id, "edit");
                      if (res?.error) setError(res.error);
                    })}>{isClaim ? "Access only (edit)" : "Allow editing"}</button>
                  <button className="btn link" style={{ color: "#A32D2D" }} disabled={pending}
                    onClick={() => startTransition(async () => {
                      const res = await denyAccessRequest(r.id);
                      if (res?.error) setError(res.error);
                    })}>Deny</button>
                </>
              )}
            </div>
          </div>
        );
      })}
      {error && <div style={{ fontSize: 12, color: "#A32D2D", marginBottom: 6 }}>{error}</div>}
    </>
  );
}
