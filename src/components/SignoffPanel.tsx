"use client";

import { useState, useTransition } from "react";
import { confirmReason } from "@/components/ui/ConfirmDialog";
import { signOffTarget, revokeSignoff, type WorkTarget } from "@/app/actions";
import type { Blocker } from "@/lib/signoff";

export type SignatureRow = {
  id: number; signedBy: string; signerName: string; signerTitle: string;
  meaning: string; note: string; when: string;
  /** The record moved after this was signed - the packet is no longer the one approved. */
  stale: boolean;
  snapshot: { tasksTotal: number; tasksDone: number; requiredTests: { title: string; reports: number }[] };
};

const MEANINGS = ["Approved for release", "Work verified", "Quality reviewed"];

/**
 * The signing half of the sign-off packet: what's blocking release, who has
 * already signed, and the act of signing. Screen-only - the printed sheet shows
 * the signatures themselves (see SignatureBlock).
 */
export default function SignoffPanel({ target, ready, blockers, signatures, canSign, isOwner, myEmail, myName }: {
  target: WorkTarget;
  ready: boolean;
  blockers: Blocker[];
  signatures: SignatureRow[];
  canSign: boolean;
  isOwner: boolean;
  myEmail: string;
  myName: string;
}) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState({ signerName: "", signerTitle: "", meaning: MEANINGS[0], note: "" });
  const [error, setError] = useState("");
  const [pending, startTransition] = useTransition();

  const alreadySigned = signatures.some((s) => s.signedBy.toLowerCase() === myEmail.toLowerCase());

  const sign = () => {
    if (draft.signerName.trim().length < 2) { setError("Type your full name to sign"); return; }
    setError("");
    startTransition(async () => {
      const res = await signOffTarget(target, draft);
      if (res?.error) setError(res.error);
      else { setOpen(false); setDraft({ ...draft, signerName: "", note: "" }); }
    });
  };

  return (
    <div className="card no-print">
      <div className="card-title" style={{ marginBottom: 8 }}>Release sign-off</div>

      {!ready && (
        <div style={{ fontSize: 12, background: "#FAF0DC", color: "var(--t-warn-fg)", border: "1px solid #F0C9A0", borderRadius: 8, padding: "8px 12px", marginBottom: 10 }}>
          <b>Not ready to sign.</b>
          <ul style={{ margin: "4px 0 0", paddingLeft: 18 }}>
            {blockers.map((b, i) => <li key={i}>{b.text}</li>)}
          </ul>
        </div>
      )}

      {signatures.map((s) => (
        <div key={s.id} style={{ borderTop: "1px solid var(--line)", padding: "8px 0" }}>
          <div style={{ display: "flex", alignItems: "baseline", gap: 8, flexWrap: "wrap" }}>
            <span style={{ fontSize: 14, fontWeight: 700, fontFamily: "Georgia, serif", color: "var(--navy)" }}>{s.signerName}</span>
            {s.signerTitle && <span className="mut" style={{ fontSize: 12 }}>{s.signerTitle}</span>}
            <span className="pill good">{s.meaning}</span>
            <span className="mut" style={{ fontSize: 11, marginLeft: "auto" }}>{s.when}</span>
          </div>
          <div className="mut mono" style={{ fontSize: 11 }}>{s.signedBy}</div>
          {s.note && <div style={{ fontSize: 12, marginTop: 2 }}>{s.note}</div>}
          <div className="mut" style={{ fontSize: 11, marginTop: 2 }}>
            At signing: {s.snapshot.tasksDone}/{s.snapshot.tasksTotal} tasks complete
            {s.snapshot.requiredTests.length > 0 && `, ${s.snapshot.requiredTests.length} mandatory test${s.snapshot.requiredTests.length === 1 ? "" : "s"} evidenced`}
          </div>
          {s.stale && (
            <div style={{ fontSize: 11, color: "var(--t-warn-fg)", marginTop: 3 }}>
              The record has changed since this was signed - the signature stands for the packet as it was that day.
            </div>
          )}
          {isOwner && (
            <button className="btn link" style={{ fontSize: 11, color: "var(--t-bad-fg)", padding: 0, marginTop: 3 }} disabled={pending}
              onClick={async () => {
                const why = await confirmReason({
                  title: `Withdraw ${s.signerName}'s sign-off?`,
                  body: "The withdrawal is kept in the record.",
                  action: "Withdraw", tone: "bad",
                });
                if (!why) return;
                startTransition(async () => {
                  const res = await revokeSignoff(s.id, why);
                  if (res?.error) setError(res.error);
                });
              }}>withdraw</button>
          )}
        </div>
      ))}
      {signatures.length === 0 && (
        <div className="mut" style={{ fontSize: 13 }}>Nobody has signed this off yet.</div>
      )}

      {canSign && !alreadySigned && (
        open ? (
          <div style={{ borderTop: "1px solid var(--line)", marginTop: 10, paddingTop: 10 }}>
            <div className="pf2" style={{ marginBottom: 8 }}>
              <div>
                <label>Your full name *</label>
                {/* Typing it is the signature: identity comes from the session,
                    intent comes from this box. */}
                <input value={draft.signerName} autoFocus placeholder={myName}
                  onChange={(e) => setDraft({ ...draft, signerName: e.target.value })} />
              </div>
              <div>
                <label>Title</label>
                <input value={draft.signerTitle} placeholder="e.g. Service Manager"
                  onChange={(e) => setDraft({ ...draft, signerTitle: e.target.value })} />
              </div>
            </div>
            <label>Meaning of signature</label>
            <div className="seg" role="group" aria-label="Meaning of signature" style={{ flexWrap: "wrap", marginBottom: 8 }}>
              {MEANINGS.map((m) => (
                <button key={m} type="button" aria-pressed={draft.meaning === m}
                  onClick={() => setDraft({ ...draft, meaning: m })}>{m}</button>
              ))}
            </div>
            <label>Note</label>
            <input value={draft.note} placeholder="Optional - anything the client should read alongside this"
              onChange={(e) => setDraft({ ...draft, note: e.target.value })} style={{ marginBottom: 8 }} />
            <div className="mut" style={{ fontSize: 11, marginBottom: 8 }}>
              Signing records your name, your account ({myEmail}), the time, and what was complete at that moment.
              It cannot be edited afterwards - only withdrawn, with a reason.
            </div>
            <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
              <button className="btn sm" onClick={() => setOpen(false)} disabled={pending}>Cancel</button>
              <button className="btn sm accent" onClick={sign} disabled={pending || draft.signerName.trim().length < 2}>
                {pending ? "Signing..." : "Sign off"}
              </button>
            </div>
          </div>
        ) : (
          <button className="btn sm accent" style={{ marginTop: 10 }} disabled={!ready}
            title={ready ? undefined : "Finish the outstanding work first"}
            onClick={() => { setDraft({ ...draft, signerName: "" }); setOpen(true); }}>
            Sign off{ready ? "" : " (blocked)"}
          </button>
        )
      )}
      {canSign && alreadySigned && (
        <div className="mut" style={{ fontSize: 12, marginTop: 8 }}>You have signed this.</div>
      )}
      {error && <div style={{ fontSize: 12, color: "var(--t-bad-fg)", marginTop: 8 }}>{error}</div>}
    </div>
  );
}
