"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { requestCustodianAck, submitPmRun } from "@/app/actions";
import { toast } from "@/components/ui/Toast";
import type { SheetRowSpec } from "@/lib/custody/sheetLayout";

type Row = SheetRowSpec & { checklist: string; steps: string[]; status: string };
type Step = { state: "done" | "skip" | "na" | null; reading: string; condition: string; reason: string; lot: string };

/**
 * The PM on a phone: the same rows the sheet prints, one tri-state each, a
 * reading where the procedure asks for one, the reason when a step is
 * skipped (it travels), the lot when a part went in (it stays), reference
 * steps inline, two boxes, the technician's name. Submit hands all of it to
 * the same builder the sheet's confirm uses, so both surfaces write one line.
 */
export default function PmRun({ instrumentId, externalId, rows }: { instrumentId: number; externalId: string; rows: Row[] }) {
  const [steps, setSteps] = useState<Record<string, Step>>(Object.fromEntries(rows.map((r) => [r.key, { state: null, reading: "", condition: "", reason: "", lot: "" }])));
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const [findings, setFindings] = useState("");
  const [privateNotes, setPrivateNotes] = useState("");
  const [technician, setTechnician] = useState("");
  const [askAck, setAskAck] = useState(true);
  const [error, setError] = useState("");
  const [pending, startTransition] = useTransition();
  const router = useRouter();

  const set = (key: string, patch: Partial<Step>) => setSteps((s) => ({ ...s, [key]: { ...s[key], ...patch } }));
  const answered = rows.filter((r) => steps[r.key].state !== null);
  const problems = [
    ...(answered.length === 0 ? ["Answer at least one step."] : []),
    ...rows.filter((r) => steps[r.key].state === "skip" && !steps[r.key].reason.trim()).map((r) => `${r.title}: say why it was skipped.`),
    ...(technician.trim().length < 2 ? ["Type your name."] : []),
  ];

  return (
    <div className="card">
      <div className="card-title">PM run · {externalId}</div>
      <div className="mut t-small" style={{ marginBottom: 8 }}>Tap what you did. A skipped step needs a reason, and the reason travels with the machine.</div>
      {rows.map((r, i) => {
        const s = steps[r.key];
        return (
          <div key={r.key} className="field" style={{ borderTop: "1px solid var(--line)", paddingTop: 8 }}>
            <div style={{ display: "flex", gap: 8, alignItems: "baseline", flexWrap: "wrap" }}>
              <span className="mono mut t-meta">{i + 1}</span>
              <b className="t-body">{r.title}</b>
              <span className="mut t-meta">{r.status}</span>
              {r.steps.length > 0 && (
                <button type="button" className="btn sm" style={{ marginLeft: "auto" }} onClick={() => setOpen((o) => ({ ...o, [r.key]: !o[r.key] }))}>
                  {open[r.key] ? "Hide steps" : `${r.steps.length} steps`}
                </button>
              )}
            </div>
            {open[r.key] && <ol className="t-small mut" style={{ margin: "4px 0", paddingLeft: 16 }}>{r.steps.map((t, k) => <li key={k}>{t}</li>)}</ol>}
            <div style={{ display: "flex", gap: 4, marginTop: 4 }}>
              {(["done", "skip", "na"] as const).map((k) => (
                <button key={k} type="button" className={`btn sm${s.state === k ? " accent" : ""}`} onClick={() => set(r.key, { state: s.state === k ? null : k })}>
                  {k === "na" ? "N/A" : k[0].toUpperCase() + k.slice(1)}
                </button>
              ))}
            </div>
            {s.state === "skip" && (
              <input value={s.reason} onChange={(e) => set(r.key, { reason: e.target.value })} placeholder="Why - travels with the machine" className="t-small" style={{ marginTop: 4 }} />
            )}
            {s.state === "done" && r.reading && (
              <div style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 4 }}>
                <input value={s.reading} onChange={(e) => set(r.key, { reading: e.target.value })} placeholder="Reading" className="t-small mono" style={{ width: 140 }} inputMode="decimal" />
                {r.unit && <span className="mut t-meta">{r.unit}</span>}
                <input value={s.condition} onChange={(e) => set(r.key, { condition: e.target.value })} placeholder="Condition (optional, travels)" className="t-small" style={{ flex: 1 }} />
              </div>
            )}
            {s.state === "done" && r.partNumber && (
              <input value={s.lot} onChange={(e) => set(r.key, { lot: e.target.value })} placeholder={`Lot for ${r.partNumber} (stays private)`} className="t-small" style={{ marginTop: 4, width: 220 }} />
            )}
          </div>
        );
      })}
      <div className="field"><label>Findings <span className="field-opt">(travels)</span></label>
        <textarea value={findings} onChange={(e) => setFindings(e.target.value)} rows={3} placeholder="Written for whoever holds this machine next. No site, no contact, no prices." style={{ width: "100%" }} /></div>
      <div className="field"><label>Private notes <span className="field-opt">(stays)</span></label>
        <textarea value={privateNotes} onChange={(e) => setPrivateNotes(e.target.value)} rows={2} style={{ width: "100%" }} /></div>
      <div className="field"><label>Technician *</label>
        <input value={technician} onChange={(e) => setTechnician(e.target.value)} placeholder="Your name - signs the run in your account" style={{ width: 260 }} />
        <div className="field-hint">Signed in-app by your own account, which is what makes it verify. A line on paper does not.</div></div>
      <label className="t-small" style={{ display: "flex", gap: 8, alignItems: "center", fontWeight: 400 }}>
        <input type="checkbox" checked={askAck} onChange={(e) => setAskAck(e.target.checked)} style={{ width: 14, height: 14 }} />
        Ask the lab to acknowledge this PM in the portal (never holds up the record)
      </label>
      {(error || problems.length > 0) && <div className="field-err">{error || problems[0]}</div>}
      <button className="btn primary" disabled={pending || problems.length > 0} style={{ marginTop: 8 }}
        onClick={() => startTransition(async () => {
          setError("");
          const res = await submitPmRun(instrumentId, {
            steps: rows.filter((r) => steps[r.key].state !== null).map((r) => ({
              key: r.key, state: steps[r.key].state!, reading: steps[r.key].reading, unit: r.unit, condition: steps[r.key].condition,
              reason: steps[r.key].reason, partNumber: r.partNumber, lot: steps[r.key].lot,
            })),
            findings, privateNotes, setVersion: 1, technician,
          });
          if (res.error || !res.eventId) { setError(res.error ?? "Could not file the run"); return; }
          if (askAck) await requestCustodianAck(res.eventId);
          toast({ message: `Filed the PM run on ${externalId}` });
          router.push(`/instruments/${instrumentId}`);
        })}>
        {pending ? "Filing..." : "File the run"}
      </button>
    </div>
  );
}
