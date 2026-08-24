"use client";

import { useState, useTransition } from "react";
import { saveExpensePolicy } from "@/app/actions";
import { toast } from "@/components/ui/Toast";
import type { ExpensePolicy } from "@/lib/expensePolicy";
import { Field, Panel } from "@/components/ui";

const dollars = (cents: number) => (cents === 0 ? "" : (cents / 100).toFixed(2));
const cents = (s: string) => Math.max(0, Math.round(parseFloat(s || "0") * 100) || 0);

/**
 * The travel rulebook, edited as the sentences it enforces. Each field is one
 * clause of the rule the work-order panel applies, so the person setting a
 * number can read what the number will do - a bare grid of labelled inputs is
 * how a radius ends up saved in kilometres.
 */
export default function ExpenseRulesForm({ policy }: { policy: ExpensePolicy }) {
  const [d, setD] = useState({
    radiusMiles: policy.radiusMiles === 0 ? "" : String(policy.radiusMiles),
    dayPerDiem: dollars(policy.dayPerDiemCents),
    overnight: dollars(policy.overnightPerDiemCents),
    extendedAfter: policy.extendedAfterNights === 0 ? "" : String(policy.extendedAfterNights),
    overnightExtended: dollars(policy.overnightExtendedCents),
    hotelCap: dollars(policy.hotelNightCapCents),
  });
  const [msg, setMsg] = useState("");
  const [pending, startTransition] = useTransition();

  const save = () => {
    setMsg("");
    startTransition(async () => {
      const res = await saveExpensePolicy({
        radiusMiles: parseInt(d.radiusMiles, 10) || 0,
        dayPerDiemCents: cents(d.dayPerDiem),
        overnightPerDiemCents: cents(d.overnight),
        extendedAfterNights: parseInt(d.extendedAfter, 10) || 0,
        overnightExtendedCents: cents(d.overnightExtended),
        hotelNightCapCents: cents(d.hotelCap),
      });
      if (res?.error) { setMsg(res.error); return; }
      toast({ message: "Travel rules saved" });
    });
  };

  const num = (key: keyof typeof d, width = 90, placeholder = "0") => (
    <input className="t-body" inputMode="decimal" value={d[key]} placeholder={placeholder}
      onChange={(e) => setD({ ...d, [key]: e.target.value })} style={{ width }} />
  );

  return (
    <Panel title="Travel rules"
      hint="What the work-order expense panel applies. Blank turns a clause off.">
      <div style={{ display: "grid", gap: 12 }}>
        <Field label="Stipend radius"
          hint="Road miles one-way from the engineer's home. Inside it, a day trip's gas and meals ride the car stipend - the panel says so instead of offering a per diem.">
          <div className="row-2" style={{ alignItems: "center" }}>
            {num("radiusMiles", 80, "80")} <span className="t-small mut">miles</span>
          </div>
        </Field>
        <Field label="Day-trip per diem"
          hint="Meals for a day beyond the radius, once per trip.">
          <div className="row-2" style={{ alignItems: "center" }}>
            $ {num("dayPerDiem", 90, "30.00")}
          </div>
        </Field>
        <Field label="Overnight per diem"
          hint="Meals per night away. Nights are judged by themselves - a required overnight inside the radius still earns this.">
          <div className="row-2" style={{ alignItems: "center" }}>
            $ {num("overnight", 90, "65.00")} <span className="t-small mut">per night, stepping up to</span>
            $ {num("overnightExtended", 90, "85.00")} <span className="t-small mut">after</span>
            {num("extendedAfter", 60, "3")} <span className="t-small mut">nights</span>
          </div>
        </Field>
        <Field label="Lodging ceiling"
          hint="Per night. Blank means lodging is not a covered expense.">
          <div className="row-2" style={{ alignItems: "center" }}>
            $ {num("hotelCap", 90, "180.00")} <span className="t-small mut">per night</span>
          </div>
        </Field>
      </div>
      <div className="row-2" style={{ marginTop: 12, alignItems: "center" }}>
        <button className="btn sm accent" onClick={save} disabled={pending}>
          {pending ? "Saving..." : "Save travel rules"}
        </button>
        {msg && <span className="t-small" style={{ color: "var(--t-bad-fg)" }}>{msg}</span>}
      </div>
    </Panel>
  );
}
