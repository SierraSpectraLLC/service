"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { shareClient } from "@/app/actions";
import { FEE_KINDS, FEE_LABEL, termsLine, termsProblems, type FeeKind } from "@/lib/referral";
import { formatCents, parseMoney } from "@/lib/money";
import { Panel } from "@/components/ui";
import { toast } from "@/components/ui/Toast";

/**
 * Hand this client to another service company.
 *
 * The sibling of the fleet brief above it, and deliberately a different act:
 * a brief is a page somebody READS, this puts the client into their workspace
 * to WORK. So it names what would be copied, says plainly what would not, and
 * says that they have to accept - all before the button, because the thing
 * people get wrong about this feature is assuming it already happened.
 */
export default function ShareClientButton({ orgId, orgName, systems, providers }: {
  orgId: number;
  orgName: string;
  systems: number;
  providers: { id: number; name: string }[];
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [picked, setPicked] = useState<number[]>([]);
  const [note, setNote] = useState("");
  const [error, setError] = useState("");
  const [fee, setFee] = useState({ kind: "none" as FeeKind, flat: "", pct: "5", months: "12", note: "" });

  const terms = {
    kind: fee.kind,
    feeCents: parseMoney(fee.flat) ?? 0,
    feeBps: Math.round((parseFloat(fee.pct) || 0) * 100),
    windowMonths: parseInt(fee.months, 10) || 0,
    note: fee.note,
  };
  const feeProblem = termsProblems(terms)[0] ?? null;

  const toggle = (id: number) =>
    setPicked(picked.includes(id) ? picked.filter((x) => x !== id) : [...picked, id]);

  const send = () =>
    startTransition(async () => {
      setError("");
      const res = await shareClient(orgId, { toOrgIds: picked, note, terms });
      if (res.error) { setError(res.error); return; }
      toast({ message: `Offered to ${res.sent} ${res.sent === 1 ? "company" : "companies"} - waiting on them` });
      setPicked([]); setNote("");
      router.push("/network");
    });

  return (
    <Panel
      title="Hand this client over"
      hint="A copy lands in their workspace once they accept. Different from sharing the fleet above, which is only a page they read."
    >
      {providers.length === 0 ? (
        <div className="mut t-small">
          No service companies on your list yet. Find them in{" "}
          <a href="/network">Service companies</a> first.
        </div>
      ) : (
        <>
          <div className="mut t-small" style={{ marginBottom: 8 }}>
            {orgName} and its {systems} system{systems === 1 ? "" : "s"} - names, sites, models and
            serials. <b>Not</b> your contracts, rates, invoices, notes or work history.
          </div>
          {providers.map((p) => (
            <label key={p.id} className="t-body"
              style={{ display: "flex", gap: 8, alignItems: "center", padding: "5px 0", borderTop: "1px solid var(--line)" }}>
              <input type="checkbox" className="check" checked={picked.includes(p.id)}
                disabled={pending} onChange={() => toggle(p.id)} />
              {p.name}
            </label>
          ))}

          <label style={{ marginTop: 10 }}>A line for them</label>
          <input value={note} aria-label="Note to them" disabled={pending}
            placeholder="you take the Alameda site, we keep Hayward"
            onChange={(e) => setNote(e.target.value)} />

          {/* The price goes ON the offer. A fee discovered after somebody has
              taken on a client is not a price, it is a bill - so they see what
              accepting costs before they accept, and accepting is the
              agreement. See lib/referral. */}
          <div className="dialog-section" style={{ marginTop: 12 }}>What you are asking for</div>
          <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "flex-end" }}>
            <label style={{ display: "block" }}>
              <span className="mut t-meta" style={{ display: "block" }}>Fee</span>
              <select value={fee.kind} aria-label="Fee" disabled={pending} style={{ width: "auto" }}
                onChange={(e) => setFee({ ...fee, kind: e.target.value as FeeKind })}>
                {FEE_KINDS.map((k) => <option key={k} value={k}>{FEE_LABEL[k]}</option>)}
              </select>
            </label>
            {(fee.kind === "flat" || fee.kind === "either") && (
              <label style={{ display: "block" }}>
                <span className="mut t-meta" style={{ display: "block" }}>To accept</span>
                <input className="mono t-small" style={{ width: 100 }} value={fee.flat}
                  aria-label="Fee to accept" placeholder="2000" disabled={pending}
                  onChange={(e) => setFee({ ...fee, flat: e.target.value })} />
              </label>
            )}
            {(fee.kind === "percent" || fee.kind === "either") && (
              <>
                <label style={{ display: "block" }}>
                  <span className="mut t-meta" style={{ display: "block" }}>Share, %</span>
                  <input className="mono t-small" style={{ width: 64 }} value={fee.pct}
                    aria-label="Share percent" disabled={pending}
                    onChange={(e) => setFee({ ...fee, pct: e.target.value })} />
                </label>
                <label style={{ display: "block" }}>
                  <span className="mut t-meta" style={{ display: "block" }}>For, months</span>
                  <input className="mono t-small" style={{ width: 64 }} value={fee.months}
                    aria-label="Window months" disabled={pending}
                    onChange={(e) => setFee({ ...fee, months: e.target.value })} />
                </label>
              </>
            )}
          </div>
          {fee.kind !== "none" && (
            <>
              <label style={{ marginTop: 8 }}>What the fee is for</label>
              <input value={fee.note} aria-label="Fee note" disabled={pending}
                placeholder="introduction and handover of the account"
                onChange={(e) => setFee({ ...fee, note: e.target.value })} />
              <div className="t-small" style={{ marginTop: 6 }}>
                They will see: <b>{termsLine(terms, formatCents)}</b>
              </div>
              {fee.kind !== "flat" && (
                <div className="mut t-meta" style={{ marginTop: 2 }}>
                  Worked out from what they invoice this client in Ridgeline. You see the total
                  and what it comes to - never their invoices.
                </div>
              )}
            </>
          )}

          <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", marginTop: 12 }}>
            <button className="btn accent"
              disabled={pending || picked.length === 0 || systems === 0 || !!feeProblem}
              onClick={send}>
              {pending ? "Offering..." : `Offer to ${picked.length || "..."}`}
            </button>
            {(error || feeProblem) && (
              <span className="t-small" style={{ color: "var(--t-bad-fg)" }}>{error || feeProblem}</span>
            )}
          </div>
          <div className="mut t-meta" style={{ marginTop: 8 }}>
            Nothing is written into their workspace until somebody there accepts. The copy is a
            snapshot taken now - it does not update afterwards, and neither does theirs.
          </div>
        </>
      )}
    </Panel>
  );
}
