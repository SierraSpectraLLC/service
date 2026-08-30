"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  addPayrollEntry, addPerk, deletePerk, endPerk, saveMemberProfile,
} from "@/app/actions";
import { PAY_KINDS, type PayRow } from "@/lib/payroll";
import { CADENCE_LABEL, PERK_CADENCES, perkActiveOn, perkMonthlyCents, type PerkRow } from "@/lib/perks";
import { formatCents } from "@/lib/money";
import AddressField from "@/components/AddressField";
import Dialog, { DialogStatus } from "@/components/ui/Dialog";
import { confirmReason } from "@/components/ui/ConfirmDialog";
import { Pill } from "@/components/ui";
import { toast } from "@/components/ui/Toast";

export type PersonProfile = {
  homeAddress: string; phone: string; emergencyName: string; emergencyPhone: string;
  startedOn: string;
};

/**
 * One employee, the whole file: who they are, what they are paid, what else
 * they get.
 *
 * The pay half reuses the register's own action (addPayrollEntry), so a raise
 * recorded here is byte-for-byte the raise the register records - effective-
 * dated, superseding, history kept. This dialog is a doorway into that
 * machinery with the person already chosen, not a second copy of it.
 *
 * What is shown is decided by the CALLER: `seesPay` comes from the same rule
 * the register runs on, and a reader without it gets the profile half only -
 * HR facts, no figures.
 */
/** One of their kits, and what is counted in it. */
export type KitRow = { id: number; name: string; lines: number; units: number; short: number };

