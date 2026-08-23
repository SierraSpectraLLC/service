"use client";

import { useEffect, useMemo, useState, useTransition } from "react";
import Link from "next/link";
import { placePartsOrder } from "@/app/actions";
import { availabilityLabel, cartTotals, filterStore, splitCart, type CartLine, type StoreFacet, type StorePart } from "@/lib/store";
import { formatCents } from "@/lib/money";
import { toast } from "@/components/ui/Toast";
import { FacetStrip, Panel, Pill, Toolbar } from "@/components/ui";
import type { Tone } from "@/lib/tones";

export type OrderRow = {
  number: string; kind: "invoice" | "quote"; label: string; tone: Tone;
  totalCents: number; placedOn: string; token: string;
};

const CART_KEY = "ridgeline-store-cart";

/** The cart survives navigation, not failure: storage that throws is an empty cart. */
const loadCart = (): CartLine[] => {
  try {
    const raw = localStorage.getItem(CART_KEY);
    const parsed = raw ? (JSON.parse(raw) as CartLine[]) : [];
    return Array.isArray(parsed) ? parsed.filter((l) => l && l.partNumber && l.qty > 0) : [];
  } catch { return []; }
};
const saveCart = (cart: CartLine[]) => {
  try { localStorage.setItem(CART_KEY, JSON.stringify(cart)); } catch { /* per-tab nicety only */ }
};

/**
 * The client's parts store. Browse what the shop stocks and services - parts
 * that fit YOUR systems first - put them in a cart, place the order. Nothing
 * is charged here: the order lands with the shop, who confirm availability
 * and send the invoice with its pay link.
 */
