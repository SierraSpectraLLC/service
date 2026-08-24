"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { confirmReason } from "@/components/ui/ConfirmDialog";
import { toast } from "@/components/ui/Toast";
import { addInvoiceLine, addQuoteLine, removeInvoiceLine, removeQuoteLine } from "@/app/actions";
import { formatCents } from "@/lib/money";
import { Panel } from "@/components/ui";

export type Line = {
  id: number; kind: string; description: string; detail: string;
  qty: number; unitCents: number; covered: boolean; coveredBy: string;
};

/** Whose lines these are, for the add and remove actions. */
export type LineTarget = { kind: "invoice" | "quote"; id: number };

const KIND_LABEL: Record<string, string> = {
  part: "Part", labor: "Labor", travel: "Travel",
  expense: "Expense", tax: "Tax", fee_ref: "Charge",
};

/** The kinds somebody may type in by hand; tax and fee rows come from the system. */
const MANUAL_KINDS = ["part", "labor", "travel", "expense"] as const;

/** Hours read as hours; a count of things reads as a count. */
const qtyLabel = (l: Line) =>
  l.kind === "labor" || l.kind === "travel"
    ? `${l.qty} h`
    : l.qty === 1 ? "" : `${l.qty}`;

const emptyDraft = { kind: "part", description: "", qty: "1", price: "" };

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
export default function InvoiceLineList({ lines, totalCents, editable, target }: {
  lines: Line[];
  totalCents: number;
  editable: boolean;
  /** Set on drafts to enable add and remove. Absent = read-only history. */
  target?: LineTarget;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [draft, setDraft] = useState(emptyDraft);
  const [error, setError] = useState("");
  const coveredCents = lines
    .filter((l) => l.covered)
    .reduce((n, l) => n + Math.round(l.qty * l.unitCents), 0);

  const canEdit = editable && target !== undefined;

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

  const add = () => {
    if (!target || !draft.description.trim()) return;
    const qty = Number(draft.qty);
    const price = Number(draft.price);
    if (!Number.isFinite(qty) || qty <= 0) { setError("Quantity must be above zero"); return; }
    if (!Number.isFinite(price) || price < 0) { setError("Give it a price - 0 is fine"); return; }
    setError("");
    startTransition(async () => {
      const res = target.kind === "invoice"
        ? await addInvoiceLine(target.id, {
            kind: draft.kind, description: draft.description,
            qty, unitCents: Math.round(price * 100),
          })
        : await addQuoteLine(target.id, {
            kind: draft.kind, description: draft.description,
            qty, unitCents: Math.round(price * 100),
          });
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
                <span className="t-body" style={{ fontWeight: 600 }}>{l.description}</span>
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
          <div className="row-2" style={{ alignItems: "baseline", padding: "9px 0 0", borderTop: "2px solid var(--line)" }}>
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
            <input className="t-body" value={draft.description} placeholder="What the charge is for"
              onChange={(e) => setDraft({ ...draft, description: e.target.value })}
              onKeyDown={(e) => { if (e.key === "Enter") add(); }}
              aria-label="Line description" style={{ flex: "1 1 180px" }} />
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
          {error && <div className="t-small" style={{ color: "var(--t-bad-fg)", marginTop: 6 }}>{error}</div>}
        </div>
      )}
      </>}
    </Panel>
  );
}
