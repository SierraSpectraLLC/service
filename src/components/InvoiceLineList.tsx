"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { confirmReason } from "@/components/ui/ConfirmDialog";
import { toast } from "@/components/ui/Toast";
import {
  addInvoiceLine, addQuoteLine, removeInvoiceLine, removeQuoteLine,
  setInvoiceLineDescription, setQuoteLineDescription,
} from "@/app/actions";
import { descriptionLines } from "@/lib/billing";
import { formatCents } from "@/lib/money";
import {
  CATALOG_KINDS, lineKindFor, quotedUnitCents, unitFor,
} from "@/lib/partCatalog";
import PartNumberField, { type LookupPart } from "@/components/PartNumberField";
import NewPartButton from "@/components/NewPartButton";
import InlineEdit from "@/components/ui/InlineEdit";
import { Panel } from "@/components/ui";

export type Line = {
  id: number; kind: string; description: string; detail: string;
  qty: number; unitCents: number; covered: boolean; coveredBy: string;
  /** The catalogued number this was quoted off, when it came off one. */
  partNumber?: string;
  /** What one of them is - "h", "trip". Blank reads off the kind, as before. */
  unit?: string;
};

/** Whose lines these are, for the add and remove actions. */
export type LineTarget = { kind: "invoice" | "quote"; id: number };

const KIND_LABEL: Record<string, string> = {
  part: "Part", labor: "Labor", travel: "Travel",
  expense: "Expense", tax: "Tax", fee_ref: "Charge", retainer: "Retainer",
};

/** The kinds somebody may type in by hand; tax and fee rows come from the system. */
const MANUAL_KINDS = ["part", "labor", "travel", "expense"] as const;

/**
 * Hours read as hours; a count of things reads as a count.
 *
 * The line's own unit wins where it has one. Reading it off the KIND alone is
 * what had a flat travel charge - a zone-3 overnight, quoted per trip - print
 * as "1 h", because every travel line was assumed to be a drive. Lines written
 * before units existed have none, and read exactly as they always did.
 */
const qtyLabel = (l: Line) => {
  const unit = (l.unit ?? "").trim() || (l.kind === "labor" || l.kind === "travel" ? "h" : "");
  if (unit) return `${l.qty} ${unit}`;
  return l.qty === 1 ? "" : `${l.qty}`;
};

const emptyDraft = {
  kind: "part", partNumber: "", description: "", qty: "1", price: "", unit: "",
};

/**
 * What is being charged for, and what the contract absorbed.
 *
 * A covered line keeps its real quantity and its list price and prices out at
 * zero. That is the whole argument for sending a $0 invoice: the client reads
 * what the retainer just paid for instead of receiving nothing at all.
 *
 * On a draft with a target, lines can also be typed in by hand - that is how
 * an invoice or quote with no job behind it gets its content.
 */
