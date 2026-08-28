"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import {
  answerCounterOffer, counterClientShare, decideClientShare, withdrawClientShare,
} from "@/app/actions";
import { summarize, SHARE_LABEL, SHARE_LABEL_IN, type ShareState } from "@/lib/clientShare";
import {
  boundsPhrase, choicesFor, FEE_KINDS, FEE_LABEL, termsLine, termsProblems, type FeeKind,
} from "@/lib/referral";
import { parseMoney } from "@/lib/money";
import { formatCents } from "@/lib/money";
import type { ShareRow } from "@/lib/clientShareData";
import Dialog, { DialogStatus } from "@/components/ui/Dialog";
import { Panel, Pill } from "@/components/ui";
import { toast } from "@/components/ui/Toast";

const TONE: Record<ShareState, "good" | "warn" | "bad" | "faint"> = {
  pending: "warn", countered: "warn", accepted: "good", declined: "faint", withdrawn: "faint",
};

/**
 * Clients moving between shops.
 *
 * The incoming half leads, because it is the half with a decision in it, and
 * the decision is not small: accepting writes a client, its buildings and every
 * one of its machines into this workspace. So the row says exactly what would
 * arrive before anybody presses anything, and the panel says out loud that
 * nothing has been written yet - "a client was shared with you" reads like it
 * already happened.
 */
