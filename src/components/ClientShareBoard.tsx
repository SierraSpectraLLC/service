"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { decideClientShare, withdrawClientShare } from "@/app/actions";
import { summarize, SHARE_LABEL, SHARE_LABEL_IN, type ShareState } from "@/lib/clientShare";
import { termsLine } from "@/lib/referral";
import { formatCents } from "@/lib/money";
import type { ShareRow } from "@/lib/clientShareData";
import Dialog, { DialogStatus } from "@/components/ui/Dialog";
import { Panel, Pill } from "@/components/ui";
import { toast } from "@/components/ui/Toast";

const TONE: Record<ShareState, "good" | "warn" | "bad" | "faint"> = {
  pending: "warn", accepted: "good", declined: "faint", withdrawn: "faint",
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

  const waiting = inbox.filter((s) => s.status === "pending");

  const decide = (id: number, accept: boolean, why = "") =>
    startTransition(async () => {
      const res = await decideClientShare(id, accept, why);
      if (res?.error) { setError(res.error); toast({ message: res.error }); return; }
      toast({
        message: accept
          ? "Accepted - the client is in your workspace now"
          : "Declined. Nothing was added.",
      });
      setDeclining(null); setReason("");
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

              {s.status === "pending" && (
                <div style={{ display: "flex", gap: 8, marginTop: 8, flexWrap: "wrap" }}>
                  <button className="btn accent" disabled={pending} onClick={() => decide(s.id, true)}>
                    {s.terms.kind === "none" ? "Accept" : "Accept and owe the fee"}
                  </button>
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
            <div key={s.id} className="row-2" style={{ alignItems: "baseline", padding: "7px 0", borderTop: "1px solid var(--line)" }}>
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
          ))}
        </Panel>
      )}

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
