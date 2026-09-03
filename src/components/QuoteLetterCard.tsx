"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { updateQuoteLetter } from "@/app/actions";
import { formatCents } from "@/lib/money";
import { addressBlock, discountOf, greetingLine } from "@/lib/quotes";
import { Panel } from "@/components/ui";
import { toast } from "@/components/ui/Toast";

/**
 * The letter a quote is, around the table it carries.
 *
 * A quote is not a price list - it is a document addressed to a person at an
 * address, opening with a sentence that names them, closing with the shop's own
 * notes, and often with something taken off the price for a reason worth
 * stating. All five of those were hard-coded into the Excel template, which
 * meant every quote greeted every client with the same sentence and the shop
 * retyped the rest into the exported file by hand.
 *
 * Draft only, like the line editor beside it: a quote that has gone out reads
 * as sent, and rewriting the greeting or the discount behind the client is not
 * an edit anybody should be able to make quietly. Once sent, this reads back
 * what went out.
 */
export default function QuoteLetterCard({
  quoteId, editable, subtotalCents, orgName, billingAddress, letter,
}: {
  quoteId: number;
  editable: boolean;
  /** The lines before anything comes off, so the discount can be shown applied. */
  subtotalCents: number;
  orgName: string;
  /** What the client's record says, used when this quote does not say otherwise. */
  billingAddress: string;
  letter: {
    attn: string; greeting: string; clientAddress: string; note: string;
    discountPct: number; discountCents: number; discountLabel: string;
  };
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [d, setD] = useState({
    attn: letter.attn,
    greeting: letter.greeting,
    clientAddress: letter.clientAddress,
    note: letter.note,
    // Dollars on screen, cents on the wire - the boundary every price field in
    // the app crosses at the same place.
    mode: letter.discountPct > 0 ? "pct" : "flat",
    pct: letter.discountPct > 0 ? String(letter.discountPct) : "",
    flat: letter.discountCents > 0 ? (letter.discountCents / 100).toFixed(2) : "",
    discountLabel: letter.discountLabel,
  });

  const asSent = {
    discountPct: d.mode === "pct" ? Number(d.pct) || 0 : 0,
    discountCents: d.mode === "pct" ? 0 : Math.round((Number(d.flat) || 0) * 100),
  };
  const off = discountOf(subtotalCents, asSent);
  const dirty = d.attn !== letter.attn || d.greeting !== letter.greeting
    || d.clientAddress !== letter.clientAddress || d.note !== letter.note
    || d.discountLabel !== letter.discountLabel
    || asSent.discountPct !== letter.discountPct || asSent.discountCents !== letter.discountCents;

  const save = () => start(async () => {
    const res = await updateQuoteLetter(quoteId, {
      attn: d.attn, greeting: d.greeting, clientAddress: d.clientAddress, note: d.note,
      discountLabel: d.discountLabel, ...asSent,
    });
    if (res.error) { toast({ message: res.error, tone: "bad" }); return; }
    toast({ message: "Saved" });
    router.refresh();
  });

  // What the top of the document will actually say, composed the one way it is
  // composed everywhere - so this is a preview and not a second opinion.
  const greetingPreview = greetingLine({ attn: d.attn, greeting: d.greeting });
  const address = addressBlock(d.clientAddress || billingAddress);

  if (!editable) {
    return (
      <Panel title="The letter">
        <div className="t-body" style={{ fontWeight: 600, marginBottom: 8 }}>{greetingPreview}</div>
        <div className="mut t-meta">Addressed to</div>
        <div className="t-body" style={{ marginBottom: 8 }}>
          {letter.attn && <div>Attn: {letter.attn}</div>}
          <div>{orgName}</div>
          {address.map((l, i) => <div key={i}>{l}</div>)}
          {!address.length && <span className="mut">No address on file.</span>}
        </div>
        {off > 0 && (
          <div className="t-body" style={{ marginBottom: 8 }}>
            {letter.discountLabel || "Discount"}: -{formatCents(off)}
          </div>
        )}
        {letter.note && (
          <>
            <div className="mut t-meta">Comments or special instructions</div>
            <div className="t-body" style={{ whiteSpace: "pre-wrap" }}>{letter.note}</div>
          </>
        )}
      </Panel>
    );
  }

  return (
    <Panel
      title="The letter"
      hint="Everything on the quote that is not a line item."
    >
      <div className="pf2" style={{ marginBottom: 8 }}>
        <div>
          <label htmlFor="ql-attn">Addressed to</label>
          <input id="ql-attn" value={d.attn} placeholder="Hideaki Nakamura"
            onChange={(e) => setD({ ...d, attn: e.target.value })} />
          <div className="mut t-meta" style={{ marginTop: 3 }}>
            Their name opens the quote. Left blank, it opens with the house sentence.
          </div>
        </div>
        <div>
          <label htmlFor="ql-addr">Where it goes</label>
          <textarea id="ql-addr" rows={3} value={d.clientAddress} style={{ width: "100%" }}
            placeholder={billingAddress || "513 Parnassus Ave.\nSan Francisco, CA 94143"}
            onChange={(e) => setD({ ...d, clientAddress: e.target.value })} />
          <div className="mut t-meta" style={{ marginTop: 3 }}>
            {d.clientAddress.trim()
              ? "This quote only. The client's billing address is untouched."
              : billingAddress
                ? `Empty uses ${orgName}'s billing address, so it stays right when they move.`
                : `${orgName} has no billing address on file - type where this one goes.`}
          </div>
        </div>
      </div>

      <label htmlFor="ql-greeting">The line at the top</label>
      <input id="ql-greeting" value={d.greeting} placeholder={greetingPreview}
        onChange={(e) => setD({ ...d, greeting: e.target.value })} style={{ marginBottom: 3 }} />
      <div className="mut t-meta" style={{ marginBottom: 8 }}>
        {d.greeting.trim() ? "Your words, exactly." : `Reads: "${greetingPreview}"`}
      </div>

      <label>Discount</label>
      <div className="row-2" style={{ marginBottom: 3 }}>
        <div className="seg" role="group" aria-label="How the discount is given">
          <button type="button" aria-pressed={d.mode === "pct"}
            onClick={() => setD({ ...d, mode: "pct" })}>% off</button>
          <button type="button" aria-pressed={d.mode === "flat"}
            onClick={() => setD({ ...d, mode: "flat" })}>$ off</button>
        </div>
        {d.mode === "pct" ? (
          <input value={d.pct} inputMode="decimal" placeholder="10" aria-label="Percent off"
            onChange={(e) => setD({ ...d, pct: e.target.value })} style={{ flex: "0 1 90px" }} />
        ) : (
          <input value={d.flat} inputMode="decimal" placeholder="12000.00" aria-label="Amount off, dollars"
            onChange={(e) => setD({ ...d, flat: e.target.value })} style={{ flex: "0 1 120px" }} />
        )}
        <input value={d.discountLabel} placeholder="What to call it - Pooled parts allocation"
          aria-label="What the discount is called"
          onChange={(e) => setD({ ...d, discountLabel: e.target.value })} style={{ flex: "1 1 200px" }} />
      </div>
      <div className="mut t-meta" style={{ marginBottom: 8 }}>
        {off > 0
          ? `${formatCents(subtotalCents)} less ${formatCents(off)} = ${formatCents(subtotalCents - off)}.`
            + " The deposit and the invoice follow this number."
          : "Nothing off. The client pays the lines as they stand."}
      </div>

      <label htmlFor="ql-note">Comments or special instructions</label>
      <textarea id="ql-note" rows={4} value={d.note} style={{ width: "100%" }}
        placeholder={"HPLC included with the Quattro Ultima cost\nDedicated CA-based engineer"}
        onChange={(e) => setD({ ...d, note: e.target.value })} />
      <div className="mut t-meta" style={{ marginTop: 3 }}>
        One per line, printed under the table. The deposit and the expiry are added after them.
      </div>

      <div className="row-2" style={{ marginTop: 12 }}>
        <button className="btn sm accent" disabled={pending || !dirty} onClick={save}>
          {pending ? "Saving..." : "Save"}
        </button>
        {dirty && <span className="mut t-meta">Unsaved.</span>}
      </div>
    </Panel>
  );
}
