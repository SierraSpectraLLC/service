"use client";

import { useState, useTransition } from "react";
import { connectStripe, refreshStripeStatus, saveBillingDefaults } from "@/app/actions";
import { toast } from "@/components/ui/Toast";
import { Field, Panel, Pill, SaveBar } from "@/components/ui";
import { FEE_TYPES, type BillingPolicy } from "@/lib/billingPolicy";
import { LADDER } from "@/lib/dunning";
import { centsToInput } from "@/lib/money";
import type { StripeMode } from "@/lib/stripe";

const FEE_LABEL: Record<string, string> = {
  none: "No late fee", flat: "A flat charge", interest: "Simple interest per month",
};

/**
 * The workspace's billing defaults.
 *
 * Every number here is a policy somebody has to be able to defend on a phone
 * call, so each field says what it MEANS rather than what it is called - "1.5%
 * is the usual ceiling in commercial terms" is the sentence that stops an
 * operator typing 5% and finding out in a dispute.
 */
export default function BillingDefaultsForm({
  policy, invoicePrefix, loadedLaborCents, platformFeeBps, stripe, months,
}: {
  policy: BillingPolicy;
  invoicePrefix: string;
  loadedLaborCents: number;
  platformFeeBps: number;
  stripe: { mode: StripeMode; accountId: string; ready: boolean };
  months: string[];
}) {
  const initial = {
    graceDays: String(policy.graceDays),
    feeType: policy.feeType,
    rateBpsMonthly: (policy.rateBpsMonthly / 100).toFixed(2),
    flatCents: centsToInput(policy.flatCents),
    appliesTo: policy.appliesTo,
    holdDays: String(policy.holdDays),
    holdAmount: centsToInput(policy.holdAmountCents),
    dunningAuto: policy.dunningAuto,
    taxParts: policy.taxParts,
    partsMarkup: (policy.partsMarkupBps / 100).toFixed(1),
    cardsEnabled: policy.cardsEnabled,
    cardSurcharge: (policy.cardSurchargeBps / 100).toFixed(2),
    cardFlat: centsToInput(policy.cardSurchargeFlatCents),
    prefix: invoicePrefix,
    loadedLabor: centsToInput(loadedLaborCents),
    platformFee: (platformFeeBps / 100).toFixed(2),
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

  const num = (s: string) => {
    const n = parseFloat(s);
    return Number.isFinite(n) ? n : 0;
  };

  const save = () => startTransition(async () => {
    setError("");
    const res = await saveBillingDefaults({
      policy: {
        graceDays: parseInt(form.graceDays, 10) || 0,
        feeType: form.feeType,
        rateBpsMonthly: Math.round(num(form.rateBpsMonthly) * 100),
        flatCents: Math.round(num(form.flatCents) * 100),
        appliesTo: form.appliesTo,
        holdDays: parseInt(form.holdDays, 10) || 0,
        holdAmountCents: Math.round(num(form.holdAmount) * 100),
        dunningAuto: form.dunningAuto,
        taxParts: form.taxParts,
        partsMarkupBps: Math.round(num(form.partsMarkup) * 100),
        cardsEnabled: form.cardsEnabled,
        cardSurchargeBps: Math.round(num(form.cardSurcharge) * 100),
        cardSurchargeFlatCents: Math.round(num(form.cardFlat) * 100),
      },
      invoicePrefix: form.prefix,
      loadedLabor: form.loadedLabor,
      platformFeeBps: Math.round(num(form.platformFee) * 100),
    });
    if (res.error) { setError(res.error); return; }
    toast({ message: "Saved the billing defaults" });
    setSaved("Saved");
  });

  const connect = () => startTransition(async () => {
    const res = await connectStripe(`${window.location.origin}/settings/billing`);
    if (res.error) { toast({ message: res.error, tone: "bad" }); return; }
    if (res.url) window.location.href = res.url;
  });

  const refresh = () => startTransition(async () => {
    const res = await refreshStripeStatus();
    if (res.error) { toast({ message: res.error, tone: "bad" }); return; }
    toast({ message: res.ready ? "Stripe has finished its checks" : "Stripe is still checking that account" });
  });

  return (
    <>
      <Panel title="Late fees" hint="Printed on every quote and invoice.">
        <Field label="Grace after the due date" htmlFor="grace" hint="Days">
          <input id="grace" inputMode="numeric" style={{ width: 90 }} value={form.graceDays}
            onChange={(e) => set("graceDays", e.target.value)} />
        </Field>
        <Field label="Fee" htmlFor="feetype">
          <select id="feetype" value={form.feeType}
            onChange={(e) => set("feeType", e.target.value as BillingPolicy["feeType"])}>
            {FEE_TYPES.map((t) => <option key={t} value={t}>{FEE_LABEL[t]}</option>)}
          </select>
        </Field>
        {form.feeType === "interest" && (
          <Field label="Rate per month (%)" htmlFor="rate" hint="Simple interest">
            <input id="rate" inputMode="decimal" style={{ width: 90 }} value={form.rateBpsMonthly}
              onChange={(e) => set("rateBpsMonthly", e.target.value)} />
          </Field>
        )}
        {form.feeType === "flat" && (
          <Field label="Flat charge" htmlFor="flat" hint="Once per late month">
            <input id="flat" inputMode="decimal" style={{ width: 110 }} value={form.flatCents}
              onChange={(e) => set("flatCents", e.target.value)} />
          </Field>
        )}
        <Field label="Applies to" htmlFor="applies">
          <select id="applies" value={form.appliesTo}
            onChange={(e) => set("appliesTo", e.target.value as "parts" | "all")}>
            <option value="all">Parts and labor</option>
            <option value="parts">Parts only</option>
          </select>
        </Field>

      </Panel>

      <Panel title="Credit hold and escalation">
        <Field label="Hold when the oldest invoice is this many days past due" htmlFor="holddays"
          hint="0 = off">
          <input id="holddays" inputMode="numeric" style={{ width: 90 }} value={form.holdDays}
            onChange={(e) => set("holdDays", e.target.value)} />
        </Field>
        <Field label="...or when the open balance passes" htmlFor="holdamt" hint="0 = off">
          <input id="holdamt" inputMode="decimal" style={{ width: 130 }} value={form.holdAmount}
            onChange={(e) => set("holdAmount", e.target.value)} />
        </Field>
        <Field label="Automatic reminders" htmlFor="auto">
          <label className="row-2" style={{ alignItems: "center" }}>
            <input id="auto" type="checkbox" checked={form.dunningAuto}
              onChange={(e) => set("dunningAuto", e.target.checked)} />
            <span className="t-body">Run the ladder on its own</span>
          </label>
        </Field>
        <div className="mut t-small">
          {LADDER.length} rungs: {LADDER.map((r) => r.action.toLowerCase()).join(", ")}. Per-client
          contacts are on the organization page.
        </div>
      </Panel>

      <Panel title="Pricing and numbering">
        <Field label="Parts markup (%)" htmlFor="markup" hint="Over landed cost">
          <input id="markup" inputMode="decimal" style={{ width: 90 }} value={form.partsMarkup}
            onChange={(e) => set("partsMarkup", e.target.value)} />
        </Field>
        <Field label="Sales tax on parts" htmlFor="tax" hint="At the site's rate">
          <label className="row-2" style={{ alignItems: "center" }}>
            <input id="tax" type="checkbox" checked={form.taxParts}
              onChange={(e) => set("taxParts", e.target.checked)} />
            <span className="t-body">Draw the parts tax line</span>
          </label>
        </Field>
        <Field label="Invoice prefix" htmlFor="prefix">
          <input id="prefix" style={{ width: 110 }} value={form.prefix}
            onChange={(e) => set("prefix", e.target.value)} />
        </Field>
        <Field label="Loaded labor, per hour" htmlFor="loaded" hint="Wage plus burden - used for margins">
          <input id="loaded" inputMode="decimal" style={{ width: 130 }} value={form.loadedLabor}
            onChange={(e) => set("loadedLabor", e.target.value)} />
        </Field>
      </Panel>

      <Panel
        title="Payments"
        actions={
          <Pill tone={stripe.mode === "absent" ? "neutral" : stripe.mode === "test" ? "warn" : stripe.ready ? "good" : "warn"}>
            {stripe.mode === "absent" ? "Not configured" : stripe.mode === "test" ? "Test mode" : stripe.ready ? "Live" : "Live, not verified"}
          </Pill>
        }
        hint={
          stripe.mode === "absent"
            ? "No Stripe keys set - pay buttons do not render."
            : stripe.mode === "test"
              ? "Test mode - no money moves."
              : "Live."
        }
      >
        {stripe.mode !== "absent" && (
          <>
            <div className="row-2" style={{ alignItems: "baseline", padding: "6px 0" }}>
              <span className="mut t-small" style={{ width: 140 }}>Connected account</span>
              <span className="t-body" style={{ flex: 1, minWidth: 0 }}>
                {stripe.accountId
                  ? <><span className="mono">{stripe.accountId}</span>{stripe.ready ? " - ready" : " - Stripe is still checking it"}</>
                  : "none yet"}
              </span>
              <button className="btn sm" disabled={pending} onClick={connect}>
                {stripe.accountId ? "Continue onboarding" : "Connect an account"}
              </button>
              {stripe.accountId && (
                <button className="btn sm" disabled={pending} onClick={refresh}>Re-check</button>
              )}
            </div>
            <Field label="Offer card payments" htmlFor="cards">
              <label className="row-2" style={{ alignItems: "center" }}>
                <input id="cards" type="checkbox" checked={form.cardsEnabled}
                  onChange={(e) => set("cardsEnabled", e.target.checked)} />
                <span className="t-body">Show a card option beside bank transfer</span>
              </label>
            </Field>
            {form.cardsEnabled && (
              <>
                <Field label="Card surcharge (%)" htmlFor="surch" hint="Shown on the pay page">
                  <input id="surch" inputMode="decimal" style={{ width: 90 }} value={form.cardSurcharge}
                    onChange={(e) => set("cardSurcharge", e.target.value)} />
                </Field>
                <Field label="...plus a flat amount" htmlFor="cardflat">
                  <input id="cardflat" inputMode="decimal" style={{ width: 110 }} value={form.cardFlat}
                    onChange={(e) => set("cardFlat", e.target.value)} />
                </Field>
              </>
            )}
            <Field label="Platform fee (%)" htmlFor="pfee" hint="Platform's cut of processed volume">
              <input id="pfee" inputMode="decimal" style={{ width: 90 }} value={form.platformFee}
                onChange={(e) => set("platformFee", e.target.value)} />
            </Field>

          </>
        )}
      </Panel>

      <Panel title="Exports" hint="CSV for QuickBooks / Xero. Drafts excluded.">
        {months.length === 0
          ? <div className="mut t-body">Nothing to export yet.</div>
          : months.slice(0, 12).map((m) => (
            <div key={m} className="row-2" style={{ alignItems: "baseline", padding: "6px 0", borderTop: "1px solid var(--line)" }}>
              <span className="t-body" style={{ width: 90, fontWeight: 600 }}>{m}</span>
              {["invoices", "payments", "fees"].map((what) => (
                <a key={what} className="btn sm" style={{ textDecoration: "none" }}
                  href={`/api/export/billing?month=${m}&what=${what}`}>
                  {what}
                </a>
              ))}
            </div>
          ))}
      </Panel>

      <SaveBar dirty={dirty} saving={pending} message={saved} error={error}
        onSave={save} onDiscard={() => { setForm(initial); setError(""); }} />
    </>
  );
}
