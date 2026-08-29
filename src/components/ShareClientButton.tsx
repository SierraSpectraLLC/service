"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { inviteHandoff, shareClient } from "@/app/actions";
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
  /* OFF, and it stays off unless somebody decides otherwise. Everything else
     that travels is equipment; this is what the client has been charged. See
     SharedPricing in lib/clientShare. */
  const [pricing, setPricing] = useState(false);
  /* The other lane: a shop with no workspace here yet. Same snapshot, same
     terms, and accepting opens the workspace - see lib/handoff. */
  const [inviting, setInviting] = useState(false);
  const [inviteEmail, setInviteEmail] = useState("");
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

  const sendInvite = () =>
    startTransition(async () => {
      setError("");
      const res = await inviteHandoff(orgId, { email: inviteEmail, note, terms, pricing });
      if (res.error) { setError(res.error); return; }
      toast({ message: `Invitation sent to ${inviteEmail.trim()}` });
      setInviting(false); setInviteEmail(""); setNote("");
      router.refresh();
    });

  /* One fee editor, both lanes. The picker and the invitation ask for exactly
     the same thing, and two copies of a form with a floor, a cap and an
     either/or in it is two places for them to drift apart. */
  const feeControls = (
    <>
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
    </>
  );

  /*
   * The one money question, asked once for both lanes.
   *
   * Off by default and phrased as what it is, because the honest version of
   * this decision is uncomfortable and hiding that would not make it less so:
   * it moves a client's commercial history to another company without the
   * client in the room. Worth doing when an account is being SOLD - a buyer
   * who does not know what the lab is used to paying will quote it wrong and
   * both of you will wear it - and not worth doing for an ordinary referral.
   * What crosses is per-year totals and the rate, never an invoice and never
   * anything about how they pay. See SharedPricing in lib/clientShare.
   */
  const pricingControl = (
    <>
      <label className="t-small" style={{ display: "flex", gap: 6, alignItems: "center", marginTop: 10 }}>
        <input type="checkbox" className="check" checked={pricing} disabled={pending}
          onChange={(e) => setPricing(e.target.checked)} />
        include what this account has billed
      </label>
      <div className="mut t-meta" style={{ marginTop: 2 }}>
        {pricing
          ? "A total and a visit count per year, and your hour rate - never an invoice, never"
            + " what they paid late. It is your client's commercial history and they are not"
            + " being asked. Fair on a sale of the account; heavy-handed on a referral."
          : "Off. They get the equipment and the record, and price the work themselves."}
      </div>
    </>
  );

  const toggle = (id: number) =>
    setPicked(picked.includes(id) ? picked.filter((x) => x !== id) : [...picked, id]);

  const send = () =>
    startTransition(async () => {
      setError("");
      const res = await shareClient(orgId, { toOrgIds: picked, note, terms, blind, pricing });
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
      {providers.length === 0 && !inviting ? (
        <div className="mut t-small">
          No service companies on your list yet. Find them in{" "}
          <a href="/network">Service companies</a>, or{" "}
          <button className="btn link t-small" onClick={() => setInviting(true)}>
            invite a shop that is not on Ridgeline
          </button>.
        </div>
      ) : inviting ? (
        <>
          {/* The lane that reaches anybody new. Everything the picker sends is
              also sent here - the same frozen snapshot, the same terms - the
              only difference being that there is no workspace on the other
              end yet, so accepting opens one. See lib/handoff. */}
          <div className="mut t-small" style={{ marginBottom: 8 }}>
            They see how much there is to take on - the equipment, how many sites and which
            state - never {orgName}&apos;s name, and no addresses or serials, until they
            accept. Accepting opens a Ridgeline workspace for them with this client already in
            it: the systems, the schedules, the parts history and the paper.
          </div>
          <label>Their email</label>
          <input value={inviteEmail} aria-label="Their email" disabled={pending}
            placeholder="owner@theirshop.com"
            onChange={(e) => setInviteEmail(e.target.value)} />
          <label style={{ marginTop: 8 }}>A line for them</label>
          <input value={note} aria-label="Note to them" disabled={pending}
            placeholder="four LC-MS on your patch - we cannot cover it any more"
            onChange={(e) => setNote(e.target.value)} />
          {noteNames && (
            <div className="t-meta" style={{ color: "var(--t-warn-fg)", marginTop: 4 }}>
              Your note says &ldquo;{orgName}&rdquo; - they do not get the name until they accept.
            </div>
          )}
          {feeControls}
          {pricingControl}
          <div style={{ display: "flex", gap: 8, marginTop: 12, flexWrap: "wrap", alignItems: "center" }}>
            <button className="btn accent" disabled={pending || !inviteEmail.trim()}
              onClick={sendInvite}>
              {pending ? "Sending…" : "Send the invitation"}
            </button>
            <button className="btn" disabled={pending} onClick={() => setInviting(false)}>
              Cancel
            </button>
            {error && <span className="dialog-status err">{error}</span>}
          </div>
        </>
      ) : (
        <>
          <div className="mut t-small" style={{ marginBottom: 8 }}>
            {orgName} and its {systems} system{systems === 1 ? "" : "s"} - names, sites, models and
            serials, the maintenance schedules, what has been fitted, and the manuals and field
            notes you have cleared to pass on. <b>Not</b> your contracts, your invoices, your work
            history or your notes on the account.
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
          {feeControls}

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

          {pricingControl}

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
          {/* The other lane, and it has to be reachable from HERE.
              It used to live only in the empty state, which meant the day a
              shop added their first contact was the day they lost the ability
              to reach anybody new - and the shops worth reaching are exactly
              the ones with no account yet. */}
          <div className="mut t-small" style={{ marginTop: 8 }}>
            Not on this list?{" "}
            <button className="btn link t-small" onClick={() => setInviting(true)}>
              invite a shop that is not on Ridgeline
            </button>
          </div>
        </>
      )}
    </Panel>
  );
}
