"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { decideDisputedClaim } from "@/app/actions";
import { confirmDialog } from "@/components/ui/ConfirmDialog";
import { toast } from "@/components/ui/Toast";
import { Panel } from "@/components/ui";

export type DisputedClaimRow = {
  id: number; instrumentId: number; externalId: string; claimant: string; requestedBy: string;
  message: string; disputeNote: string; evidenceAttachmentId: number | null; when: string;
};

/**
 * Claims somebody objected to. No automatic outcome: a person reads the
 * evidence and the objection and decides, and the decision is recorded with
 * both. Granting runs the same resolution silence would have - the holder's
 * bundle is frozen for them, the claimant's tenure opens.
 */
export default function DisputedClaimsPanel({ claims }: { claims: DisputedClaimRow[] }) {
  const [error, setError] = useState("");
  const [pending, startTransition] = useTransition();
  const decide = (c: DisputedClaimRow, grant: boolean) => async () => {
    const ok = await confirmDialog({
      title: grant ? `Grant ${c.claimant}'s claim on ${c.externalId}?` : `Deny ${c.claimant}'s claim on ${c.externalId}?`,
      body: grant
        ? <>Custody moves to {c.claimant}. The current holder&apos;s tenure closes as <b>claimed</b> and they keep a frozen bundle of it.</>
        : <>Nothing moves. The claim is recorded as denied with the objection beside it.</>,
      action: grant ? "Grant the claim" : "Deny the claim",
    });
    if (!ok) return;
    setError("");
    startTransition(async () => {
      const res = await decideDisputedClaim(c.id, grant);
      if (res?.error) setError(res.error); else toast({ message: grant ? "Claim granted" : "Claim denied" });
    });
  };
  return (
    <Panel title="Disputed custody claims" count={claims.length}
      hint="Somebody objected. Read the evidence and the objection; nothing here resolves on its own.">
      {claims.map((c) => (
        <div key={c.id} style={{ padding: "8px 0", borderTop: "1px solid var(--line)" }}>
          <div style={{ display: "flex", gap: 8, alignItems: "baseline", flexWrap: "wrap" }}>
            <Link href={`/instruments/${c.instrumentId}`} className="mono t-body" style={{ fontWeight: 700 }}>{c.externalId}</Link>
            <b className="t-body">{c.claimant}</b>
            <span className="mut t-small">{c.requestedBy} · {c.when}</span>
            {c.evidenceAttachmentId !== null
              ? <a className="btn sm" href={`/api/files/${c.evidenceAttachmentId}`} style={{ marginLeft: "auto", textDecoration: "none" }}>Evidence</a>
              : <span className="pill warn" style={{ marginLeft: "auto" }}>no evidence file</span>}
          </div>
          {c.message && <div className="t-small" style={{ whiteSpace: "pre-wrap", marginTop: 4 }}><b>Claim:</b> {c.message}</div>}
          <div className="t-small" style={{ whiteSpace: "pre-wrap", marginTop: 4 }}><b>Objection:</b> {c.disputeNote || <span className="mut">none written</span>}</div>
          <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
            <button className="btn sm primary" disabled={pending} onClick={decide(c, true)}>Grant</button>
            <button className="btn sm" disabled={pending} onClick={decide(c, false)}>Deny</button>
          </div>
        </div>
      ))}
      {error && <div className="t-small" style={{ color: "var(--t-bad-fg)", marginTop: 8 }}>{error}</div>}
    </Panel>
  );
}
