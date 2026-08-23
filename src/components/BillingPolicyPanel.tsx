"use client";

import { useState, useTransition } from "react";
import { saveOrgBilling } from "@/app/actions";
import { toast } from "@/components/ui/Toast";
import { Field, Panel, SaveBar } from "@/components/ui";
import { FEE_TYPES, type BillingPolicy, type EscalationContact } from "@/lib/billingPolicy";
import { LADDER } from "@/lib/dunning";
import { centsToInput } from "@/lib/money";

const FEE_LABEL: Record<string, string> = {
  none: "No late fee", flat: "A flat charge", interest: "Simple interest per month",
};

/**
 * One client's billing, overriding the workspace defaults.
 *
 * The escalation contacts are the part that earns its keep. Rung two and up of
 * the ladder address a NEW PERSON - sending the fourth reminder to the contact
 * who ignored the first three is how an invoice ages out - and these are those
 * people, named by whoever knows this account.
 */
export default function BillingPolicyPanel({ orgId, orgName, policy, terms, apEmail, poNumber, poBalanceCents }: {
  orgId: number;
  orgName: string;
  policy: BillingPolicy;
  terms: number;
  apEmail: string;
  poNumber: string;
  poBalanceCents: number;
}) {
  const initial = {
    terms: String(terms),
    apEmail,
    poNumber,
    poBalance: centsToInput(poBalanceCents),
    graceDays: String(policy.graceDays),
    feeType: policy.feeType,
    rate: (policy.rateBpsMonthly / 100).toFixed(2),
    flat: centsToInput(policy.flatCents),
    holdDays: String(policy.holdDays),
    holdAmount: centsToInput(policy.holdAmountCents),
    dunningAuto: policy.dunningAuto,
    partsMarkup: (policy.partsMarkupBps / 100).toFixed(1),
    escalation: policy.escalation.length
      ? policy.escalation
      : [] as EscalationContact[],
  };
  const [form, setForm] = useState(initial);
  const [saved, setSaved] = useState("");
  const [error, setError] = useState("");
  const [pending, startTransition] = useTransition();
  const set = <K extends keyof typeof form>(k: K, v: (typeof form)[K]) => {
    setForm((f) => ({ ...f, [k]: v }));
    setSaved("");
  };
  const dirty = JSON.stringify(form) !== JSON.stringify(initial);
  const num = (s: string) => { const n = parseFloat(s); return Number.isFinite(n) ? n : 0; };

  const setContact = (i: number, patch: Partial<EscalationContact>) =>
    set("escalation", form.escalation.map((c, j) => (j === i ? { ...c, ...patch } : c)));

  const save = () => startTransition(async () => {
    setError("");
    const res = await saveOrgBilling(orgId, {
      termsDays: parseInt(form.terms, 10) || 0,
      apEmail: form.apEmail,
      poNumber: form.poNumber,
      poBalance: form.poBalance,
      policy: {
        graceDays: parseInt(form.graceDays, 10) || 0,
        feeType: form.feeType,
        rateBpsMonthly: Math.round(num(form.rate) * 100),
        flatCents: Math.round(num(form.flat) * 100),
        holdDays: parseInt(form.holdDays, 10) || 0,
        holdAmountCents: Math.round(num(form.holdAmount) * 100),
        dunningAuto: form.dunningAuto,
        partsMarkupBps: Math.round(num(form.partsMarkup) * 100),
        escalation: form.escalation.filter((c) => c.name.trim()),
      },
    });
    if (res.error) { setError(res.error); return; }
    toast({ message: `Saved ${orgName}'s billing` });
    setSaved("Saved");
  });

  return (
    <>
      <Panel title="Terms and paperwork" hint="What AP needs to see before they will pay anything.">
        <Field label="Terms" htmlFor="terms" hint="Days from the day an invoice is issued.">
          <input id="terms" inputMode="numeric" style={{ width: 90 }} value={form.terms}
            onChange={(e) => set("terms", e.target.value)} />
        </Field>
        <Field label="AP contact" htmlFor="ap"
          hint="Reminders go here rather than to the lab. The desk that pays is rarely the desk that ordered.">
          <input id="ap" type="email" value={form.apEmail} onChange={(e) => set("apEmail", e.target.value)} />
        </Field>
        <Field label="PO on file" htmlFor="po"
          hint="A blank one is the first of the two silent AP rejections; an exhausted one is the second. Both are warned about at draft, never blocked.">
          <input id="po" value={form.poNumber} onChange={(e) => set("poNumber", e.target.value)} />
        </Field>
        <Field label="Remaining on that PO" htmlFor="pobal">
          <input id="pobal" inputMode="decimal" style={{ width: 130 }} value={form.poBalance}
            onChange={(e) => set("poBalance", e.target.value)} />
        </Field>
      </Panel>

      <Panel title="Late fees and hold" hint={`Overrides the workspace default for ${orgName} only.`}>
        <Field label="Grace after due" htmlFor="ograce">
          <input id="ograce" inputMode="numeric" style={{ width: 90 }} value={form.graceDays}
            onChange={(e) => set("graceDays", e.target.value)} />
        </Field>
        <Field label="Fee" htmlFor="ofee">
          <select id="ofee" value={form.feeType}
            onChange={(e) => set("feeType", e.target.value as BillingPolicy["feeType"])}>
            {FEE_TYPES.map((t) => <option key={t} value={t}>{FEE_LABEL[t]}</option>)}
          </select>
        </Field>
        {form.feeType === "interest" && (
          <Field label="Rate per month (%)" htmlFor="orate">
            <input id="orate" inputMode="decimal" style={{ width: 90 }} value={form.rate}
              onChange={(e) => set("rate", e.target.value)} />
          </Field>
        )}
        {form.feeType === "flat" && (
          <Field label="Flat charge" htmlFor="oflat">
            <input id="oflat" inputMode="decimal" style={{ width: 110 }} value={form.flat}
              onChange={(e) => set("flat", e.target.value)} />
          </Field>
        )}
        <Field label="Hold at this many days past due" htmlFor="oholdd" hint="Zero switches it off.">
          <input id="oholdd" inputMode="numeric" style={{ width: 90 }} value={form.holdDays}
            onChange={(e) => set("holdDays", e.target.value)} />
        </Field>
        <Field label="...or this much open" htmlFor="oholda">
          <input id="oholda" inputMode="decimal" style={{ width: 130 }} value={form.holdAmount}
            onChange={(e) => set("holdAmount", e.target.value)} />
        </Field>
        <Field label="Parts markup (%)" htmlFor="omarkup">
          <input id="omarkup" inputMode="decimal" style={{ width: 90 }} value={form.partsMarkup}
            onChange={(e) => set("partsMarkup", e.target.value)} />
        </Field>
        <Field label="Automatic reminders" htmlFor="oauto"
          hint="Off makes every rung something somebody presses. Worth it for a client you would rather phone.">
          <label className="row-2" style={{ alignItems: "center" }}>
            <input id="oauto" type="checkbox" checked={form.dunningAuto}
              onChange={(e) => set("dunningAuto", e.target.checked)} />
            <span className="t-body">Run the ladder on its own for {orgName}</span>
          </label>
        </Field>
      </Panel>

      <Panel
        title="Escalation contacts"
        count={form.escalation.length}
        actions={
          <button className="btn sm" disabled={pending}
            onClick={() => set("escalation", [...form.escalation, { name: "", role: "", email: "" }])}>
            Add a contact
          </button>
        }
        hint={`Rung 1 goes to the billing contact. Rungs 2 and up go to these, in order - ${
          LADDER.filter((r) => r.contactIndex >= 0).map((r) => r.action.toLowerCase()).join(", ")
        }. Sending the fourth reminder to whoever ignored the first three is how an invoice ages out.`}
        empty="Nobody named yet - every rung goes to the billing contact."
      >
        {form.escalation.length > 0 && form.escalation.map((c, i) => (
          <div key={i} className="row-2" style={{ alignItems: "baseline", padding: "6px 0", borderTop: "1px solid var(--line)" }}>
            <span className="mut t-small" style={{ width: 52 }}>Rung {i + 2}</span>
            <input className="t-body" value={c.name} placeholder="Name" aria-label={`Contact ${i + 1} name`}
              style={{ width: 150 }} onChange={(e) => setContact(i, { name: e.target.value })} />
            <input className="t-body" value={c.role} placeholder="Role" aria-label={`Contact ${i + 1} role`}
              style={{ width: 150 }} onChange={(e) => setContact(i, { role: e.target.value })} />
            <input className="t-body" value={c.email ?? ""} placeholder="Email" aria-label={`Contact ${i + 1} email`}
              style={{ flex: 1, minWidth: 160 }} onChange={(e) => setContact(i, { email: e.target.value })} />
            <button className="btn link t-meta" style={{ color: "var(--t-bad-fg)" }} disabled={pending}
              onClick={() => set("escalation", form.escalation.filter((_, j) => j !== i))}>
              remove
            </button>
          </div>
        ))}
      </Panel>

      <SaveBar dirty={dirty} saving={pending} message={saved} error={error}
        onSave={save} onDiscard={() => { setForm(initial); setError(""); }} />
    </>
  );
}
