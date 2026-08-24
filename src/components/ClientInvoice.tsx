"use client";

import { useState, useTransition } from "react";
import { startPayment } from "@/app/actions";
import { formatCents } from "@/lib/money";
import { payAmount } from "@/lib/stripe";
import { Id, Tabs } from "@/components/ui";

export type ClientLine = {
  id: number; kind: string; description: string; detail: string;
  qty: number; unitCents: number; covered: boolean; coveredBy: string;
};

/**
 * What a client sees when they open the link: this bill, and their account.
 *
 * Two tabs and nothing else. No nav, no login, no sight of anybody else's
 * money - the page was handed everything it renders by a server component
 * that looked it up through the token's own org. Payment buttons are a later
 * stage; with no keys configured there is nothing here that pretends to take
 * money, which is the honest state to ship in.
 */
export default function ClientInvoice({ brandName, orgName, apEmail, invoice, statement, pay }: {
  brandName: string;
  orgName: string;
  apEmail: string;
  /**
   * How this client may pay online, if at all. Absent keys or an unverified
   * account is a supported state, not an error: the buttons do not render and
   * the page says how to send a check, which is how most of these get paid.
   */
  pay: {
    token: string;
    enabled: boolean;
    cardsEnabled: boolean;
    cardSurchargeBps: number;
    cardSurchargeFlatCents: number;
    testMode: boolean;
    checkTo: string;
  };
  invoice: {
    id: number; number: string; issuedOn: string; dueOn: string;
    poNumber: string; note: string; lines: ClientLine[]; paidCents: number;
  };
  statement: {
    openCents: number; payableCents: number; count: number;
    open: { number: string; balanceCents: number; daysLate: number }[];
  };
}) {
  const [tab, setTab] = useState<"invoice" | "account">("invoice");
  const [pending, startTransition] = useTransition();
  const [payError, setPayError] = useState("");
  const total = invoice.lines.reduce((n, l) => n + (l.covered ? 0 : Math.round(l.qty * l.unitCents)), 0);
  const covered = invoice.lines.filter((l) => l.covered).reduce((n, l) => n + Math.round(l.qty * l.unitCents), 0);
  const due = Math.max(0, total - invoice.paidCents);
  const cardLine = payAmount({
    balanceCents: due, method: "card",
    cardSurchargeBps: pay.cardSurchargeBps,
    cardSurchargeFlatCents: pay.cardSurchargeFlatCents,
  }).line;

  const go = (method: "ach" | "card") => startTransition(async () => {
    setPayError("");
    const res = await startPayment(pay.token, invoice.id, method);
    if (res.error) { setPayError(res.error); return; }
    if (res.url) window.location.href = res.url;
  });

  return (
    <>
      <Tabs
        ariaLabel="Your billing"
        active={tab}
        onSelect={(k) => setTab(k as "invoice" | "account")}
        items={[
          { key: "invoice", label: `Invoice ${invoice.number}` },
          { key: "account", label: "Your account", count: statement.count || undefined },
        ]}
      />

      {tab === "invoice" ? (
        <div className="card">
          <div className="eyebrow">{brandName} · for {orgName}</div>
          <h2 className="t-page" style={{ margin: "2px 0 2px" }}>Invoice <Id>{invoice.number}</Id></h2>
          <div className="mut t-small" style={{ marginBottom: 10 }}>
            {invoice.issuedOn ? `issued ${invoice.issuedOn}` : ""}
            {invoice.dueOn ? ` · due ${invoice.dueOn}` : ""}
            {invoice.poNumber ? ` · PO ${invoice.poNumber}` : ""}
          </div>

          {invoice.lines.map((l) => (
            <div key={l.id} className="row-2" style={{ alignItems: "baseline", padding: "7px 0", borderTop: "1px solid var(--line)" }}>
              <span style={{ flex: 1, minWidth: 0 }}>
                <span className="t-body" style={{ fontWeight: 600 }}>{l.description}</span>
                {(l.detail || l.covered) && (
                  <span className="mut t-meta" style={{ display: "block" }}>
                    {l.detail}
                    {l.covered && `${l.detail ? " · " : ""}covered by ${l.coveredBy || "your agreement"}`}
                  </span>
                )}
              </span>
              <b className="t-body">
                {l.covered ? formatCents(0) : formatCents(Math.round(l.qty * l.unitCents))}
              </b>
            </div>
          ))}

          <div className="row-2" style={{ alignItems: "baseline", padding: "9px 0 0", borderTop: "2px solid var(--line)" }}>
            <span className="t-body" style={{ fontWeight: 700, flex: 1, minWidth: 0 }}>
              {invoice.paidCents > 0 ? "Payable now" : "Total"}
            </span>
            <b className="t-page">{formatCents(due)}</b>
          </div>

          {covered > 0 && (
            <div className="mut t-small" style={{ marginTop: 8 }}>
              {formatCents(covered)} covered by your agreement.
            </div>
          )}
          {invoice.note && <div className="t-small" style={{ marginTop: 8 }}>{invoice.note}</div>}

          {due > 0 && (
            <div style={{ marginTop: 14, paddingTop: 12, borderTop: "1px solid var(--line)" }}>
              {pay.testMode && (
                <div className="pill warn" style={{ marginBottom: 8 }}>
                  Test mode - no money moves
                </div>
              )}
              {pay.enabled ? (
                <>
                  <div className="row-2">
                    <button className="btn sm accent" disabled={pending}
                      onClick={() => go("ach")}>
                      Pay {formatCents(due)} by bank transfer
                    </button>
                    {pay.cardsEnabled && (
                      <button className="btn sm" disabled={pending} onClick={() => go("card")}>
                        Pay by card
                      </button>
                    )}
                  </div>
                  {pay.cardsEnabled && cardLine && (
                    <div className="mut t-small" style={{ marginTop: 6 }}>{cardLine}</div>
                  )}
                  <div className="mut t-meta" style={{ marginTop: 6 }}>
                    Payment is handled by Stripe.
                  </div>
                </>
              ) : (
                <div className="mut t-small">
                  {`Please send a check for ${formatCents(due)} referencing ${invoice.number}`}
                  {pay.checkTo ? `, payable to ${pay.checkTo}` : ""}.
                </div>
              )}
              {payError && <div className="t-small" style={{ color: "var(--t-bad-fg)", marginTop: 6 }}>{payError}</div>}
            </div>
          )}

          <div className="mut t-meta" style={{ marginTop: 10 }}>
            Question a line? Reply to the email this link arrived in.
          </div>
        </div>
      ) : (
        <div className="card">
          <div className="eyebrow">Your account</div>
          <h2 className="t-page" style={{ margin: "2px 0 8px" }}>
            {formatCents(statement.openCents)} open
            <span className="mut t-small" style={{ fontWeight: 400 }}>
              {" "}across {statement.count} invoice{statement.count === 1 ? "" : "s"}
            </span>
          </h2>
          {statement.open.map((v) => (
            <div key={v.number} className="row-2" style={{ alignItems: "baseline", padding: "6px 0", borderTop: "1px solid var(--line)" }}>
              <Id>{v.number}</Id>
              <span className="mut t-small" style={{ flex: 1, minWidth: 0 }}>
                {v.daysLate > 0 ? `${v.daysLate} days past due` : "inside terms"}
              </span>
              <b className="t-body">{formatCents(v.balanceCents)}</b>
            </div>
          ))}
          {statement.open.length === 0 && <div className="mut t-body">Nothing is outstanding. Thank you.</div>}
          <div className="mut t-small" style={{ marginTop: 10 }}>
            Reminders go to {apEmail || "the contact on file"}.
          </div>
        </div>
      )}
    </>
  );
}
