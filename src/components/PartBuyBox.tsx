"use client";

import { useState } from "react";
import Link from "next/link";
import { addToCart, loadCart } from "@/lib/storeCart";
import { availabilityHint, availabilityLabel, availabilityOf, hasChoice, linePrice, sourceTag, type StorePart } from "@/lib/store";
import { formatCents } from "@/lib/money";
import { toast } from "@/components/ui/Toast";
import { Dot } from "@/components/ui";

const AVAIL_TONE = { now: "good", sourced: "info", special: "warn" } as const;

/**
 * The part page's one control: how it ships, what class, how many, and add.
 * It writes the same cart the shelf's rows do (lib/storeCart), so a part put
 * in here is in the cart waiting when they get back to the shelf.
 */
export default function PartBuyBox({ item, termsDays }: {
  item: StorePart;
  termsDays: number;
}) {
  const [source, setSource] = useState<"oem" | "alt" | undefined>(hasChoice(item) ? "oem" : undefined);
  const [qty, setQty] = useState(1);
  const [added, setAdded] = useState(0);
  const a = availabilityOf(item);
  const cents = linePrice(item, source);

  const add = () => {
    addToCart(loadCart(), item.partNumber, qty, source);
    setAdded((n) => n + qty);
    toast({ message: `Added ${qty > 1 ? `${qty} × ` : ""}${item.name}` });
    setQty(1);
  };

  return (
    <div className="card">
      <div className="row-2" style={{ gap: 5, alignItems: "center", marginBottom: 8 }}>
        <Dot tone={AVAIL_TONE[a]} />
        <span className="t-body" style={{ fontWeight: 700 }}>{availabilityLabel(item)}</span>
        {availabilityHint(item) && <span className="mut t-small">{availabilityHint(item)}</span>}
      </div>

      {hasChoice(item) ? (
        <>
          <label>Which one</label>
          <span className="seg" role="group" aria-label="Class" style={{ marginBottom: 10 }}>
            <button type="button" aria-pressed={source === "oem"} onClick={() => setSource("oem")}>
              Genuine {item.manufacturer} <b className="mono">{formatCents(item.oemCents!)}</b>
            </button>
            <button type="button" aria-pressed={source === "alt"} onClick={() => setSource("alt")}>
              OEM-equivalent <b className="mono">{formatCents(item.altCents!)}</b>
            </button>
          </span>
        </>
      ) : (
        <div style={{ marginBottom: 10 }}>
          {cents !== null
            ? <b className="mono t-page">{formatCents(cents)}</b>
            : <span className="mut t-lead">Quote on request</span>}
          {sourceTag(item) && <div className="mut t-meta">{sourceTag(item)}</div>}
        </div>
      )}

      <div className="row-2" style={{ alignItems: "center", gap: 8 }}>
        <span className="row-2" style={{ alignItems: "center", gap: 0, border: "1px solid var(--line)", borderRadius: 8, overflow: "hidden" }}>
          <button className="btn link" style={{ width: 30, textAlign: "center" }} aria-label="One less"
            onClick={() => setQty((n) => Math.max(1, n - 1))}>−</button>
          <b className="mono t-body" style={{ width: 30, textAlign: "center" }}>{qty}</b>
          <button className="btn link" style={{ width: 30, textAlign: "center" }} aria-label="One more"
            onClick={() => setQty((n) => Math.min(999, n + 1))}>+</button>
        </span>
        <button className={`btn ${cents !== null ? "accent" : ""}`} onClick={add} style={{ flex: 1 }}>
          {cents !== null ? `Add · ${formatCents(cents * qty)}` : "Add to quote"}
        </button>
      </div>

      {added > 0 && (
        <div className="t-small" style={{ marginTop: 8 }}>
          {added} in your cart · <Link href="/store">back to parts</Link> to check out.
        </div>
      )}
      <div className="mut t-meta" style={{ marginTop: 8 }}>
        {a === "special"
          ? "We confirm price and lead time, and you approve before anything moves."
          : `Nothing is charged until it ships. Net ${termsDays} on your account.`}
      </div>
    </div>
  );
}
