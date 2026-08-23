"use client";

import { useRouter } from "next/navigation";
import { useTransition } from "react";
import { confirmReason } from "@/components/ui/ConfirmDialog";
import { toast } from "@/components/ui/Toast";
import { removeInvoiceLine } from "@/app/actions";
import { formatCents } from "@/lib/money";
import { Panel } from "@/components/ui";

export type Line = {
  id: number; kind: string; description: string; detail: string;
  qty: number; unitCents: number; covered: boolean; coveredBy: string;
};

const KIND_LABEL: Record<string, string> = {
  part: "Part", labor: "Labor", travel: "Travel",
  expense: "Expense", tax: "Tax", fee_ref: "Charge",
};

/** Hours read as hours; a count of things reads as a count. */
const qtyLabel = (l: Line) =>
  l.kind === "labor" || l.kind === "travel"
    ? `${l.qty} h`
    : l.qty === 1 ? "" : `${l.qty}`;

/**
 * What is being charged for, and what the contract absorbed.
 *
 * A covered line keeps its real quantity and its list price and prices out at
 * zero. That is the whole argument for sending a $0 invoice: the client reads
 * what the retainer just paid for instead of receiving nothing at all.
 */
export default function InvoiceLineList({ lines, totalCents, editable }: {
  lines: Line[];
  totalCents: number;
  editable: boolean;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const coveredCents = lines
    .filter((l) => l.covered)
    .reduce((n, l) => n + Math.round(l.qty * l.unitCents), 0);

  const remove = async (l: Line) => {
    const why = await confirmReason({
      title: "Remove this line?",
      context: l.description,
      body: "Only a draft can lose a line. Once the invoice is sent, money comes off by a credit line so both facts stay on the record.",
      action: "Remove line",
      tone: "bad",
    });
    if (!why) return;
    startTransition(async () => {
      const res = await removeInvoiceLine(l.id, why);
      if (res.error) { toast({ message: res.error, tone: "bad" }); return; }
      toast({ message: "Removed the line" });
      router.refresh();
    });
  };

  return (
    <Panel
      title="Lines"
      count={lines.length}
      hint={coveredCents > 0
        ? `${formatCents(coveredCents)} of this work is covered and prices at $0 - the visit is still on the record.`
        : undefined}
      empty="Nothing on this invoice."
    >
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
              {editable && (
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
            {editable && <span style={{ width: 54 }} />}
          </div>
        </>
      )}
    </Panel>
  );
}
