"use client";

import { useEffect, useMemo, useState, useTransition } from "react";
import Link from "next/link";
import { placePartsOrder } from "@/app/actions";
import {
  availabilityHint, availabilityLabel, availabilityOf, bucketTotals, filterStore, hasChoice,
  linePrice, sourceTag, splitCart, type CartLine, type StoreFacet, type StorePart,
} from "@/lib/store";
import { formatCents } from "@/lib/money";
import { toast } from "@/components/ui/Toast";
import { Dot, FacetStrip, Toolbar } from "@/components/ui";

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

const AVAIL_TONE = { now: "good", sourced: "info", special: "warn" } as const;

/**
 * The client's parts store: dense SKU rows, one add-with-variant control per
 * part, and a cart that says honestly which lane each line travels - ships
 * today, sourced then invoiced at ship, or quoted first. Nothing is charged
 * here and no card exists to charge; invoices and quotes ride the same rails
 * as the rest of the client's money.
 */
export default function StoreFront({ items, orgName, hasYours, termsDays }: {
  items: StorePart[];
  orgName: string;
  /** Whether any part matched this client's own systems, for the facet. */
  hasYours: boolean;
  /** The org's payment terms, for the cart's footer sentence. */
  termsDays: number;
}) {
  const [q, setQ] = useState("");
  const [facet, setFacet] = useState<StoreFacet>(hasYours ? "yours" : "all");
  const [cart, setCart] = useState<CartLine[]>([]);
  // Per-row purchase draft: the class picked and the quantity, before Add.
  const [draft, setDraft] = useState<Record<number, { source?: "oem" | "alt"; qty: number }>>({});
  const [note, setNote] = useState("");
  const [placed, setPlaced] = useState<{ number?: string; quoteNumber?: string } | null>(null);
  const [error, setError] = useState("");
  const [pending, startTransition] = useTransition();

  useEffect(() => { setCart(loadCart()); }, []);
  const update = (next: CartLine[]) => { setCart(next); saveCart(next); };

  const shown = useMemo(() => filterStore(items, facet, q), [items, facet, q]);
  const totals = bucketTotals(cart, items);
  const buckets = splitCart(cart, items);

  const draftFor = (i: StorePart) =>
    draft[i.id] ?? { qty: 1, source: hasChoice(i) ? ("oem" as const) : undefined };
  const setRow = (i: StorePart, patch: Partial<{ source?: "oem" | "alt"; qty: number }>) =>
    setDraft((d) => ({ ...d, [i.id]: { ...draftFor(i), ...patch } }));

  const same = (l: CartLine, pn: string, source?: "oem" | "alt") =>
    l.partNumber.toLowerCase() === pn.toLowerCase() && (l.source ?? "") === (source ?? "");

  const add = (item: StorePart) => {
    const d = draftFor(item);
    const source = hasChoice(item) ? d.source : undefined;
    const line = cart.find((l) => same(l, item.partNumber, source));
    update(line
      ? cart.map((l) => (l === line ? { ...l, qty: Math.min(999, l.qty + d.qty) } : l))
      : [...cart, { partNumber: item.partNumber, qty: d.qty, ...(source ? { source } : {}) }]);
    setRow(item, { qty: 1 });
    toast({ message: `Added ${item.name}${source ? ` (${source === "oem" ? "genuine" : "equivalent"})` : ""}` });
  };
  const removeLine = (l: CartLine) => update(cart.filter((x) => x !== l));

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

  const qtyControl = (value: number, set: (n: number) => void, label: string) => (
    <span className="row-2" style={{ alignItems: "center", gap: 0, border: "1px solid var(--line)", borderRadius: 8, overflow: "hidden" }}>
      <button className="btn link" style={{ width: 26, textAlign: "center" }} aria-label={`One less ${label}`}
        onClick={() => set(Math.max(1, value - 1))}>−</button>
      <b className="mono t-small" style={{ width: 26, textAlign: "center" }}>{value}</b>
      <button className="btn link" style={{ width: 26, textAlign: "center" }} aria-label={`One more ${label}`}
        onClick={() => set(Math.min(999, value + 1))}>+</button>
    </span>
  );

  const cartRow = (l: CartLine) => {
    const item = items.find((i) => i.partNumber.toLowerCase() === l.partNumber.toLowerCase());
    if (!item) return null;
    const cents = linePrice(item, l.source);
    return (
      <div key={`${l.partNumber}|${l.source ?? ""}`} className="row-2" style={{ alignItems: "baseline", padding: "5px 0", borderTop: "1px solid var(--line)" }}>
        <span style={{ flex: 1, minWidth: 0 }}>
          <span className="t-small" style={{ display: "block", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {item.name}{l.qty > 1 ? ` ×${l.qty}` : ""}
          </span>
          {sourceTag(item, l.source) && <span className="mut t-meta">{sourceTag(item, l.source)}</span>}
        </span>
        <span className="mono t-small" style={{ width: 74, textAlign: "right" }}>
          {cents !== null ? formatCents(cents * l.qty) : "quote"}
        </span>
        <button className="btn link t-meta" style={{ color: "var(--t-bad-fg)" }}
          aria-label={`Remove ${item.name}`} onClick={() => removeLine(l)}>×</button>
      </div>
    );
  };

  return (
    <div style={{ display: "flex", gap: 14, alignItems: "flex-start", flexWrap: "wrap" }}>
      <div style={{ flex: "1 1 640px", minWidth: 0 }}>
        <Toolbar
          search={
            <input value={q} onChange={(e) => setQ(e.target.value)}
              placeholder="Part number, name, maker or instrument" aria-label="Search parts" />
          }
          facets={
            <FacetStrip facets={FACETS.map((f) => ({
              key: f.key, label: f.label,
              count: filterStore(items, f.key, q).length || undefined,
              on: facet === f.key,
            }))} onToggle={(k) => setFacet(k as StoreFacet)} />
          }
        />

        <div className="card" style={{ padding: 0, overflow: "hidden" }}>
          {shown.map((i, n) => {
            const d = draftFor(i);
            const a = availabilityOf(i);
            const chosenCents = hasChoice(i) ? linePrice(i, d.source) : i.priceCents;
            return (
              <div key={i.id} style={{
                display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap",
                padding: "12px 14px", borderTop: n === 0 ? "none" : "1px solid var(--line)",
              }}>
                {i.photoUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={i.photoUrl} alt="" style={{ width: 56, height: 56, objectFit: "cover", borderRadius: 8, background: "#F7F9FC", flexShrink: 0 }} />
                ) : (
                  <div aria-hidden style={{ width: 56, height: 56, borderRadius: 8, background: "#F7F9FC", border: "1px dashed var(--line)", flexShrink: 0 }} />
                )}
                <div style={{ flex: "1 1 200px", minWidth: 160 }}>
                  <div className="mut t-meta" style={{ textTransform: "uppercase", letterSpacing: ".06em", fontWeight: 700 }}>{i.manufacturer}</div>
                  <div className="t-body" style={{ fontWeight: 700 }}>{i.name}</div>
                  <div className="mut t-meta">
                    <span className="mono">{i.partNumber}</span>
                    {i.fitsLabel && <> · <span style={i.fitsYours ? { color: "var(--t-good-fg)" } : undefined}>{i.fitsLabel}</span></>}
                  </div>
                </div>
                <div style={{ flex: "0 1 170px", minWidth: 140 }}>
                  <span className="row-2" style={{ gap: 5, alignItems: "center" }}>
                    <Dot tone={AVAIL_TONE[a]} />
                    <span className="t-meta" style={{ fontWeight: 700 }}>{availabilityLabel(i)}</span>
                  </span>
                  {availabilityHint(i) && <div className="mut t-meta">{availabilityHint(i)}</div>}
                </div>
                <div style={{ flex: "0 0 auto", display: "flex", flexDirection: "column", gap: 6, alignItems: "flex-end" }}>
                  {hasChoice(i) ? (
                    <span className="seg" role="group" aria-label={`Class for ${i.name}`}>
                      <button type="button" aria-pressed={d.source === "oem"} onClick={() => setRow(i, { source: "oem" })}>
                        Genuine <b className="mono">{formatCents(i.oemCents!)}</b>
                      </button>
                      <button type="button" aria-pressed={d.source === "alt"} onClick={() => setRow(i, { source: "alt" })}>
                        OEM-eq <b className="mono">{formatCents(i.altCents!)}</b>
                      </button>
                    </span>
                  ) : (
                    <span style={{ textAlign: "right" }}>
                      {i.priceCents !== null
                        ? <b className="mono t-body">{formatCents(i.priceCents)}</b>
                        : <span className="mut t-small">quote on request</span>}
                      {sourceTag(i) && <span className="mut t-meta" style={{ display: "block" }}>{sourceTag(i)}</span>}
                    </span>
                  )}
                  <span className="row-2" style={{ gap: 8, alignItems: "center" }}>
                    {qtyControl(d.qty, (qty) => setRow(i, { qty }), i.name)}
                    <button className={`btn sm ${chosenCents !== null ? "primary" : ""}`} onClick={() => add(i)}>
                      {chosenCents !== null ? `Add · ${formatCents(chosenCents * d.qty)}` : "Add to quote"}
                    </button>
                  </span>
                </div>
              </div>
            );
          })}
          {shown.length === 0 && <div className="empty" style={{ border: 0 }}><b>Nothing matches.</b></div>}
        </div>
        <div className="row-2 mut t-meta" style={{ gap: 14, flexWrap: "wrap" }}>
          <span className="row-2" style={{ gap: 5 }}><Dot tone="good" />ships from our stock today</span>
          <span className="row-2" style={{ gap: 5 }}><Dot tone="info" />sourced · invoiced at ship</span>
          <span className="row-2" style={{ gap: 5 }}><Dot tone="warn" />special order · quoted first</span>
        </div>
      </div>

      <div className="card" style={{ flex: "0 1 300px", minWidth: 260, position: "sticky", top: 70 }}>
        <div className="card-title" style={{ marginBottom: 8 }}>Cart{totals.count > 0 ? ` · ${totals.count}` : ""}</div>
        {placed && (
          <div className="t-body" style={{ marginBottom: 10 }}>
            {placed.number && (
              <div>Order <b className="mono">{placed.number}</b> placed - see <Link href="/orders">Orders</Link> for its progress.</div>
            )}
            {placed.quoteNumber && (
              <div style={{ marginTop: placed.number ? 6 : 0 }}>
                Quote <b className="mono">{placed.quoteNumber}</b> opened - you approve it before anything moves.</div>
            )}
            <div className="mut t-meta" style={{ marginTop: 6 }}>
              Nothing is charged now, and no card is on file to charge.
            </div>
          </div>
        )}
        {cart.length === 0 && !placed && <div className="mut t-body">Nothing in it yet.</div>}
        {buckets.now.length > 0 && (
          <>
            <div className="t-meta" style={{ color: "var(--t-good-fg)", fontWeight: 700, marginTop: 2 }}>Ships today</div>
            {buckets.now.map(cartRow)}
          </>
        )}
        {buckets.sourced.length > 0 && (
          <>
            <div className="t-meta" style={{ color: "var(--t-info-fg)", fontWeight: 700, marginTop: buckets.now.length ? 8 : 2 }}>
              Sourced, invoiced at ship
            </div>
            {buckets.sourced.map(cartRow)}
          </>
        )}
        {buckets.quoted.length > 0 && (
          <>
            <div className="t-meta" style={{ color: "var(--t-warn-fg)", fontWeight: 700, marginTop: buckets.now.length || buckets.sourced.length ? 8 : 2 }}>
              Quoted first - nothing moves until you approve
            </div>
            {buckets.quoted.map(cartRow)}
          </>
        )}
        {cart.length > 0 && (
          <>
            {totals.nowCents > 0 && (
              <div className="row-2" style={{ alignItems: "baseline", padding: "8px 0 0", borderTop: "1px solid var(--line)", marginTop: 8 }}>
                <span className="t-small" style={{ flex: 1 }}>Ships now</span>
                <b className="mono t-small">{formatCents(totals.nowCents)}</b>
              </div>
            )}
            {totals.sourcedCents > 0 && (
              <div className="row-2" style={{ alignItems: "baseline", padding: "3px 0 0" }}>
                <span className="t-small" style={{ flex: 1 }}>Sourced, invoiced at ship</span>
                <b className="mono t-small">{formatCents(totals.sourcedCents)}</b>
              </div>
            )}
            <div className="row-2" style={{ alignItems: "baseline", padding: "8px 0 0", borderTop: "2px solid var(--line)", marginTop: 6 }}>
              <span className="t-body" style={{ fontWeight: 800, flex: 1 }}>Total</span>
              <b className="mono t-body">{formatCents(totals.nowCents + totals.sourcedCents)}
                {totals.quotedLines > 0 && <span className="mut t-meta" style={{ fontFamily: "inherit" }}> + {totals.quotedLines} quote{totals.quotedLines === 1 ? "" : "s"}</span>}
              </b>
            </div>
            <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Anything we should know? (optional)"
              className="t-small" style={{ margin: "8px 0" }} aria-label="Order note" />
            <button className="btn accent" style={{ width: "100%" }} disabled={pending} onClick={place}>
              {pending ? "Placing..." : totals.quotedLines && (buckets.now.length || buckets.sourced.length)
                ? "Place order + request quote"
                : totals.quotedLines ? "Request quote" : "Place order"}
            </button>
            <div className="mut t-meta" style={{ marginTop: 6, textAlign: "center" }}>
              Nothing is charged until it ships. Net {termsDays} on {orgName}&apos;s account.
            </div>
          </>
        )}
        {error && <div className="t-small" style={{ color: "var(--t-bad-fg)", marginTop: 6 }}>{error}</div>}
      </div>
    </div>
  );
}
