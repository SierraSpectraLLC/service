"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { claimLead, postLead, withdrawLead } from "@/app/actions";
import {
  blurbLeaks, equipmentLine, leadSummary, LEAD_LABEL, type LeadState, type LeadSystem,
} from "@/lib/lead";
import type { LeadRow } from "@/lib/leadData";
import {
  choicesFor, FEE_KINDS, FEE_LABEL, termsLine, termsProblems, type FeeKind,
} from "@/lib/referral";
import { formatCents, parseMoney } from "@/lib/money";
import Dialog, { DialogStatus } from "@/components/ui/Dialog";
import { Panel, Pill } from "@/components/ui";
import { toast } from "@/components/ui/Toast";

const TONE: Record<LeadState, "good" | "warn" | "faint"> = {
  open: "warn", claimed: "good", withdrawn: "faint",
};

/** "5%", "2.5%" - the same rounding lib/referral prints. */
const pct = (bps: number): string => `${(bps / 100).toFixed(bps % 100 === 0 ? 0 : 1)}%`;

type Row = { category: string; model: string; count: string };
const blank = (): Row => ({ category: "", model: "", count: "1" });

/**
 * Work somebody is not going to do, offered to shops who might.
 *
 * The offered half leads and it is deliberately short of detail: the equipment,
 * roughly where, the fee. Who it is stays with the finder until somebody
 * claims it, because a finder's fee is only worth anything while the finder is
 * the only route - see lib/lead.
 *
 * And the race is stated rather than discovered. A shop that reads this on
 * Thursday and acts on Monday should already know why it was gone.
 */
