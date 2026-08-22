"use client";

import { useEffect, useState, useTransition } from "react";
import { setProvenance } from "@/app/actions";
import {
  cleanProvenance, PROVENANCE_BLURB, PROVENANCE_CHOICES, PROVENANCE_LABEL, PROVENANCE_TONE,
  type Provenance,
} from "@/lib/provenance";

/**
 * "Our IP" / "Restated facts" / "OEM material" / "Unreviewed", on one row of
 * the reference library or the procedure book. Click to reclassify.
 *
 * A chip rather than a field in an edit sheet on purpose: the classification is
 * a judgement about a row somebody is already looking at, and making them open
 * an editor to record it is how a library of a thousand rows stays unreviewed
 * forever.
 */
export default function ProvenanceChip({ what, id, value, canEdit }: {
  what: "ref" | "procedure";
  id: number;
  value: string;
  canEdit: boolean;
}) {
  const current = cleanProvenance(value);
  const [open, setOpen] = useState(false);
  // An override held only until the server's value catches up. Seeding state
  // from the prop once and keeping it would go stale the moment the row is
  // reclassified anywhere else - including from the edit sheet on this very
  // page, which is how a chip ends up disagreeing with its own header count.
  const [optimistic, setOptimistic] = useState<Provenance | null>(null);
  useEffect(() => { setOptimistic(null); }, [current]);
  const shown = optimistic ?? current;
  const [pending, startTransition] = useTransition();
  const tone = PROVENANCE_TONE[shown];

  const pick = (next: Provenance) => {
    setOpen(false);
    if (next === shown) return;
    setOptimistic(next); // the chip is the whole feedback; the revalidate confirms it
    startTransition(async () => {
      const res = await setProvenance(what, id, next);
      if (res?.error) setOptimistic(null);
    });
  };

  const chip = (
    <span className={`pill ${tone}`} title={PROVENANCE_BLURB[shown]}
      style={{
        fontSize: 10, whiteSpace: "nowrap",
        opacity: pending ? 0.6 : 1, cursor: canEdit ? "pointer" : "default",
        border: shown === "" ? "1px dashed #C7D2E0" : "none",
      }}>
      {PROVENANCE_LABEL[shown]}
    </span>
  );

  if (!canEdit) return chip;

  return (
    <span style={{ position: "relative", display: "inline-flex" }}>
      <button type="button" onClick={() => setOpen((v) => !v)} disabled={pending}
        aria-label={`Provenance: ${PROVENANCE_LABEL[shown]}`}
        style={{ border: "none", background: "none", padding: 0, cursor: "pointer", lineHeight: 1 }}>
        {chip}
      </button>
      {open && (
        <>
          <div onClick={() => setOpen(false)} style={{ position: "fixed", inset: 0, zIndex: 30 }} />
          <div style={{
            position: "absolute", top: "calc(100% + 4px)", left: 0, zIndex: 31, background: "#fff",
            border: "1px solid var(--line)", borderRadius: 10, boxShadow: "0 8px 24px rgba(23,42,74,0.14)",
            padding: 6, width: 260,
          }}>
            <div className="eyebrow" style={{ padding: "2px 6px 4px" }}>Where did this come from?</div>
            {PROVENANCE_CHOICES.map((c) => (
              <button key={c} type="button" onClick={() => pick(c)} className="row-hover"
                style={{
                  display: "block", width: "100%", textAlign: "left", border: "none", background: "none",
                  padding: "5px 6px", cursor: "pointer", borderRadius: 6,
                }}>
                <span style={{ fontSize: 12, fontWeight: 700, color: `var(--t-${PROVENANCE_TONE[c]}-fg)` }}>
                  {PROVENANCE_LABEL[c]}{c === shown ? " ✓" : ""}
                </span>
                <span className="mut" style={{ display: "block", fontSize: 10, lineHeight: 1.4 }}>
                  {PROVENANCE_BLURB[c]}
                </span>
              </button>
            ))}
            {shown !== "" && (
              <button type="button" onClick={() => pick("")} className="btn link"
                style={{ fontSize: 10, margin: "2px 6px 0" }}>clear</button>
            )}
          </div>
        </>
      )}
    </span>
  );
}
