"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { approveQuote, askAboutQuote, declineQuote } from "@/app/actions";
import { formatCents } from "@/lib/money";
import { approvalConsequence, declineConsequence } from "@/lib/quotes";
import { descriptionLines } from "@/lib/billing";
import { Id } from "@/components/ui";

export type QuoteLine = {
  id: number; description: string; detail: string;
  qty: number; unitCents: number; covered: boolean; coveredBy: string;
  /** The number quoted, where there is one - what purchasing matches on. */
  partNumber?: string;
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
  greeting = "", attn = "", address = [], discount, comments = "", specs,
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
  /** The sentence at the top, naming them where the shop named somebody. */
  greeting?: string;
  attn?: string;
  /** Where it was addressed, as the lines it prints on. */
  address?: string[];
  /** What came off, when something did - see lib/quotes.discountOf. */
  discount?: { label: string; cents: number };
  /** The shop's own notes at the bottom. The client reads these before signing. */
  comments?: string;
  /** The shape of the offer, in the two columns the paper prints it in. */
  specs?: { left: { text: string; sub: boolean }[]; right: { text: string; sub: boolean }[] };
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

      {/* Who it was addressed to, and where it was sent. A client checking a
          quote against their own PO needs to see both, and the person named is
          who to ask about it. */}
      {(attn || address.length > 0) && (
        <div className="mut t-meta" style={{ marginBottom: 10 }}>
          {attn && <div>Attn: {attn}</div>}
          {address.map((l, i) => <div key={i}>{l}</div>)}
        </div>
      )}

      {greeting && (
        <div className="t-body" style={{ fontWeight: 600, marginBottom: 10 }}>{greeting}</div>
      )}

      {/* The specifics: what the offer covers, before a single price. It is the
          half of the document a client reads to decide whether the number at
          the bottom is the right number. */}
      {specs && (specs.left.length > 0 || specs.right.length > 0) && (
        <div className="pf2" style={{ marginBottom: 12 }}>
          {[specs.left, specs.right].map((col, i) => (
            <div key={i} className="t-body">
              {col.map((r, j) => (
                <div key={j} style={{ fontWeight: r.sub ? 400 : 700, paddingLeft: r.sub ? 12 : 0 }}>
                  {r.sub ? `- ${r.text}` : r.text}
                </div>
              ))}
            </div>
          ))}
        </div>
      )}

      {lines.map((l) => (
        <div key={l.id} className="row-2" style={{ alignItems: "baseline", padding: "7px 0", borderTop: "1px solid var(--line)" }}>
          <span style={{ flex: 1, minWidth: 0 }}>
            {/* The number, where the quote was built off one. A client's
                purchasing system matches on it, and a description alone gives
                them nothing to raise a PO against. */}
            {l.partNumber && (
              <span className="mono t-small" style={{ fontWeight: 700, color: "var(--navy)", marginRight: 8 }}>
                {l.partNumber}
              </span>
            )}
            <span className="t-body" style={{ fontWeight: 600 }}>{descriptionLines(l.description).head}</span>
            {/* What is inside the thing being charged for. One charge, several
                sentences - the modules a system covers, the parts in a kit. */}
            {descriptionLines(l.description).rest.map((r, i) => (
              <span key={i} className="mut t-meta"
                style={{ display: "block", paddingLeft: 12, fontStyle: "italic" }}>
                {r}
              </span>
            ))}
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

      {discount && discount.cents > 0 && (
        <>
          <div className="row-2" style={{ alignItems: "baseline", padding: "9px 0 0", borderTop: "2px solid var(--line)" }}>
            <span className="mut t-body" style={{ flex: 1, minWidth: 0 }}>Subtotal</span>
            <span className="mut t-body">{formatCents(totalCents + discount.cents)}</span>
          </div>
          <div className="row-2" style={{ alignItems: "baseline", padding: "3px 0 0" }}>
            <span className="t-body" style={{ flex: 1, minWidth: 0, color: "var(--t-good-fg)" }}>
              {discount.label}
            </span>
            <b className="t-body" style={{ color: "var(--t-good-fg)" }}>-{formatCents(discount.cents)}</b>
          </div>
        </>
      )}
      <div className="row-2" style={{
        alignItems: "baseline", padding: "9px 0 0",
        borderTop: discount && discount.cents > 0 ? "1px solid var(--line)" : "2px solid var(--line)",
      }}>
        <span className="t-body" style={{ fontWeight: 700, flex: 1, minWidth: 0 }}>Total</span>
        <b className="t-page">{formatCents(totalCents)}</b>
      </div>

      {/* The shop's own notes. Read BEFORE the approve button, because half of
          what is in them - what is included, what can be added later - is what
          the client is actually saying yes to. */}
      {comments.trim() && (
        <div style={{ marginTop: 12 }}>
          <div className="mut t-meta">Comments or special instructions</div>
          <div className="t-body" style={{ whiteSpace: "pre-wrap" }}>{comments}</div>
        </div>
      )}

      {done && (
        <div className="t-body" style={{ marginTop: 12, padding: "8px 10px", borderRadius: 8, background: "var(--t-good-bg)", color: "var(--t-good-fg)" }}>
          {done}
        </div>
      )}

      {!answerable && !done && (
        <div className="mut t-body" style={{ marginTop: 12 }}>
          {standing === "approved" && `Approved${answeredBy ? ` by ${answeredBy}` : ""}${answeredOn ? ` on ${answeredOn}` : ""}.`}
          {standing === "declined" && `Declined${answeredOn ? ` on ${answeredOn}` : ""}.`}
          {standing === "expired" && "This quote has expired."}
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
              <div className="mut t-small" style={{ marginBottom: 6 }}>Type your name to sign.</div>
              <div className="row-2">
                <input className="t-body" value={name} aria-label="Your name" placeholder="Your name"
                  style={{ flex: 1, minWidth: 160 }} onChange={(e) => setName(e.target.value)} />
                <button className="btn sm accent" disabled={pending || name.trim().length < 2}
                  onClick={() => run(() => approveQuote(token, quoteId, name), `Approved.${depositPct > 0 ? " The deposit invoice is on its way." : ""}`)}>
                  Approve {formatCents(totalCents)}
                </button>
                <button className="btn sm" disabled={pending} onClick={() => setMode("")}>Back</button>
              </div>
            </div>
          )}

          {mode === "ask" && (
            <div style={{ marginTop: 10 }}>
              <div className="mut t-small" style={{ marginBottom: 6 }}>The quote stays open while we answer.</div>
              <div className="row-2">
                <input className="t-body" value={name} aria-label="Your name" placeholder="Your name" style={{ width: 150 }}
                  onChange={(e) => setName(e.target.value)} />
                <input className="t-body" value={text} aria-label="Your question" placeholder="What would you like to know?"
                  style={{ flex: 1, minWidth: 180 }} onChange={(e) => setText(e.target.value)} />
                <button className="btn sm accent" disabled={pending || text.trim().length < 3}
                  onClick={() => run(() => askAboutQuote(token, quoteId, { by: name, question: text }), "Sent.")}>
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
                  onClick={() => run(() => declineQuote(token, quoteId, { by: name, reason: text }), "Declined.")}>
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
