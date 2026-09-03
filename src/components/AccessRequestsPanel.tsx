"use client";

import { useState, useTransition } from "react";
import { approveAccessRequest, approveClaim, denyAccessRequest, disputeClaim } from "@/app/actions";
import { confirmDialog } from "@/components/ui/ConfirmDialog";
import { toast } from "@/components/ui/Toast";

export type AccessRequestRow = {
  id: number; orgName: string; orgKind: string; kind: string;
  requestedBy: string; message: string; when: string;
  /** custody.claims: the notice window, and where the claim stands. */
  claim?: { noticeEndsOn: string; state: "window" | "due" | "disputed" | "resolved"; canObject: boolean };
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
              <b className="t-body">{r.orgName}</b>
              {isClaim
                ? <span className="pill warn">claims ownership</span>
                : r.orgKind === "provider" && <span className="pill warn">provider</span>}
              <span className="mut t-small">{r.requestedBy} · {r.when}</span>
            </div>
            {r.message && <div className="mut t-small" style={{ whiteSpace: "pre-wrap", marginTop: 2 }}>{r.message}</div>}
            {/* A claim with a window is a notice, not a request: silence
                resolves it. Saying so, with the date, is the whole point of
                the notice; the object button is for the people it names. */}
            {isClaim && r.claim && (
              <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", marginTop: 4 }}>
                <span className={`pill ${r.claim.state === "disputed" ? "bad" : r.claim.state === "due" ? "warn" : "neutral"}`}>
                  {r.claim.state === "window" ? `window closes ${r.claim.noticeEndsOn}`
                    : r.claim.state === "due" ? "window closed - resolving"
                    : r.claim.state === "disputed" ? "objected - with the platform" : "resolved"}
                </span>
                {r.claim.state === "window" && r.claim.canObject && (
                  <button className="btn sm" disabled={pending} onClick={async () => {
                    const why = window.prompt("Why is this claim wrong? The platform reads this.");
                    if (!why?.trim()) return;
                    setError("");
                    startTransition(async () => {
                      const res = await disputeClaim(r.id, why);
                      if (res?.error) setError(res.error); else toast({ message: "Objection filed - the claim is parked for the platform" });
                    });
                  }}>Object</button>
                )}
              </div>
            )}
            {isClaim && !isOperator && (
              <div className="mut t-meta" style={{ marginTop: 4 }}>
                Ownership claims are decided by the platform operator.
              </div>
            )}
            <div style={{ display: "flex", gap: 6, marginTop: 6, alignItems: "center", flexWrap: "wrap" }}>
              {isClaim && isOperator && (
                <button className="btn sm accent" disabled={pending}
                  onClick={async () => {
                    if (!(await confirmDialog({
                      title: `Make ${r.orgName} the owner of this system?`,
                      body: "They get edit access and the right to decide who else gets on it.",
                      action: `Make ${r.orgName} owner`,
                    }))) return;
                    startTransition(async () => {
                      const res = await approveClaim(r.id);
                      if (res?.error) setError(res.error);
                      else toast({ message: `Made ${r.orgName} the owner` });
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
                  <button className="btn link" style={{ color: "var(--t-bad-fg)" }} disabled={pending}
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
      {error && <div className="t-small" style={{ color: "var(--t-bad-fg)", marginBottom: 6 }}>{error}</div>}
    </>
  );
}
