"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { setPoShipping } from "@/app/actions";
import { toast } from "@/components/ui/Toast";
import { blindShipNote } from "@/lib/sourcing";

export type ShipSite = { id: number; label: string };

/**
 * Where this order lands: our shelf, or drop-shipped to a client site under
 * the parts brand's paperwork. The blind-ship instruction renders here, word
 * for word, whenever a site is set - it goes to the vendor with the order,
 * and it is why the box that arrives says Ridgeline and not the supplier.
 */
export default function PoShippingCard({ poId, editable, shipToSiteId, urgent, sites, brand }: {
  poId: number;
  /** Drafts only - a sent order's routing is a phone call, not a field. */
  editable: boolean;
  shipToSiteId: number | null;
  urgent: boolean;
  /** Client sites this order may ship to, labeled "Org - Site". */
  sites: ShipSite[];
  /** The name on the packing slip (Settings > Billing, parts brand). */
  brand: string;
}) {
  const router = useRouter();
  const [siteId, setSiteId] = useState(shipToSiteId);
  const [rush, setRush] = useState(urgent);
  const [error, setError] = useState("");
  const [pending, startTransition] = useTransition();

  const dirty = siteId !== shipToSiteId || rush !== urgent;
  const site = sites.find((s) => s.id === siteId) ?? null;
  const shownSite = sites.find((s) => s.id === shipToSiteId) ?? null;

  const save = () => {
    setError("");
    startTransition(async () => {
      const res = await setPoShipping(poId, { shipToSiteId: siteId, urgent: rush });
      if (res?.error) { setError(res.error); return; }
      toast({ message: siteId !== null ? "Set to drop-ship" : "Ships to the stockroom" });
      router.refresh();
    });
  };

  if (!editable && shipToSiteId === null && !urgent) return null;

  return (
    <div className="card">
      <div className="card-title" style={{ marginBottom: 8 }}>Shipping</div>
      {editable ? (
        <div className="row-2" style={{ alignItems: "center", flexWrap: "wrap" }}>
          <select className="t-body" value={siteId ?? ""} aria-label="Where the vendor ships"
            onChange={(e) => setSiteId(parseInt(e.target.value) || null)} style={{ width: "auto" }}>
            <option value="">To our stockroom</option>
            {sites.map((s) => <option key={s.id} value={s.id}>Drop-ship: {s.label}</option>)}
          </select>
          <label className="t-small" style={{ display: "flex", alignItems: "center", gap: 6, margin: 0 }}>
            <input type="checkbox" checked={rush} style={{ width: 15, height: 15 }}
              onChange={(e) => setRush(e.target.checked)} />
            Urgent - overnight it
          </label>
          {dirty && (
            <button className="btn sm accent" onClick={save} disabled={pending}>
              {pending ? "Saving..." : "Save shipping"}
            </button>
          )}
        </div>
      ) : (
        <div className="t-body">
          {shownSite ? `Drop-ship to ${shownSite.label}` : "To our stockroom"}
          {urgent && <span className="pill bad" style={{ marginLeft: 8 }}>urgent</span>}
        </div>
      )}
      {(editable ? site : shownSite) && (
        <div className="t-small" style={{
          marginTop: 8, padding: "8px 10px", border: "1px solid var(--line)",
          borderRadius: 8, background: "#FAFBFD",
        }}>
          <div className="mut t-meta" style={{ marginBottom: 3 }}>Goes to the vendor with the order:</div>
          {blindShipNote(brand, (editable ? site : shownSite)!.label)}
          {(editable ? rush : urgent) ? " Ship overnight." : ""}
        </div>
      )}
      {(editable ? rush && siteId === null : urgent && shipToSiteId === null) && (
        <div className="t-small" style={{
          marginTop: 8, padding: "8px 10px", border: "1px solid var(--line)",
          borderRadius: 8, background: "#FAFBFD",
        }}>
          <div className="mut t-meta" style={{ marginBottom: 3 }}>Goes to the vendor with the order:</div>
          Ship overnight to our dock. It turns around the same day under {brand} paperwork.
        </div>
      )}
      {error && <div className="t-small" style={{ color: "var(--t-bad-fg)", marginTop: 6 }}>{error}</div>}
    </div>
  );
}