export default function LeadBoard({ mine, offered, providers }: {
  mine: LeadRow[]; offered: LeadRow[];
  providers: { id: number; name: string }[];
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [open, setOpen] = useState(false);
  const [error, setError] = useState("");
  const [f, setF] = useState({
    contactName: "", contactEmail: "", contactPhone: "", orgName: "", address: "",
    region: "", blurb: "", kind: "flat" as FeeKind, flat: "", pct: "5", months: "12",
    min: "", max: "", note: "",
  });
  const [rows, setRows] = useState<Row[]>([blank()]);
  const [picked, setPicked] = useState<number[]>([]);

  const systems: LeadSystem[] = rows
    .map((r) => ({
      category: r.category, model: r.model,
      count: Math.max(1, parseInt(r.count, 10) || 1),
    }))
    .filter((r) => r.category.trim() || r.model.trim());
  const terms = {
    kind: f.kind, feeCents: parseMoney(f.flat) ?? 0,
    feeBps: Math.round((parseFloat(f.pct) || 0) * 100),
    windowMonths: parseInt(f.months, 10) || 0,
    minCents: parseMoney(f.min) ?? 0, maxCents: parseMoney(f.max) ?? 0,
    note: f.note,
  };
  // "What they asked for" is PUBLISHED. A finder who types the lab's name into
  // it has given the lead away in the field next to the one holding it back.
  const said = blurbLeaks(f.blurb, f);
  const problem = said.length ? `keep "${said[0]}" out of what they asked for - that is published`
    : !f.region.trim() ? "say roughly where it is"
    : systems.length === 0 ? "say what they have"
      : !f.orgName.trim() ? "give the company's name"
        : !f.contactEmail.trim() && !f.contactPhone.trim() ? "give an email or a phone number"
          : picked.length === 0 ? "pick who to offer it to"
            : termsProblems(terms)[0] ?? null;

  const run = (fn: () => Promise<{ error?: string } | void>, ok: string) =>
    startTransition(async () => {
      setError("");
      const res = await fn();
      if (res?.error) { setError(res.error); toast({ message: res.error }); return; }
      toast({ message: ok });
      router.refresh();
    });

  const post = () =>
    startTransition(async () => {
      setError("");
      const res = await postLead({ ...f, systems, terms, toOrgIds: picked });
      if (res.error) { setError(res.error); return; }
      toast({ message: `Offered to ${res.sent} ${res.sent === 1 ? "company" : "companies"}` });
      setOpen(false); setRows([blank()]); setPicked([]);
      setF({ ...f, contactName: "", contactEmail: "", contactPhone: "", orgName: "", address: "", region: "", blurb: "" });
      router.refresh();
    });

  const setRow = (i: number, patch: Partial<Row>) =>
    setRows(rows.map((r, n) => (n === i ? { ...r, ...patch } : r)));

  return (
    <>
      {offered.length > 0 && (
        <Panel title="Leads offered to you"
          count={offered.filter((l) => l.status === "open").length || undefined}
          hint="Work another shop is not taking on. First to claim it gets it.">
          {offered.map((l) => (
            <div key={l.id} style={{ padding: "9px 0", borderTop: "1px solid var(--line)" }}>
              <div className="row-2" style={{ alignItems: "baseline" }}>
                <span className="t-body" style={{ fontWeight: 600, flex: 1, minWidth: 0 }}>
                  {leadSummary(l)}
                  <span className="mut t-meta"> from {l.fromName}</span>
                </span>
                <Pill tone={TONE[l.status as LeadState] ?? "faint"}>
                  {LEAD_LABEL[l.status as LeadState] ?? l.status}
                </Pill>
              </div>
              <div className="mut t-small">{equipmentLine(l.systems)}</div>
              {l.blurb && <div className="t-small" style={{ marginTop: 2 }}>{l.blurb}</div>}
              <div className="t-small" style={{ marginTop: 2, color: "var(--t-warn-fg)" }}>
                Their fee: <b>{termsLine(l.terms, formatCents)}</b>
              </div>

              {/* Once claimed the contact details are simply there. Before, they
                  are not in the object at all - see lib/leadData. */}
              {l.open && (
                <div className="t-small" style={{ marginTop: 6, paddingLeft: 10, borderLeft: "2px solid var(--line)" }}>
                  <b>{l.orgName}</b>
                  {l.address ? <div className="mut">{l.address}</div> : null}
                  <div className="mut">
                    {[l.contactName, l.contactEmail, l.contactPhone].filter(Boolean).join(" · ")}
                  </div>
                </div>
              )}

              {/* An either/or is answered HERE, on the way in - two buttons
                  rather than a radio and a confirm, because this is a race and
                  every extra click is somebody else getting there first.
                  Claiming without saying which would hand over the contact
                  details and leave the finder owed a fee of no agreed shape. */}
              {l.status === "open" && (
                <div style={{ display: "flex", gap: 8, marginTop: 8, flexWrap: "wrap" }}>
                  {(choicesFor(l.terms.kind).length ? choicesFor(l.terms.kind) : [""]).map((k) => (
                    <button key={k || "claim"} className="btn accent" disabled={pending}
                      onClick={() => run(() => claimLead(l.id, k),
                        "Claimed - the contact details are yours")}>
                      {k === "flat" ? `Claim for ${formatCents(l.terms.feeCents)}`
                        : k === "percent" ? `Claim at ${pct(l.terms.feeBps)}`
                          : "Claim it"}
                    </button>
                  ))}
                  <span className="mut t-meta" style={{ alignSelf: "center" }}>
                    You get the name and the number, and owe the fee.
                  </span>
                </div>
              )}
              {l.status === "claimed" && !l.open && (
                <div className="mut t-meta" style={{ marginTop: 4 }}>
                  {l.claimedByName ? `${l.claimedByName} took this one.` : "Somebody took this one."}
                </div>
              )}
            </div>
          ))}
        </Panel>
      )}

      <Panel title="Leads you have offered" count={mine.length || undefined}
        hint="Inquiries you are not taking on. The contact details stay with you until somebody claims it.">
        {mine.map((l) => (
          <div key={l.id} className="row-2" style={{ alignItems: "baseline", padding: "7px 0", borderTop: "1px solid var(--line)" }}>
            <span className="t-body" style={{ flex: 1, minWidth: 0 }}>
              {l.orgName || leadSummary(l)}
              <span className="mut t-meta">
                {` · ${leadSummary(l)} · to ${l.offeredTo} ${l.offeredTo === 1 ? "shop" : "shops"}`}
                {l.claimedByName ? ` · ${l.claimedByName}` : ""}
              </span>
            </span>
            <Pill tone={TONE[l.status as LeadState] ?? "faint"}>
              {LEAD_LABEL[l.status as LeadState] ?? l.status}
            </Pill>
            {l.status === "open" && (
              <button className="btn link" style={{ fontSize: 12 }} disabled={pending}
                onClick={() => run(() => withdrawLead(l.id), "Withdrawn")}>withdraw</button>
            )}
          </div>
        ))}
        <button className="btn accent" style={{ marginTop: 10 }} onClick={() => { setError(""); setOpen(true); }}>
          Offer a lead
        </button>
        {providers.length === 0 && (
          <div className="mut t-small" style={{ marginTop: 6 }}>
            Add a service company below first - a lead goes to shops on your list, not to the instance.
          </div>
        )}
      </Panel>

      {open && (
        <Dialog open onClose={() => setOpen(false)} size="md"
          title="Offer a lead"
          context="Work you are not taking on. They see the equipment and the region; who it is stays with you until somebody claims it."
          footer={<>
            <DialogStatus error={error} problem={problem} ok="Ready to offer." />
            <button className="btn" onClick={() => setOpen(false)} disabled={pending}>Cancel</button>
            <button className="btn accent" onClick={post} disabled={pending || !!problem}>
              {pending ? "Offering..."
                : picked.length ? `Offer to ${picked.length} ${picked.length === 1 ? "shop" : "shops"}`
                  : "Offer it"}
            </button>
          </>}>
          <div className="dialog-section">What they have</div>
          <div className="pf2">
            <div>
              <label>Roughly where</label>
              <input value={f.region} aria-label="Region" disabled={pending}
                placeholder="Boston metro" onChange={(e) => setF({ ...f, region: e.target.value })} />
              <div className="field-hint">Published. Keep it as coarse as you like.</div>
            </div>
            <div>
              <label>What they asked for</label>
              <input value={f.blurb} aria-label="Blurb" disabled={pending}
                placeholder="PM contract, two sites, wants a quote by October"
                onChange={(e) => setF({ ...f, blurb: e.target.value })} />
            </div>
          </div>

          {rows.map((r, i) => (
            <div key={i} style={{ display: "flex", gap: 6, marginTop: 6, flexWrap: "wrap" }}>
              <input style={{ width: 60 }} inputMode="numeric" value={r.count}
                aria-label={`Count ${i + 1}`} disabled={pending}
                onChange={(e) => setRow(i, { count: e.target.value })} />
              <input style={{ flex: "1 1 130px" }} value={r.model} placeholder="model, e.g. API 5000"
                aria-label={`Model ${i + 1}`} disabled={pending}
                onChange={(e) => setRow(i, { model: e.target.value })} />
              <input style={{ flex: "1 1 110px" }} value={r.category} placeholder="category"
                aria-label={`Category ${i + 1}`} disabled={pending}
                onChange={(e) => setRow(i, { category: e.target.value })} />
              {rows.length > 1 && (
                <button className="btn link" style={{ fontSize: 12 }}
                  onClick={() => setRows(rows.filter((_, n) => n !== i))}>remove</button>
              )}
            </div>
          ))}
          <button className="btn sm" style={{ marginTop: 6 }} onClick={() => setRows([...rows, blank()])}>
            + Equipment
          </button>

          <div className="dialog-section" style={{ marginTop: 12 }}>Who they are</div>
          <div className="mut t-meta" style={{ marginBottom: 6 }}>
            Held back until somebody claims it. Nobody sees any of this before then.
          </div>
          <div className="pf2">
            <div>
              <label>Company</label>
              <input value={f.orgName} aria-label="Company" disabled={pending}
                onChange={(e) => setF({ ...f, orgName: e.target.value })} />
            </div>
            <div>
              <label>Who wrote in</label>
              <input value={f.contactName} aria-label="Contact name" disabled={pending}
                onChange={(e) => setF({ ...f, contactName: e.target.value })} />
            </div>
          </div>
          <div className="pf2" style={{ marginTop: 8 }}>
            <div>
              <label>Email</label>
              <input value={f.contactEmail} aria-label="Contact email" disabled={pending}
                onChange={(e) => setF({ ...f, contactEmail: e.target.value })} />
            </div>
            <div>
              <label>Phone</label>
              <input value={f.contactPhone} aria-label="Contact phone" disabled={pending}
                onChange={(e) => setF({ ...f, contactPhone: e.target.value })} />
            </div>
          </div>
          <label style={{ marginTop: 8 }}>Address</label>
          <input value={f.address} aria-label="Address" disabled={pending}
            onChange={(e) => setF({ ...f, address: e.target.value })} />

          <div className="dialog-section" style={{ marginTop: 12 }}>Your finder&apos;s fee</div>
          <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "flex-end" }}>
            <label style={{ display: "block" }}>
              <span className="mut t-meta" style={{ display: "block" }}>Fee</span>
              <select value={f.kind} aria-label="Lead fee" disabled={pending} style={{ width: "auto" }}
                onChange={(e) => setF({ ...f, kind: e.target.value as FeeKind })}>
                {FEE_KINDS.filter((k) => k !== "none").map((k) => (
                  <option key={k} value={k}>{FEE_LABEL[k]}</option>
                ))}
              </select>
            </label>
            {(f.kind === "flat" || f.kind === "either") && (
              <label style={{ display: "block" }}>
                <span className="mut t-meta" style={{ display: "block" }}>To claim</span>
                <input className="mono t-small" style={{ width: 92 }} value={f.flat}
                  aria-label="Lead fee amount" placeholder="500" disabled={pending}
                  onChange={(e) => setF({ ...f, flat: e.target.value })} />
              </label>
            )}
            {(f.kind === "percent" || f.kind === "either") && (
              <>
                <label style={{ display: "block" }}>
                  <span className="mut t-meta" style={{ display: "block" }}>Share, %</span>
                  <input className="mono t-small" style={{ width: 60 }} value={f.pct}
                    aria-label="Lead share percent" disabled={pending}
                    onChange={(e) => setF({ ...f, pct: e.target.value })} />
                </label>
                <label style={{ display: "block" }}>
                  <span className="mut t-meta" style={{ display: "block" }}>For, months</span>
                  <input className="mono t-small" style={{ width: 60 }} value={f.months}
                    aria-label="Lead window months" disabled={pending}
                    onChange={(e) => setF({ ...f, months: e.target.value })} />
                </label>
              </>
            )}
          </div>

          <div className="dialog-section" style={{ marginTop: 12 }}>Who to offer it to</div>
          {providers.map((p) => (
            <label key={p.id} className="t-body"
              style={{ display: "flex", gap: 8, alignItems: "center", padding: "4px 0" }}>
              <input type="checkbox" className="check" disabled={pending}
                checked={picked.includes(p.id)}
                onChange={() => setPicked(picked.includes(p.id)
                  ? picked.filter((x) => x !== p.id) : [...picked, p.id])} />
              {p.name}
            </label>
          ))}
          <div className="field-hint">
            All of them see it at once, and the first to claim it gets it. The rest are told it has gone.
          </div>
        </Dialog>
      )}
    </>
  );
}
