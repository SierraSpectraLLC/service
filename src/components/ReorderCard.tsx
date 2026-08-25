"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { createPurchaseOrder } from "@/app/actions";
import { toast } from "@/components/ui/Toast";
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
export default function ReorderCard({ stockroomId, groups, mode = "cheapest", urgent = false, baseHref = "" }: {
  stockroomId: number;
  groups: VendorGroup[];
  /** How the vendor per part was picked - the strip reflects and switches it. */
  mode?: "cheapest" | "fastest";
  urgent?: boolean;
  /** The room's URL, for the mode links. Empty hides the strip. */
  baseHref?: string;
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
        urgent,
        note: g.vendor ? "" : "Vendor not yet chosen - no price on file for these part numbers",
        lines: lines.map((l) => ({
          partNumber: l.partNumber, name: l.name, qty: String(l.qty),
          price: l.unitCents === null ? "" : centsToInput(l.unitCents),
        })),
      });
      if (res?.error) { setError(res.error); return; }
      toast({ message: `Raised a PO on ${g.vendor || "TBD"} with ${lines.length} line${lines.length === 1 ? "" : "s"}` });
      if (res.id) router.push(`/money/purchasing/${res.id}`);
    });
  };

  return (
    <div className="card">
      <div className="row-2" style={{ alignItems: "baseline", marginBottom: 4 }}>
        <div className="card-title">Needs ordering</div>
        {baseHref && (
          <span className="seg" role="group" aria-label="How to pick the vendor" style={{ marginLeft: "auto" }}>
            <Link href={`${baseHref}${urgent ? "?rush=1" : ""}`} aria-current={mode === "cheapest" ? "true" : undefined}
              className={`btn sm${mode === "cheapest" ? " primary" : ""}`} style={{ textDecoration: "none" }}>Cheapest</Link>
            <Link href={`${baseHref}?buy=fastest${urgent ? "&rush=1" : ""}`} aria-current={mode === "fastest" ? "true" : undefined}
              className={`btn sm${mode === "fastest" ? " primary" : ""}`} style={{ textDecoration: "none" }}>Fastest</Link>
            <Link href={`${baseHref}${urgent ? (mode === "fastest" ? "?buy=fastest" : "") : `?${[mode === "fastest" ? "buy=fastest" : "", "rush=1"].filter(Boolean).join("&")}`}`}
              className={`btn sm${urgent ? " danger" : ""}`} style={{ textDecoration: "none" }}
              title="Only vendors who can overnight to the door">Urgent</Link>
          </span>
        )}
      </div>
      <div className="mut t-small" style={{ marginBottom: 10 }}>
        {mode === "fastest"
          ? "Vendors picked by door-to-door days (cross-dock counted when they can't drop-ship)."
          : "Priced from the cheapest vendor on file (OEM breaks ties)."}
        {urgent ? " Urgent: verified blind-shippers overnight to the door (1d); everyone else overnights to us and goes back out same day under our paperwork (2d)." : ""} Untick anything you don&apos;t want on the order.
      </div>

      {groups.map((g) => {
        const kept = g.lines.filter((l) => !skip.has(key(g.vendor, l.partNumber)));
        const priced = kept.filter((l) => l.unitCents !== null);
        const total = priced.reduce((n, l) => n + l.unitCents! * l.qty, 0);
        return (
          <div key={g.vendor || "__none"} style={{ borderTop: "1px solid var(--line)", padding: "8px 0" }}>
            <div className="row-2" style={{ alignItems: "baseline", marginBottom: 4 }}>
              <b className="t-body">{g.vendor || (urgent ? "Nobody on file can overnight these" : "No vendor priced")}</b>
              {priced.length > 0 && <span className="mut t-small">{formatCents(total)}</span>}
              {kept.length > priced.length && (
                <span className="mut t-meta">
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
                <label key={l.partNumber} className="row-2 t-small" style={{ alignItems: "baseline", padding: "3px 0", cursor: "pointer", opacity: on ? 1 : 0.45 }}>
                  <input type="checkbox" className="check" checked={on} onChange={() => toggle(g.vendor, l.partNumber)} />
                  <span className="mono" style={{ fontWeight: 700 }}>{l.partNumber}</span>
                  {l.name && <span>{l.name}</span>}
                  <span className="mut">× {l.qty}</span>
                  {l.unitCents !== null
                    ? <span className="mut">{formatCents(l.unitCents)} ea{l.isOem ? " · OEM" : ""}</span>
                    : <span style={{ color: "var(--t-warn-fg)" }}>no price on file</span>}
                </label>
              );
            })}
          </div>
        );
      })}
      {error && <div className="t-small" style={{ color: "var(--t-bad-fg)", marginTop: 8 }}>{error}</div>}
    </div>
  );
}