export default function InvoiceLineList({
  lines, totalCents, editable, target, partsMarkupBps = 0, discount,
}: {
  lines: Line[];
  /** What is owed - the lines less any discount. See lib/quotes.netCents. */
  totalCents: number;
  editable: boolean;
  /** Set on drafts to enable add and remove. Absent = read-only history. */
  target?: LineTarget;
  /**
   * The workspace's markup on parts, so a picked part arrives priced the way
   * an invoice would price it - lib/billing's sellPrice, the one formula.
   * Zero means cost, which is what a shop that has set no markup charges.
   */
  partsMarkupBps?: number;
  /**
   * Money off, when there is any. Given rather than computed here so the
   * subtotal, the discount and the total on screen are the same three numbers
   * the client's copy and the spreadsheet carry - lib/quotes decides them.
   */
  discount?: { label: string; cents: number };
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [draft, setDraft] = useState(emptyDraft);
  const [error, setError] = useState("");
  const coveredCents = lines
    .filter((l) => l.covered)
    .reduce((n, l) => n + Math.round(l.qty * l.unitCents), 0);

  const canEdit = editable && target !== undefined;

  const reword = (l: Line, description: string) => {
    if (!target) return;
    startTransition(async () => {
      const res = target.kind === "invoice"
        ? await setInvoiceLineDescription(l.id, description)
        : await setQuoteLineDescription(l.id, description);
      if (res.error) { toast({ message: res.error, tone: "bad" }); return; }
      router.refresh();
    });
  };

  const remove = async (l: Line) => {
    if (!target) return;
    const why = await confirmReason({
      title: "Remove this line?",
      context: l.description,
      body: target.kind === "invoice"
        ? "Sent invoices keep their lines - use a credit instead."
        : "Sent quotes keep their lines.",
      action: "Remove line",
      tone: "bad",
    });
    if (!why) return;
    startTransition(async () => {
      const res = target.kind === "invoice"
        ? await removeInvoiceLine(l.id, why)
        : await removeQuoteLine(l.id, why);
      if (res.error) { toast({ message: res.error, tone: "bad" }); return; }
      toast({ message: "Removed the line" });
      router.refresh();
    });
  };

  /**
   * A catalog row, taken as a line.
   *
   * The number, what it is, what kind of charge it is and what it sells for,
   * all off one pick - which is the whole point of a book of numbers. The
   * price is only FILLED IN, never enforced: a quote is where a shop discounts,
   * and a rate typed over is a decision somebody made on this job.
   */
  const takePart = (part: LookupPart) => setDraft((d) => {
    const price = quotedUnitCents(part, partsMarkupBps);
    return {
      ...d,
      kind: lineKindFor(part.kind),
      partNumber: part.partNumber,
      description: part.name || part.partNumber,
      unit: unitFor(part),
      // A price already typed is somebody's decision; a $0 code has nothing to
      // say. Neither is worth overwriting with the other.
      price: price > 0 && !d.price.trim() ? (price / 100).toFixed(2) : d.price,
    };
  });

  const add = () => {
    if (!target || !draft.description.trim()) return;
    const qty = Number(draft.qty);
    const price = Number(draft.price);
    if (!Number.isFinite(qty) || qty <= 0) { setError("Quantity must be above zero"); return; }
    if (!Number.isFinite(price) || price < 0) { setError("Give it a price - 0 is fine"); return; }
    setError("");
    const line = {
      kind: draft.kind, description: draft.description,
      partNumber: draft.partNumber, unit: draft.unit,
      qty, unitCents: Math.round(price * 100),
    };
    startTransition(async () => {
      const res = target.kind === "invoice"
        ? await addInvoiceLine(target.id, line)
        : await addQuoteLine(target.id, line);
      if (res.error) { setError(res.error); return; }
      toast({ message: `Added ${draft.description.trim()}` });
      setDraft(emptyDraft);
      router.refresh();
    });
  };

  return (
    <Panel
      title="Lines"
      count={lines.length}
      hint={coveredCents > 0 ? `${formatCents(coveredCents)} covered at $0` : undefined}
      empty="No lines."
    >
      {(lines.length > 0 || canEdit) && <>
      {lines.length > 0 && (
        <>
          {lines.map((l) => (
            <div key={l.id} className="row-2" style={{ alignItems: "baseline", padding: "7px 0", borderTop: "1px solid var(--line)" }}>
              <span className="pill neutral">{KIND_LABEL[l.kind] ?? l.kind}</span>
              <span style={{ flex: 1, minWidth: 0 }}>
                {/* The number leads, where there is one. It is what the client's
                    purchasing system matches on and what the shop reorders by,
                    and it used to be glued into the description or lost. */}
                {l.partNumber && (
                  <span className="mono t-small" style={{ fontWeight: 700, color: "var(--navy)", marginRight: 8 }}>
                    {l.partNumber}
                  </span>
                )}
                {/* One charge, several sentences: the thing on top and what is
                    inside it under it. Editable in place on a draft, because a
                    module list is exactly the sort of prose that gets revised
                    twice before the quote goes out. */}
                {canEdit ? (
                  <span className="t-body" style={{ fontWeight: 600 }}>
                    <InlineEdit multiline value={l.description} label="line description"
                      onSave={(next) => reword(l, next)} />
                  </span>
                ) : (
                  <>
                    <span className="t-body" style={{ fontWeight: 600 }}>{descriptionLines(l.description).head}</span>
                    {descriptionLines(l.description).rest.map((r, i) => (
                      <span key={i} className="mut t-meta"
                        style={{ display: "block", paddingLeft: 12, fontStyle: "italic" }}>
                        {r}
                      </span>
                    ))}
                  </>
                )}
                {(l.detail || l.covered) && (
                  <span className="mut t-meta" style={{ display: "block" }}>
                    {l.detail}
                    {l.covered && `${l.detail ? " · " : ""}covered by ${l.coveredBy || "the agreement"}`}
                  </span>
                )}
              </span>
              {qtyLabel(l) && <span className="mut t-small">{qtyLabel(l)}</span>}
              <span className="mut t-small">{formatCents(l.unitCents)}</span>
              <b className="t-body" style={{ width: 90, textAlign: "right" }}>
                {l.covered ? formatCents(0) : formatCents(Math.round(l.qty * l.unitCents))}
              </b>
              {canEdit && (
                <button className="btn link t-meta" disabled={pending}
                  style={{ color: "var(--t-bad-fg)" }} onClick={() => remove(l)}>
                  remove
                </button>
              )}
            </div>
          ))}
          {/* Subtotal, what came off, and what is owed - the three rows the
              client's own copy shows. Only drawn when something came off: a
              quote with no discount says one number, as it always did. */}
          {discount && discount.cents > 0 && (
            <>
              <div className="row-2" style={{ alignItems: "baseline", padding: "9px 0 0", borderTop: "2px solid var(--line)" }}>
                <span className="sp" />
                <span className="mut t-body">Subtotal</span>
                <span className="mut t-body" style={{ width: 110, textAlign: "right" }}>
                  {formatCents(totalCents + discount.cents)}
                </span>
                {canEdit && <span style={{ width: 54 }} />}
              </div>
              <div className="row-2" style={{ alignItems: "baseline", padding: "3px 0 0" }}>
                <span className="sp" />
                <span className="t-body" style={{ color: "var(--t-good-fg)" }}>{discount.label}</span>
                <b className="t-body" style={{ width: 110, textAlign: "right", color: "var(--t-good-fg)" }}>
                  -{formatCents(discount.cents)}
                </b>
                {canEdit && <span style={{ width: 54 }} />}
              </div>
            </>
          )}
          <div className="row-2" style={{
            alignItems: "baseline", padding: "9px 0 0",
            borderTop: discount && discount.cents > 0 ? "1px solid var(--line)" : "2px solid var(--line)",
          }}>
            <span className="sp" />
            <span className="t-body" style={{ fontWeight: 700 }}>Total</span>
            <b className="t-page" style={{ width: 110, textAlign: "right" }}>{formatCents(totalCents)}</b>
            {canEdit && <span style={{ width: 54 }} />}
          </div>
        </>
      )}
      {canEdit && (
        <div style={{ marginTop: lines.length ? 10 : 0 }}>
          <div className="row-2">
            <select className="t-body" value={draft.kind} aria-label="Kind of charge"
              onChange={(e) => setDraft({ ...draft, kind: e.target.value })} style={{ width: "auto" }}>
              {MANUAL_KINDS.map((k) => <option key={k} value={k}>{KIND_LABEL[k]}</option>)}
            </select>
            {/* Both halves search the book, because both are how somebody
                arrives at a line: with the number off a shelf label, or knowing
                what the thing is called. Service codes are in the list too -
                LABOR-LCP and TZ3O are quoted off a number like anything else,
                which is why this asks for CATALOG_KINDS rather than the parts
                a purchase order may hold. */}
            <PartNumberField value={draft.partNumber} style={{ flex: "0 1 150px" }}
              placeholder="Part no." ariaLabel="Part number"
              kinds={CATALOG_KINDS} sellMarkupBps={partsMarkupBps}
              onChange={(partNumber) => setDraft({ ...draft, partNumber })}
              onPick={takePart} onEnter={add} />
            <PartNumberField value={draft.description} insert="name" className="t-body"
              placeholder="What the charge is for" ariaLabel="Line description"
              style={{ flex: "1 1 180px" }}
              kinds={CATALOG_KINDS} sellMarkupBps={partsMarkupBps}
              onChange={(description) => setDraft({ ...draft, description })}
              onPick={takePart} onEnter={add} />
            <input className="t-body" value={draft.qty} inputMode="decimal" placeholder="Qty"
              onChange={(e) => setDraft({ ...draft, qty: e.target.value })}
              aria-label="Quantity" style={{ flex: "0 1 70px" }} />
            <input className="t-body" value={draft.price} inputMode="decimal" placeholder="$ each"
              onChange={(e) => setDraft({ ...draft, price: e.target.value })}
              onKeyDown={(e) => { if (e.key === "Enter") add(); }}
              aria-label="Unit price in dollars" style={{ flex: "0 1 100px" }} />
            <button className="btn sm accent" onClick={add}
              disabled={pending || !draft.description.trim() || !draft.price.trim()}>
              {pending ? "Adding..." : "Add line"}
            </button>
          </div>
          {/* The number that is not in the book yet. Catalogued from here, in
              the form the parts catalog uses, so the estimate does not wait on
              a trip to Settings - and so the next quote finds it. */}
          <div className="row-2" style={{ marginTop: 8 }}>
            <NewPartButton
              seed={{
                partNumber: draft.partNumber,
                name: draft.description,
                kind: draft.kind === "labor" || draft.kind === "travel" ? draft.kind : "part",
                unit: draft.unit,
              }}
              onSaved={(partNumber) => setDraft((d) => ({ ...d, partNumber }))} />
            <span className="mut t-meta">
              Not in the book? Catalog it here and it is on the next quote too.
              {" "}Click a description to give it more lines.
            </span>
          </div>
          {error && <div className="t-small" style={{ color: "var(--t-bad-fg)", marginTop: 6 }}>{error}</div>}
        </div>
      )}
      </>}
    </Panel>
  );
}