export default function ClientShareBoard({ inbox, sent }: {
  inbox: ShareRow[]; sent: ShareRow[];
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [declining, setDeclining] = useState<number | null>(null);
  const [reason, setReason] = useState("");
  const [error, setError] = useState("");
  const [open, setOpen] = useState<number | null>(null);
  /** Which side of an either/or offer the recipient is taking. */
  const [choice, setChoice] = useState<Record<number, string>>({});
  const [countering, setCountering] = useState<number | null>(null);
  const [ct, setCt] = useState({
    kind: "flat" as FeeKind, flat: "", pct: "3", months: "12", min: "", max: "", note: "",
  });

  const waiting = inbox.filter((s) => s.status === "pending");

  const decide = (id: number, accept: boolean, why = "") =>
    startTransition(async () => {
      const res = await decideClientShare(id, accept, why, choice[id] ?? "");
      if (res?.error) { setError(res.error); toast({ message: res.error }); return; }
      toast({
        message: accept
          ? "Accepted - the client is in your workspace now"
          : "Declined. Nothing was added.",
      });
      setDeclining(null); setReason("");
      router.refresh();
    });

  const run = (fn: () => Promise<{ error?: string } | void>, ok: string) =>
    startTransition(async () => {
      setError("");
      const res = await fn();
      if (res?.error) { setError(res.error); toast({ message: res.error }); return; }
      toast({ message: ok });
      setCountering(null);
      router.refresh();
    });

  const pull = (id: number) =>
    startTransition(async () => {
      const res = await withdrawClientShare(id);
      if (res?.error) { toast({ message: res.error }); return; }
      toast({ message: "Withdrawn" });
      router.refresh();
    });

  return (
    <>
      {inbox.length > 0 && (
        <Panel
          title="Shared with you"
          count={waiting.length || undefined}
          hint="Nothing is added to your workspace unless you accept."
        >
          {inbox.map((s) => (
            <div key={s.id} style={{ padding: "10px 0", borderTop: "1px solid var(--line)" }}>
              <div className="row-2" style={{ alignItems: "baseline" }}>
                <span className="t-body" style={{ fontWeight: 600, flex: 1, minWidth: 0 }}>
                  {s.payload?.client.name ?? "A client"}
                  <span className="mut t-meta"> from {s.otherName}</span>
                </span>
                <Pill tone={TONE[s.status as ShareState] ?? "faint"}>
                  {SHARE_LABEL_IN[s.status as ShareState] ?? s.status}
                </Pill>
              </div>
              <div className="mut t-small">
                {s.payload ? summarize(s.payload) : "contents unreadable"}
                {` · offered ${s.createdOn} by ${s.createdBy}`}
              </div>
              {s.note && <div className="t-small" style={{ marginTop: 2 }}>{s.note}</div>}

              {/* The price, before the button and not after it. A fee somebody
                  finds out about once they have taken on a client is a bill,
                  not a price - see lib/referral. */}
              {s.terms.kind !== "none" && (
                <div className="t-small" style={{ marginTop: 4, color: "var(--t-warn-fg)" }}>
                  Accepting costs: <b>{termsLine(s.terms, formatCents)}</b>
                </div>
              )}

              {/* An either/or offer is two different RISKS, not a discount -
                  certainty against pay-as-you-earn - so the choice is made
                  here, before accepting, and lands on the fee. */}
              {s.status === "pending" && s.terms.kind === "either" && (
                <div style={{ display: "flex", gap: 12, marginTop: 6, flexWrap: "wrap" }}>
                  {choicesFor(s.terms.kind).map((k) => (
                    <label key={k} className="t-small" style={{ display: "flex", gap: 5, alignItems: "center" }}>
                      <input type="radio" className="check" name={`choice-${s.id}`}
                        checked={(choice[s.id] ?? "percent") === k}
                        onChange={() => setChoice({ ...choice, [s.id]: k })} />
                      {k === "flat"
                        ? `Pay ${formatCents(s.terms.feeCents)} now`
                        : `Pay ${(s.terms.feeBps / 100).toFixed(s.terms.feeBps % 100 === 0 ? 0 : 1)}% as you bill`}
                    </label>
                  ))}
                </div>
              )}

              {s.counter && (
                <div className="t-small" style={{ marginTop: 4 }}>
                  {s.status === "countered" ? "You countered: " : "Countered: "}
                  <b>{termsLine(s.counter, formatCents)}</b>
                  {s.counteredBy ? <span className="mut t-meta"> · {s.counteredBy}</span> : null}
                </div>
              )}

              {s.status === "pending" && (
                <div style={{ display: "flex", gap: 8, marginTop: 8, flexWrap: "wrap" }}>
                  <button className="btn accent" disabled={pending} onClick={() => decide(s.id, true)}>
                    {s.terms.kind === "none" ? "Accept" : "Accept and owe the fee"}
                  </button>
                  {s.terms.kind !== "none" && (
                    <button className="btn" disabled={pending}
                      onClick={() => {
                        setError("");
                        setCt({ kind: "flat", flat: "", pct: "3", months: "12", min: "", max: "", note: "" });
                        setCountering(s.id);
                      }}>
                      Counter
                    </button>
                  )}
                  <button className="btn" disabled={pending}
                    onClick={() => { setError(""); setReason(""); setDeclining(s.id); }}>
                    Decline
                  </button>
                  <button className="btn link" style={{ fontSize: 12 }}
                    onClick={() => setOpen(open === s.id ? null : s.id)}>
                    {open === s.id ? "hide what would arrive" : "what would arrive"}
                  </button>
                </div>
              )}
              {s.status === "accepted" && s.destOrgId && (
                <Link className="btn sm" style={{ marginTop: 8, textDecoration: "none" }}
                  href={`/settings/organizations/${s.destOrgId}`}>
                  Open it
                </Link>
              )}

              {/* The whole list, before anybody decides. A person taking on a
                  twelve-machine client should be able to read the twelve. */}
              {open === s.id && s.payload && (
                <div className="mut t-small" style={{ marginTop: 8, paddingLeft: 10, borderLeft: "2px solid var(--line)" }}>
                  {s.payload.sites.map((site) => (
                    <div key={site.name}>{site.name}{site.address ? ` - ${site.address}` : ""}</div>
                  ))}
                  {s.payload.systems.map((x) => (
                    <div key={x.sourceRef} style={{ marginTop: 4 }}>
                      <b>{x.sourceRef}</b> {x.model}
                      {x.siteName ? ` · ${x.siteName}` : ""}
                      {x.modules.map((m) => (
                        <div key={`${m.kind}${m.serial}`} style={{ paddingLeft: 10 }}>
                          {[m.kind, [m.manufacturer, m.model].filter(Boolean).join(" "), m.serial && `SN ${m.serial}`]
                            .filter(Boolean).join(" · ")}
                        </div>
                      ))}
                    </div>
                  ))}
                </div>
              )}
            </div>
          ))}
        </Panel>
      )}

      {sent.length > 0 && (
        <Panel title="Clients you have shared" count={sent.filter((s) => s.status === "pending").length || undefined}>
          {sent.map((s) => (
            <div key={s.id} style={{ padding: "8px 0", borderTop: "1px solid var(--line)" }}>
              <div className="row-2" style={{ alignItems: "baseline" }}>
                <span className="t-body" style={{ flex: 1, minWidth: 0 }}>
                  {s.payload?.client.name ?? "A client"}
                  <span className="mut t-meta"> to {s.otherName} · {s.createdOn}</span>
                  {s.terms.kind !== "none" && (
                    <span className="mut t-meta"> · {termsLine(s.terms, formatCents)}</span>
                  )}
                </span>
                <Pill tone={TONE[s.status as ShareState] ?? "faint"}>
                  {SHARE_LABEL[s.status as ShareState] ?? s.status}
                </Pill>
                {s.status === "pending" && (
                  <button className="btn link" style={{ fontSize: 12 }} disabled={pending}
                    onClick={() => pull(s.id)}>withdraw</button>
                )}
              </div>

              {/* A counter is their YES at a different number, so agreeing to
                  it completes the deal here and the client copies across -
                  there is no second round trip asking whether they meant it. */}
              {s.status === "countered" && s.counter && (
                <>
                  <div className="t-small" style={{ marginTop: 4, color: "var(--t-warn-fg)" }}>
                    They will take it at <b>{termsLine(s.counter, formatCents)}</b>
                    {s.counteredBy ? <span className="mut t-meta"> · {s.counteredBy}</span> : null}
                  </div>
                  <div style={{ display: "flex", gap: 8, marginTop: 6, flexWrap: "wrap" }}>
                    <button className="btn accent" disabled={pending}
                      onClick={() => run(() => answerCounterOffer(s.id, true), "Agreed - the client is theirs now")}>
                      Agree and hand it over
                    </button>
                    <button className="btn" disabled={pending}
                      onClick={() => run(() => answerCounterOffer(s.id, false), "Turned down - your original offer stands")}>
                      No, my offer stands
                    </button>
                    <button className="btn link" style={{ fontSize: 12 }} disabled={pending}
                      onClick={() => pull(s.id)}>withdraw it</button>
                  </div>
                </>
              )}
            </div>
          ))}
        </Panel>
      )}

      {countering !== null && (() => {
        const terms = {
          kind: ct.kind,
          feeCents: parseMoney(ct.flat) ?? 0,
          feeBps: Math.round((parseFloat(ct.pct) || 0) * 100),
          windowMonths: parseInt(ct.months, 10) || 0,
          minCents: parseMoney(ct.min) ?? 0,
          maxCents: parseMoney(ct.max) ?? 0,
          note: ct.note,
        };
        const problem = termsProblems(terms)[0] ?? null;
        return (
          <Dialog open onClose={() => setCountering(null)} size="sm"
            title="Counter their price"
            context="This is a yes at a different number - if they agree, the client comes across then and there."
            footer={
              <>
                <DialogStatus error={error} problem={problem} ok="Ready to send." />
                <button className="btn" onClick={() => setCountering(null)} disabled={pending}>Cancel</button>
                <button className="btn accent" disabled={pending || !!problem}
                  onClick={() => run(
                    () => counterClientShare(countering, { terms, note: ct.note }),
                    "Countered - waiting on them")}>
                  Send the counter
                </button>
              </>
            }>
            <label>What you would pay instead</label>
            <select value={ct.kind} aria-label="Counter fee" disabled={pending}
              onChange={(e) => setCt({ ...ct, kind: e.target.value as FeeKind })}>
              {FEE_KINDS.filter((k) => k !== "either").map((k) => (
                <option key={k} value={k}>{FEE_LABEL[k]}</option>
              ))}
            </select>
            <div className="pf2" style={{ marginTop: 8 }}>
              {ct.kind === "flat" && (
                <div>
                  <label>To accept</label>
                  <input className="mono t-small" value={ct.flat} aria-label="Counter amount"
                    placeholder="1500" disabled={pending}
                    onChange={(e) => setCt({ ...ct, flat: e.target.value })} />
                </div>
              )}
              {ct.kind === "percent" && (
                <>
                  <div>
                    <label>Share, %</label>
                    <input className="mono t-small" value={ct.pct} aria-label="Counter percent"
                      disabled={pending} onChange={(e) => setCt({ ...ct, pct: e.target.value })} />
                  </div>
                  <div>
                    <label>For, months</label>
                    <input className="mono t-small" value={ct.months} aria-label="Counter months"
                      disabled={pending} onChange={(e) => setCt({ ...ct, months: e.target.value })} />
                  </div>
                  <div>
                    <label>Floor</label>
                    <input className="mono t-small" value={ct.min} aria-label="Counter floor"
                      placeholder="none" disabled={pending}
                      onChange={(e) => setCt({ ...ct, min: e.target.value })} />
                  </div>
                  <div>
                    <label>Cap</label>
                    <input className="mono t-small" value={ct.max} aria-label="Counter cap"
                      placeholder="none" disabled={pending}
                      onChange={(e) => setCt({ ...ct, max: e.target.value })} />
                  </div>
                </>
              )}
            </div>
            <label style={{ marginTop: 8 }}>Why</label>
            <input value={ct.note} aria-label="Counter note" disabled={pending}
              placeholder="the Alameda site is a four-hour drive for us"
              onChange={(e) => setCt({ ...ct, note: e.target.value })} />
            <div className="field-hint">
              They see this. If they say no, their original offer is still on the table.
            </div>
          </Dialog>
        );
      })()}

      {declining !== null && (
        <Dialog open onClose={() => setDeclining(null)} size="sm"
          title="Not taking this on"
          context="Nothing is written into your workspace. They are told you declined."
          footer={
            <>
              <DialogStatus error={error} problem={null} />
              <button className="btn" onClick={() => setDeclining(null)} disabled={pending}>Cancel</button>
              <button className="btn accent" disabled={pending}
                onClick={() => decide(declining, false, reason)}>
                {pending ? "Recording..." : "Decline"}
              </button>
            </>
          }>
          <label>A reason, if you want to give one</label>
          <input value={reason} aria-label="Reason" autoFocus
            placeholder="no coverage in that area"
            onChange={(e) => setReason(e.target.value)} />
        </Dialog>
      )}
    </>
  );
}