export default function PersonFile({ email, name, role, profile, pay, perks, kits, seesPay, orgId, today, onClose }: {
  email: string;
  name: string;
  role: string;
  profile: PersonProfile;
  /** The pay row in force today, when the reader may see it. */
  pay: PayRow | null;
  perks: PerkRow[];
  /** The vans and field kits this person keeps. Empty for most people. */
  kits: KitRow[];
  seesPay: boolean;
  /** The employing workspace - where a pay change is filed. Null hides the editors. */
  orgId: number | null;
  today: string;
  onClose: () => void;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState("");
  const [p, setP] = useState(profile);
  const [payOpen, setPayOpen] = useState(false);
  const [payDraft, setPayDraft] = useState({
    kind: pay?.kind ?? "hourly", amount: "", hoursPerWeek: String(pay?.hoursPerWeek ?? 40),
    title: pay?.title ?? "", effectiveOn: today,
  });
  const [perkOpen, setPerkOpen] = useState(false);
  const [perkDraft, setPerkDraft] = useState({
    title: "", amount: "", cadence: "monthly", startsOn: today, note: "",
  });

  const run = (fn: () => Promise<{ error?: string } | void>, ok: string, after?: () => void) =>
    startTransition(async () => {
      setError("");
      const res = await fn();
      if (res && "error" in res && res.error) { setError(res.error); return; }
      if (ok) toast({ message: ok });
      after?.();
      router.refresh();
    });

  const active = perks.filter((x) => perkActiveOn(x, today));
  const past = perks.filter((x) => !perkActiveOn(x, today));
  const perksMonthly = active.reduce((n, x) => n + perkMonthlyCents(x), 0);

  return (
    <Dialog open onClose={onClose} size="md" title={name || email}
      context={`${role === "owner" ? "Owner" : "Staff"} · ${email}`}
      footer={<>
        <DialogStatus error={error} ok="" />
        <button className="btn" onClick={onClose} disabled={pending}>Close</button>
        <button className="btn accent" disabled={pending}
          onClick={() => run(() => saveMemberProfile(email, p), "Saved their file")}>
          {pending ? "Saving..." : "Save the file"}
        </button>
      </>}>

      <div className="dialog-section">The person</div>
      <div className="pf2">
        <div>
          <label>Started on</label>
          <input type="date" value={p.startedOn} aria-label="Started on" disabled={pending}
            onChange={(e) => setP({ ...p, startedOn: e.target.value })} />
        </div>
        <div>
          <label>Phone</label>
          <input value={p.phone} aria-label="Phone" disabled={pending}
            onChange={(e) => setP({ ...p, phone: e.target.value })} />
        </div>
      </div>
      <label style={{ marginTop: 8 }}>Home address</label>
      <AddressField value={p.homeAddress} ariaLabel="Home address"
        onChange={(homeAddress) => setP({ ...p, homeAddress })} />
      <div className="field-hint">
        Their point zero for the travel rulebook - the stipend radius and routed miles
        measure from here. They can also set it themselves.
      </div>
      <div className="pf2" style={{ marginTop: 8 }}>
        <div>
          <label>Emergency contact</label>
          <input value={p.emergencyName} aria-label="Emergency contact" disabled={pending}
            placeholder="who to call" onChange={(e) => setP({ ...p, emergencyName: e.target.value })} />
        </div>
        <div>
          <label>Their number</label>
          <input value={p.emergencyPhone} aria-label="Emergency phone" disabled={pending}
            onChange={(e) => setP({ ...p, emergencyPhone: e.target.value })} />
        </div>
      </div>

      {/*
        What they are carrying.
        
        Here rather than only on the inventory page because this is where
        somebody asks it: a tech is out for a fortnight, or leaving, and the
        question is what of the shop's is in their van. The counts link to the
        room itself, which is where anything is actually done about it.
      */}
      {kits.length > 0 && (
        <>
          <div className="dialog-section" style={{ marginTop: 14 }}>What they carry</div>
          {kits.map((k) => (
            <div key={k.id} style={{ display: "flex", alignItems: "baseline", gap: 8, flexWrap: "wrap", padding: "4px 0" }}>
              <a href={`/stock/${k.id}`} className="t-body" style={{ fontWeight: 600 }}>{k.name}</a>
              <span className="mut t-small">
                {k.lines} line{k.lines === 1 ? "" : "s"} · {k.units} unit{k.units === 1 ? "" : "s"}
              </span>
              {k.short > 0 && <span className="pill bad">{k.short} short</span>}
            </div>
          ))}
        </>
      )}

      {seesPay && (
        <>
          <div className="dialog-section" style={{ marginTop: 14 }}>Pay</div>
          {pay ? (
            <div className="t-body" style={{ marginBottom: 6 }}>
              <b>{formatCents(pay.amountCents)}</b>
              <span className="mut"> {PAY_KINDS.find((k) => k.key === pay.kind)?.unit ?? pay.kind}</span>
              {pay.kind === "hourly" && <span className="mut"> · {pay.hoursPerWeek}h weeks</span>}
              {pay.title && <span className="mut"> · {pay.title}</span>}
              <span className="mut"> · since {pay.effectiveOn}</span>
            </div>
          ) : (
            <div className="mut t-small" style={{ marginBottom: 6 }}>
              Not on the payroll register yet.
            </div>
          )}
          {orgId !== null && !payOpen && (
            <button className="btn sm" onClick={() => setPayOpen(true)}>
              {pay ? "Change their pay" : "Put them on the payroll"}
            </button>
          )}
          {orgId !== null && payOpen && (
            <div style={{ border: "1px solid var(--line)", borderRadius: 8, padding: 10 }}>
              <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "flex-end" }}>
                <label style={{ display: "block" }}>
                  <span className="mut t-meta" style={{ display: "block" }}>Kind</span>
                  <select value={payDraft.kind} aria-label="Pay kind" style={{ width: "auto" }}
                    onChange={(e) => setPayDraft({ ...payDraft, kind: e.target.value })}>
                    {PAY_KINDS.map((k) => <option key={k.key} value={k.key}>{k.label}</option>)}
                  </select>
                </label>
                <label style={{ display: "block" }}>
                  <span className="mut t-meta" style={{ display: "block" }}>
                    Amount, {PAY_KINDS.find((k) => k.key === payDraft.kind)?.unit}
                  </span>
                  <input className="mono t-small" style={{ width: 110 }} value={payDraft.amount}
                    aria-label="Pay amount" placeholder={payDraft.kind === "hourly" ? "42.50" : "95,000"}
                    onChange={(e) => setPayDraft({ ...payDraft, amount: e.target.value })} />
                </label>
                {payDraft.kind === "hourly" && (
                  <label style={{ display: "block" }}>
                    <span className="mut t-meta" style={{ display: "block" }}>Hours a week</span>
                    <input className="mono t-small" style={{ width: 60 }} value={payDraft.hoursPerWeek}
                      aria-label="Hours a week"
                      onChange={(e) => setPayDraft({ ...payDraft, hoursPerWeek: e.target.value })} />
                  </label>
                )}
                <label style={{ display: "block" }}>
                  <span className="mut t-meta" style={{ display: "block" }}>From</span>
                  <input type="date" value={payDraft.effectiveOn} aria-label="Effective on"
                    onChange={(e) => setPayDraft({ ...payDraft, effectiveOn: e.target.value })} />
                </label>
              </div>
              <label style={{ marginTop: 8 }}>Job title</label>
              <input value={payDraft.title} aria-label="Job title" placeholder="Field service engineer"
                onChange={(e) => setPayDraft({ ...payDraft, title: e.target.value })} />
              <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
                <button className="btn sm accent" disabled={pending}
                  onClick={() => run(() => addPayrollEntry(orgId, {
                    name: name || email, personEmail: email, title: payDraft.title,
                    kind: payDraft.kind, amount: payDraft.amount,
                    hoursPerWeek: parseInt(payDraft.hoursPerWeek, 10) || 40,
                    ftePct: pay?.ftePct ?? 100, burdenPct: pay?.burdenPct ?? 0,
                    effectiveOn: payDraft.effectiveOn, note: "",
                  }), pay ? "Pay changed - the old rate is closed out, history kept" : "On the payroll",
                  () => setPayOpen(false))}>
                  {pay ? "Record the change" : "Put them on"}
                </button>
                <button className="btn sm" onClick={() => setPayOpen(false)} disabled={pending}>Cancel</button>
              </div>
              {/* Said before the button, because it is the whole design. */}
              <div className="mut t-meta" style={{ marginTop: 6 }}>
                A change starts a new row and closes the old one the day before - what last
                quarter cost stays what last quarter cost.
              </div>
            </div>
          )}

          <div className="dialog-section" style={{ marginTop: 14 }}>
            Perks{perksMonthly > 0 ? <span className="mut t-meta"> · {formatCents(perksMonthly)} a month</span> : null}
          </div>
          {active.length === 0 && past.length === 0 && (
            <div className="mut t-small" style={{ marginBottom: 6 }}>Nothing on top of pay.</div>
          )}
          {[...active, ...past].map((x) => (
            <div key={x.id} className="row-2" style={{ alignItems: "baseline", padding: "5px 0", borderTop: "1px solid var(--line)" }}>
              <span className="t-body" style={{ flex: 1, minWidth: 0 }}>
                {x.title}
                <span className="mut t-meta">
                  {` · ${formatCents(x.amountCents)} ${CADENCE_LABEL[(x.cadence as "monthly")] ?? x.cadence}`}
                  {x.startsOn ? ` · from ${x.startsOn}` : ""}
                </span>
              </span>
              {!perkActiveOn(x, today) && <Pill tone="faint">{x.cadence === "one_off" ? "paid" : `ended ${x.endsOn}`}</Pill>}
              {perkActiveOn(x, today) && x.cadence !== "one_off" && orgId !== null && (
                <button className="btn link" style={{ fontSize: 12 }} disabled={pending}
                  onClick={() => run(() => endPerk(x.id, today), "Ended - the history stays")}>end it</button>
              )}
              {orgId !== null && (
                <button className="btn link" style={{ fontSize: 12, color: "var(--t-bad-fg)" }} disabled={pending}
                  onClick={async () => {
                    const why = await confirmReason({
                      title: `Delete ${x.title}?`,
                      body: "For a row typed wrong - a perk that stopped should be ended, so the months it ran still say so.",
                      action: "Delete it", tone: "bad",
                    });
                    if (why) run(() => deletePerk(x.id, why), "Deleted");
                  }}>×</button>
              )}
            </div>
          ))}
          {orgId !== null && !perkOpen && (
            <button className="btn sm" style={{ marginTop: 6 }} onClick={() => setPerkOpen(true)}>+ Perk</button>
          )}
          {orgId !== null && perkOpen && (
            <div style={{ border: "1px solid var(--line)", borderRadius: 8, padding: 10, marginTop: 6 }}>
              <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "flex-end" }}>
                <label style={{ display: "block", flex: "1 1 160px" }}>
                  <span className="mut t-meta" style={{ display: "block" }}>What</span>
                  <input value={perkDraft.title} aria-label="Perk" placeholder="Phone stipend"
                    onChange={(e) => setPerkDraft({ ...perkDraft, title: e.target.value })} />
                </label>
                <label style={{ display: "block" }}>
                  <span className="mut t-meta" style={{ display: "block" }}>Worth</span>
                  <input className="mono t-small" style={{ width: 90 }} value={perkDraft.amount}
                    aria-label="Perk amount" placeholder="85"
                    onChange={(e) => setPerkDraft({ ...perkDraft, amount: e.target.value })} />
                </label>
                <label style={{ display: "block" }}>
                  <span className="mut t-meta" style={{ display: "block" }}>Per</span>
                  <select value={perkDraft.cadence} aria-label="Perk cadence" style={{ width: "auto" }}
                    onChange={(e) => setPerkDraft({ ...perkDraft, cadence: e.target.value })}>
                    {PERK_CADENCES.map((c) => (
                      <option key={c} value={c}>{c === "one_off" ? "one-off" : c === "annual" ? "year" : "month"}</option>
                    ))}
                  </select>
                </label>
                <label style={{ display: "block" }}>
                  <span className="mut t-meta" style={{ display: "block" }}>From</span>
                  <input type="date" value={perkDraft.startsOn} aria-label="Perk starts"
                    onChange={(e) => setPerkDraft({ ...perkDraft, startsOn: e.target.value })} />
                </label>
              </div>
              <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
                <button className="btn sm accent" disabled={pending}
                  onClick={() => run(() => addPerk(email, perkDraft), "Granted",
                    () => { setPerkOpen(false); setPerkDraft({ title: "", amount: "", cadence: "monthly", startsOn: today, note: "" }); })}>
                  Grant it
                </button>
                <button className="btn sm" onClick={() => setPerkOpen(false)} disabled={pending}>Cancel</button>
              </div>
            </div>
          )}
        </>
      )}
    </Dialog>
  );
}
