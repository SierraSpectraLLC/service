"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { createPurchaseOrder } from "@/app/actions";
import { formatCents, centsToInput } from "@/lib/money";
import type { SuggestedLine } from "@/lib/po";

export type VendorGroup = { vendor: string; lines: SuggestedLine[] };

/**
 * The reorder list, already grouped into the orders it would become. Each
 * vendor's group raises one draft PO with its lines priced from the price book;
 * a part nobody prices still appears (under "no vendor priced") because "we
 * don't know what this costs" is something to go find out, not a reason to let
 * the shelf run empty.
 */
export default function ReorderCard({ stockroomId, groups }: {
  stockroomId: number;
  groups: VendorGroup[];
}) {
  const router = useRouter();
  const [skip, setSkip] = useState<Set<string>>(new Set());
  const [error, setError] = useState("");
  const [pending, startTransition] = useTransition();

  if (!groups.length) return null;

  const key = (vendor: string, pn: string) => `${vendor}|${pn}`;
  const toggle = (vendor: string, pn: string) =>
    setSkip((cur) => {
      const next = new Set(cur);
      const k = key(vendor, pn);
      if (next.has(k)) next.delete(k); else next.add(k);
      return next;
    });

  const raise = (g: VendorGroup) => {
    const lines = g.lines.filter((l) => !skip.has(key(g.vendor, l.partNumber)));
    if (!lines.length) { setError("Every line on that order is unticked"); return; }
    setError("");
    startTransition(async () => {
      const res = await createPurchaseOrder({
        vendor: g.vendor || "TBD",
        stockroomId,
        note: g.vendor ? "" : "Vendor not yet chosen - no price on file for these part numbers",
        lines: lines.map((l) => ({
          partNumber: l.partNumber, name: l.name, qty: String(l.qty),
          price: l.unitCents === null ? "" : centsToInput(l.unitCents),
        })),
      });
      if (res?.error) { setError(res.error); return; }
      if (res.id) router.push(`/purchasing/${res.id}`);
    });
  };

  return (
    <div className="card">
      <div className="card-title" style={{ marginBottom: 4 }}>Needs ordering</div>
      <div className="mut" style={{ fontSize: 12, marginBottom: 10 }}>
        Grouped into the orders they&apos;d become, priced from the cheapest vendor on file
        (OEM breaks ties). Untick anything you don&apos;t want on the order.
      </div>

      {groups.map((g) => {
        const kept = g.lines.filter((l) => !skip.has(key(g.vendor, l.partNumber)));
        const priced = kept.filter((l) => l.unitCents !== null);
        const total = priced.reduce((n, l) => n + l.unitCents! * l.qty, 0);
        return (
          <div key={g.vendor || "__none"} style={{ borderTop: "1px solid var(--line)", padding: "8px 0" }}>
            <div style={{ display: "flex", alignItems: "baseline", gap: 8, flexWrap: "wrap", marginBottom: 4 }}>
              <b style={{ fontSize: 13 }}>{g.vendor || "No vendor priced"}</b>
              {priced.length > 0 && <span className="mut" style={{ fontSize: 12 }}>{formatCents(total)}</span>}
              {kept.length > priced.length && (
                <span className="mut" style={{ fontSize: 11 }}>
                  {kept.length - priced.length} line{kept.length - priced.length === 1 ? "" : "s"} unpriced
                </span>
              )}
              <button className="btn sm accent" style={{ marginLeft: "auto" }} disabled={pending || !kept.length}
                onClick={() => raise(g)}>
                {pending ? "Raising..." : `Raise PO (${kept.length})`}
              </button>
            </div>
            {g.lines.map((l) => {
              const on = !skip.has(key(g.vendor, l.partNumber));
              return (
                <label key={l.partNumber} style={{ display: "flex", alignItems: "baseline", gap: 8, padding: "3px 0", fontSize: 12, cursor: "pointer", opacity: on ? 1 : 0.45, flexWrap: "wrap" }}>
                  <input type="checkbox" checked={on} onChange={() => toggle(g.vendor, l.partNumber)} style={{ width: 15, height: 15 }} />
                  <span className="mono" style={{ fontWeight: 700 }}>{l.partNumber}</span>
                  {l.name && <span>{l.name}</span>}
                  <span className="mut">× {l.qty}</span>
                  {l.unitCents !== null
                    ? <span className="mut">{formatCents(l.unitCents)} ea{l.isOem ? " · OEM" : ""}</span>
                    : <span style={{ color: "#8A5410" }}>no price on file</span>}
                </label>
              );
            })}
          </div>
        );
      })}
      {error && <div style={{ fontSize: 12, color: "#A32D2D", marginTop: 8 }}>{error}</div>}
    </div>
  );
}
