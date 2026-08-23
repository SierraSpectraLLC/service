"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { approveQuote, askAboutQuote, declineQuote } from "@/app/actions";
import { formatCents } from "@/lib/money";
import { approvalConsequence, declineConsequence } from "@/lib/quotes";
import { Id } from "@/components/ui";

export type QuoteLine = {
  id: number; description: string; detail: string;
  qty: number; unitCents: number; covered: boolean; coveredBy: string;
};

/**
 * The quote, as the client reads it - and the three things they can do.
 *
 * Approve is a signature: they type their name, because a button somebody
 * tapped by accident is not agreement to spend four thousand dollars, and the
 * name is what goes on the record and into the job's discussion.
 *
 * Asking a question does NOT close the quote. A question is not a no, and
 * closing a sale because somebody wanted to know what a line meant is a sale
 * lost to a misunderstanding.
 */
export default function ClientQuote({
  token, quoteId, number, title, brandName, orgName, expiresOn, depositPct,
  lines, totalCents, onHold, standing, answeredBy, answeredOn, feeClause,
}: {
  token: string;
  quoteId: number;
  number: string;
  title: string;
  brandName: string;
  orgName: string;
  expiresOn: string;
  depositPct: number;
  lines: QuoteLine[];
  totalCents: number;
  onHold: boolean;
  standing: string;
  answeredBy: string;
  answeredOn: string;
  feeClause: string;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [mode, setMode] = useState<"" | "approve" | "decline" | "ask">("");
  const [name, setName] = useState("");
  const [text, setText] = useState("");
  const [error, setError] = useState("");
  const [done, setDone] = useState("");

  const answerable = standing === "awaiting";

  const run = (fn: () => Promise<{ error?: string }>, ok: string) => startTransition(async () => {
    setError("");
    const res = await fn();
    if (res.error) { setError(res.error); return; }
    setDone(ok);
    setMode("");
    setName(""); setText("");
    router.refresh();
  });

  return (
    <div className="card">
      <div className="eyebrow">{brandName} · for {orgName}</div>
      <h2 className="t-page" style={{ margin: "2px 0 2px" }}>Quote <Id>{number}</Id></h2>
      <div className="mut t-small" style={{ marginBottom: 10 }}>
        {title}
        {expiresOn ? ` · good until ${expiresOn}` : ""}
      </div>

      {lines.map((l) => (
        <div key={l.id} className="row-2" style={{ alignItems: "baseline", padding: "7px 0", borderTop: "1px solid var(--line)" }}>
          <span style={{ flex: 1, minWidth: 0 }}>
            <span className="t-body" style={{ fontWeight: 600 }}>{l.description}</span>
            {(l.detail || l.covered) && (
              <span className="mut t-meta" style={{ display: "block" }}>
                {l.detail}
                {l.covered && `${l.detail ? " · " : ""}covered by ${l.coveredBy || "your agreement"}`}
              </span>
            )}
          </span>
          <b className="t-body">
            {l.covered ? formatCents(0) : formatCents(Math.round(l.qty * l.unitCents))}
          </b>
        </div>
      ))}

      <div className="row-2" style={{ alignItems: "baseline", padding: "9px 0 0", borderTop: "2px solid var(--line)" }}>
        <span className="t-body" style={{ fontWeight: 700, flex: 1, minWidth: 0 }}>Total</span>
        <b className="t-page">{formatCents(totalCents)}</b>
      </div>

      {done && (
        <div className="t-body" style={{ marginTop: 12, padding: "8px 10px", borderRadius: 8, background: "var(--t-good-bg)", color: "var(--t-good-fg)" }}>
          {done}
        </div>
      )}

      {!answerable && !done && (
        <div className="mut t-body" style={{ marginTop: 12 }}>
          {standing === "approved" && `Approved${answeredBy ? ` by ${answeredBy}` : ""}${answeredOn ? ` on ${answeredOn}` : ""}. Thank you - we will be in touch about scheduling.`}
          {standing === "declined" && `Declined${answeredOn ? ` on ${answeredOn}` : ""}. Nothing has been scheduled or charged.`}
          {standing === "expired" && "This quote has expired. Ask us for a fresh one and we will re-price it."}
          {standing === "draft" && "This quote has not been sent yet."}
        </div>
      )}

      {answerable && !done && (
        <>
          <p className="t-body" style={{ marginTop: 14 }}>
            {approvalConsequence({ totalCents, depositPct, onHold, clientName: orgName })}
          </p>

          {mode === "" && (
            <div className="row-2" style={{ marginTop: 10 }}>
              <button className="btn sm accent" disabled={pending} onClick={() => setMode("approve")}>
                Approve {formatCents(totalCents)}
              </button>
              <button className="btn sm" disabled={pending} onClick={() => setMode("ask")}>
                Ask a question
              </button>
              <button className="btn sm" disabled={pending} onClick={() => setMode("decline")}>
                Decline
              </button>
            </div>
          )}

          {mode === "approve" && (
            <div style={{ marginTop: 10 }}>
              <div className="mut t-small" style={{ marginBottom: 6 }}>
                Type your name to sign. It goes on the record and into the job.
              </div>
              <div className="row-2">
                <input className="t-body" value={name} aria-label="Your name" placeholder="Your name"
                  style={{ flex: 1, minWidth: 160 }} onChange={(e) => setName(e.target.value)} />
                <button className="btn sm accent" disabled={pending || name.trim().length < 2}
                  onClick={() => run(() => approveQuote(token, quoteId, name), `Approved. ${depositPct > 0 ? "The deposit invoice is on its way." : "We will be in touch about scheduling."}`)}>
                  Approve {formatCents(totalCents)}
                </button>
                <button className="btn sm" disabled={pending} onClick={() => setMode("")}>Back</button>
              </div>
            </div>
          )}

          {mode === "ask" && (
            <div style={{ marginTop: 10 }}>
              <div className="mut t-small" style={{ marginBottom: 6 }}>
                It goes to the engineer on the job. The quote stays open while we answer.
              </div>
              <div className="row-2">
                <input className="t-body" value={name} aria-label="Your name" placeholder="Your name" style={{ width: 150 }}
                  onChange={(e) => setName(e.target.value)} />
                <input className="t-body" value={text} aria-label="Your question" placeholder="What would you like to know?"
                  style={{ flex: 1, minWidth: 180 }} onChange={(e) => setText(e.target.value)} />
                <button className="btn sm accent" disabled={pending || text.trim().length < 3}
                  onClick={() => run(() => askAboutQuote(token, quoteId, { by: name, question: text }), "Sent. We will come back to you.")}>
                  Send it
                </button>
                <button className="btn sm" disabled={pending} onClick={() => setMode("")}>Back</button>
              </div>
            </div>
          )}

          {mode === "decline" && (
            <div style={{ marginTop: 10 }}>
              <div className="mut t-small" style={{ marginBottom: 6 }}>{declineConsequence()}</div>
              <div className="row-2">
                <input className="t-body" value={name} aria-label="Your name" placeholder="Your name" style={{ width: 150 }}
                  onChange={(e) => setName(e.target.value)} />
                <input className="t-body" value={text} aria-label="Why" placeholder="Why, if you would like to say"
                  style={{ flex: 1, minWidth: 180 }} onChange={(e) => setText(e.target.value)} />
                <button className="btn sm" disabled={pending}
                  onClick={() => run(() => declineQuote(token, quoteId, { by: name, reason: text }), "Declined. Nothing has been scheduled.")}>
                  Decline
                </button>
                <button className="btn sm" disabled={pending} onClick={() => setMode("")}>Back</button>
              </div>
            </div>
          )}
        </>
      )}

      {error && <div className="t-small" style={{ color: "var(--t-bad-fg)", marginTop: 8 }}>{error}</div>}
      {feeClause && <div className="mut t-meta" style={{ marginTop: 12 }}>{feeClause}</div>}
    </div>
  );
}