export default function StoreFront({ items, orders, orgName, hasYours }: {
  items: StorePart[];
  orders: OrderRow[];
  orgName: string;
  /** Whether any part matched this client's own systems, for the facet. */
  hasYours: boolean;
}) {
  const [q, setQ] = useState("");
  const [facet, setFacet] = useState<StoreFacet>(hasYours ? "yours" : "all");
  const [cart, setCart] = useState<CartLine[]>([]);
  const [note, setNote] = useState("");
  const [placed, setPlaced] = useState<{ number?: string; quoteNumber?: string } | null>(null);
  const [error, setError] = useState("");
  const [pending, startTransition] = useTransition();

  useEffect(() => { setCart(loadCart()); }, []);
  const update = (next: CartLine[]) => { setCart(next); saveCart(next); };

  const shown = useMemo(() => filterStore(items, facet, q), [items, facet, q]);
  const totals = cartTotals(cart, items);
  const inCart = (pn: string) => cart.find((l) => l.partNumber.toLowerCase() === pn.toLowerCase());

  const add = (item: StorePart) => {
    const line = inCart(item.partNumber);
    update(line
      ? cart.map((l) => (l === line ? { ...l, qty: Math.min(999, l.qty + 1) } : l))
      : [...cart, { partNumber: item.partNumber, qty: 1 }]);
    toast({ message: `Added ${item.name}` });
  };
  const setQty = (pn: string, qty: number) =>
    update(qty <= 0
      ? cart.filter((l) => l.partNumber !== pn)
      : cart.map((l) => (l.partNumber === pn ? { ...l, qty: Math.min(999, qty) } : l)));

  const place = () => {
    setError("");
    startTransition(async () => {
      const res = await placePartsOrder(cart, note);
      if (res.error || (!res.number && !res.quoteNumber)) {
        setError(res.error ?? "That didn't go through"); return;
      }
      setPlaced({ number: res.number, quoteNumber: res.quoteNumber });
      setNote("");
      update([]);
    });
  };

  const FACETS: { key: StoreFacet; label: string }[] = [
    ...(hasYours ? [{ key: "yours" as const, label: "For your systems" }] : []),
    { key: "all", label: "Everything" },
    { key: "consumable", label: "Consumables" },
    { key: "kit", label: "Kits" },
  ];

  return (
    <div style={{ display: "flex", gap: 14, alignItems: "flex-start", flexWrap: "wrap" }}>
      <div style={{ flex: "1 1 560px", minWidth: 0 }}>
        <Toolbar
          search={
            <input value={q} onChange={(e) => setQ(e.target.value)}
              placeholder="Part number, name or maker" aria-label="Search parts" />
          }
          facets={
            <FacetStrip facets={FACETS.map((f) => ({
              key: f.key, label: f.label,
              count: filterStore(items, f.key, q).length || undefined,
              on: facet === f.key,
            }))} onToggle={(k) => setFacet(k as StoreFacet)} />
          }
        />

        <div className="cardgrid">
          {shown.map((i) => {
            const line = inCart(i.partNumber);
            return (
              <div key={i.id} className="card" style={{ marginBottom: 0, display: "flex", flexDirection: "column" }}>
                {i.photoUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={i.photoUrl} alt={i.name}
                    style={{ width: "100%", height: 120, objectFit: "cover", borderRadius: 8, background: "#F7F9FC", marginBottom: 8 }} />
                ) : (
                  <div aria-hidden style={{ width: "100%", height: 120, borderRadius: 8, background: "#F7F9FC", border: "1px dashed var(--line)", marginBottom: 8, display: "flex", alignItems: "center", justifyContent: "center" }}>
                    <span className="mut t-meta">{i.manufacturer || "part"}</span>
                  </div>
                )}
                <div className="mut t-meta">{i.manufacturer}</div>
                <div className="t-body" style={{ fontWeight: 700 }}>{i.name}</div>
                <div className="mono t-meta" style={{ color: "var(--slate)" }}>{i.partNumber}</div>
                {i.fitsLabel && (
                  <div className={`t-meta ${i.fitsYours ? "" : "mut"}`}
                    style={i.fitsYours ? { color: "var(--t-good-fg)" } : undefined}>
                    {i.fitsYours ? "Fits your equipment" : i.fitsLabel}
                  </div>
                )}
                <div className="t-meta" style={{ marginTop: 2 }}>
                  {i.inStock
                    ? <span className="pill good">In stock - ships now</span>
                    : <span className="mut">{availabilityLabel(i)}</span>}
                </div>
                <div className="row-2" style={{ marginTop: "auto", paddingTop: 8, alignItems: "center" }}>
                  <b className="t-body">{i.priceCents !== null ? formatCents(i.priceCents) : <span className="mut" style={{ fontWeight: 400 }}>Priced on request</span>}</b>
                  <span className="sp" />
                  {line ? (
                    <span className="row-2" style={{ alignItems: "center", gap: 4 }}>
                      <button className="btn sm" aria-label={`One less ${i.name}`} onClick={() => setQty(line.partNumber, line.qty - 1)}>−</button>
                      <b className="t-body" style={{ minWidth: 20, textAlign: "center" }}>{line.qty}</b>
                      <button className="btn sm" aria-label={`One more ${i.name}`} onClick={() => setQty(line.partNumber, line.qty + 1)}>+</button>
                    </span>
                  ) : (
                    <button className="btn sm accent" onClick={() => add(i)}>Add</button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
        {shown.length === 0 && <div className="empty"><b>Nothing matches.</b></div>}

        <Panel title="Your orders" count={orders.length} empty="Nothing ordered yet.">
          {orders.length > 0 && orders.map((o) => (
            <div key={o.number} className="row-2" style={{ alignItems: "baseline", padding: "6px 0", borderTop: "1px solid var(--line)" }}>
              <span className="mono t-body" style={{ fontWeight: 700 }}>{o.number}</span>
              <Pill tone={o.tone}>{o.label}</Pill>
              <span className="mut t-small">{o.placedOn}</span>
              <span className="sp" />
              <b className="t-body">{formatCents(o.totalCents)}</b>
              {o.token && (
                <Link className="btn sm" href={`/share/${o.token}`} style={{ textDecoration: "none" }}>
                  {o.kind === "quote" ? "Review / approve" : "View / pay"}
                </Link>
              )}
            </div>
          ))}
        </Panel>
      </div>

      <div className="card" style={{ flex: "0 1 300px", minWidth: 260, position: "sticky", top: 70 }}>
        <div className="card-title" style={{ marginBottom: 8 }}>Cart{totals.count > 0 ? ` · ${totals.count}` : ""}</div>
        {placed && (
          <div className="t-body" style={{ marginBottom: 10 }}>
            {placed.number && (
              <div>Order <b className="mono">{placed.number}</b> placed for the in-stock items -
                the invoice follows shortly.</div>
            )}
            {placed.quoteNumber && (
              <div style={{ marginTop: placed.number ? 6 : 0 }}>
                Quote <b className="mono">{placed.quoteNumber}</b> opened for the items we source
                to order - you approve it before anything moves.</div>
            )}
            <div className="mut t-meta" style={{ marginTop: 6 }}>
              Nothing is charged now, and no card is on file to charge.
            </div>
          </div>
        )}
        {cart.length === 0 && !placed && <div className="mut t-body">Nothing in it yet.</div>}
        {(() => {
          const { now, quoted } = splitCart(cart, items);
          const row = (l: CartLine) => {
            const item = items.find((i) => i.partNumber.toLowerCase() === l.partNumber.toLowerCase());
            if (!item) return null;
            return (
              <div key={l.partNumber} className="row-2" style={{ alignItems: "baseline", padding: "5px 0", borderTop: "1px solid var(--line)" }}>
                <span className="t-small" style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{item.name}</span>
                <span className="mut t-small">× {l.qty}</span>
                <span className="t-small" style={{ width: 70, textAlign: "right" }}>
                  {item.priceCents !== null ? formatCents(item.priceCents * l.qty) : "TBD"}
                </span>
                <button className="btn link t-meta" style={{ color: "var(--t-bad-fg)" }}
                  aria-label={`Remove ${item.name}`} onClick={() => setQty(l.partNumber, 0)}>×</button>
              </div>
            );
          };
          return (
            <>
              {now.length > 0 && (
                <>
                  <div className="t-meta" style={{ color: "var(--t-good-fg)", marginTop: 2 }}>Ships now</div>
                  {now.map(row)}
                </>
              )}
              {quoted.length > 0 && (
                <>
                  <div className="mut t-meta" style={{ marginTop: now.length ? 8 : 2 }}>
                    Quoted first - sourced to order, you approve before anything moves
                  </div>
                  {quoted.map(row)}
                </>
              )}
            </>
          );
        })()}
        {cart.length > 0 && (
          <>
            <div className="row-2" style={{ alignItems: "baseline", padding: "8px 0 0", borderTop: "2px solid var(--line)" }}>
              <span className="t-body" style={{ fontWeight: 700, flex: 1 }}>Subtotal</span>
              <b className="t-body">{formatCents(totals.subtotalCents)}</b>
            </div>
            {totals.unpriced > 0 && (
              <div className="mut t-meta">plus {totals.unpriced} line{totals.unpriced === 1 ? "" : "s"} priced on request</div>
            )}
            <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Anything we should know? (optional)"
              className="t-small" style={{ margin: "8px 0" }} aria-label="Order note" />
            <button className="btn accent" style={{ width: "100%" }} disabled={pending} onClick={place}>
              {pending ? "Placing..." : (() => {
                const { now, quoted } = splitCart(cart, items);
                return now.length && quoted.length ? "Place order + request quote"
                  : quoted.length ? "Request quote" : "Place order";
              })()}
            </button>
            <div className="mut t-meta" style={{ marginTop: 6 }}>
              We confirm availability, then send the invoice with its payment link. Nothing is charged now.
            </div>
          </>
        )}
        {error && <div className="t-small" style={{ color: "var(--t-bad-fg)", marginTop: 6 }}>{error}</div>}
      </div>
    </div>
  );
}
