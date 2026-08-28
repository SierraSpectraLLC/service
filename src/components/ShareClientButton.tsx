"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { shareClient } from "@/app/actions";
import { MIN_IDENTIFYING } from "@/lib/clientShare";
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
  // The client's own name is the leak that actually happens. The server does
  // the full check against every site, contact and serial in the payload.
  const noteNames = orgName.trim().length >= MIN_IDENTIFYING
    && note.toLowerCase().includes(orgName.trim().toLowerCase());
  const [error, setError] = useState("");
  const [blind, setBlind] = useState(true);
  const [fee, setFee] = useState({
    kind: "none" as FeeKind, flat: "", pct: "5", months: "12", min: "", max: "", note: "",
  });

  const terms = {
    kind: fee.kind,
    feeCents: parseMoney(fee.flat) ?? 0,
    feeBps: Math.round((parseFloat(fee.pct) || 0) * 100),
    windowMonths: parseInt(fee.months, 10) || 0,
    minCents: parseMoney(fee.min) ?? 0,
    maxCents: parseMoney(fee.max) ?? 0,
    note: fee.note,
  };
  const feeProblem = termsProblems(terms)[0] ?? null;

  const toggle = (id: number) =>
    setPicked(picked.includes(id) ? picked.filter((x) => x !== id) : [...picked, id]);

  const send = () =>
    startTransition(async () => {
      setError("");
      const res = await shareClient(orgId, { toOrgIds: picked, note, terms, blind });
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
            placeholder="you take the second site, we keep the first"
            onChange={(e) => setNote(e.target.value)} />
          {/* The note travels beside the offer and is NOT redacted with it -
              it is the reason anybody says yes, so it is checked rather than
              stripped. Said here as you type; the server checks the whole
              payload, not just the name. */}
          {blind && noteNames && (
            <div className="t-meta" style={{ color: "var(--t-warn-fg)", marginTop: 4 }}>
              Your note says &ldquo;{orgName}&rdquo; - that is the one thing a blind offer
              holds back. Reword it, or untick below.
            </div>
          )}

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
                {/* Both optional, and blank is the common case. The floor is
                    the one that needs its condition said out loud - see
                    lib/referral: it waits for the first dollar billed. */}
                <label style={{ display: "block" }}>
                  <span className="mut t-meta" style={{ display: "block" }}>Floor</span>
                  <input className="mono t-small" style={{ width: 84 }} value={fee.min}
                    aria-label="Floor" placeholder="none" disabled={pending}
                    onChange={(e) => setFee({ ...fee, min: e.target.value })} />
                </label>
                <label style={{ display: "block" }}>
                  <span className="mut t-meta" style={{ display: "block" }}>Cap</span>
                  <input className="mono t-small" style={{ width: 84 }} value={fee.max}
                    aria-label="Cap" placeholder="none" disabled={pending}
                    onChange={(e) => setFee({ ...fee, max: e.target.value })} />
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
                  and what it comes to - never their invoices. A floor costs them nothing until
                  they have billed something: a minimum charged on a client who never spent a
                  dollar is a charge for nothing.
                </div>
              )}
            </>
          )}

          {/* On by default. A referral is worth something because they cannot
              go round you, and the full list is exactly what they would need
              to - see lib/clientShare redactPayload. */}
          <label className="t-small" style={{ display: "flex", gap: 6, alignItems: "center", marginTop: 10 }}>
            <input type="checkbox" className="check" checked={blind} disabled={pending}
              onChange={(e) => setBlind(e.target.checked)} />
            keep the client&apos;s name back until they accept
          </label>
          {blind && (
            <div className="mut t-meta" style={{ marginTop: 2 }}>
              They see the equipment, how many sites and which state - not who it is, not the
              addresses, not the contacts, and no serials.
            </div>
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
